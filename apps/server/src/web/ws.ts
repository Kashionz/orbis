// Web 的即時推送（WebSocket，只推 Run Event）。
//
// Client 送 `subscribe_run { runId, afterSeq }` 後，Server 先從資料庫重播 afterSeq 之後的 Event，
// 再接上即時串流。每個訂閱記住「已送出的最後 seq」，有新 Event 寫入時從那裡往後讀，
// 而且只送連續的 seq，所以重播與即時的交界不會漏送或重複。看板與 Needs You 由 Web 輪詢 REST。

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parse as parseCookie } from "hono/utils/cookie";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { loadRunScope, requireProjectCapability } from "../authz/scope";
import { WEB_WS_PATH, WebClientMessage, type WebServerMessage } from "../contract-pending";
import { toRunEvent } from "../http/dto";
import { ApiError } from "../http/errors";
import { type Actor, resolveActor } from "../http/session";
import type { Logger } from "../logger";
import { SESSION_COOKIE } from "../routes/auth";
import type { Services } from "../services";
import type { UpgradeRouter } from "../ws-upgrade";

/** 一次從資料庫讀取的 Event 數。 */
const BATCH_SIZE = 500;
/** 一條連線最多同時訂閱的 Run 數。 */
const MAX_SUBSCRIPTIONS = 50;

export interface WebEndpoint {
  connectedCount(): number;
  close(): Promise<void>;
}

export function attachWebEndpoint(router: UpgradeRouter, services: Services): WebEndpoint {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<WebConnection>();
  const unsubscribe = services.eventStore.onAppended((runId) => {
    for (const connection of connections) connection.onAppended(runId);
  });

  router.register(WEB_WS_PATH, (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const token = parseCookie(request.headers.cookie ?? "", SESSION_COOKIE)[SESSION_COOKIE];
    resolveActor(services.db, services.clock, token).then(
      (actor) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
          const connection = new WebConnection(ws, actor, services);
          connections.add(connection);
          ws.on("close", () => connections.delete(connection));
        });
      },
      (error: unknown) => {
        const status = error instanceof ApiError ? error.status : 500;
        socket.end(
          `HTTP/1.1 ${status} ${status === 500 ? "Internal Server Error" : "Unauthorized"}\r\n\r\n`,
        );
      },
    );
  });

  return {
    connectedCount: () => connections.size,
    close: () =>
      new Promise((resolve) => {
        unsubscribe();
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

interface Subscription {
  runId: string;
  lastSentSeq: number;
  running: boolean;
  /** 傳送途中又有新 Event，送完要再讀一次。 */
  dirty: boolean;
}

class WebConnection {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly log: Logger;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ws: WebSocket,
    private readonly actor: Actor,
    private readonly services: Services,
  ) {
    this.log = services.logger.child({ component: "web-ws", memberId: actor.memberId });
    ws.on("message", (data, isBinary) => {
      this.queue = this.queue
        .then(() => this.onMessage(data, isBinary))
        .catch((error: unknown) => this.log.error({ err: error }, "處理 Web 訊息時發生錯誤"));
    });
    ws.on("error", (error) => this.log.warn({ err: error }, "Web WebSocket 錯誤"));
  }

  onAppended(runId: string): void {
    const subscription = this.subscriptions.get(runId);
    if (subscription) void this.catchUp(subscription);
  }

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    let json: unknown = null;
    if (!isBinary) {
      try {
        json = JSON.parse(data.toString());
      } catch {
        json = null;
      }
    }
    const parsed = WebClientMessage.safeParse(json);
    if (!parsed.success) {
      this.send({ type: "error", code: "invalid_message", message: "訊息格式不正確", runId: null });
      return;
    }
    const message = parsed.data;
    if (message.type === "unsubscribe_run") {
      this.subscriptions.delete(message.runId);
      return;
    }

    try {
      const scope = await loadRunScope(this.services.db, this.actor, message.runId);
      requireProjectCapability(this.actor, scope, "view");
    } catch (error) {
      if (error instanceof ApiError) {
        this.send({
          type: "error",
          code: error.status === 403 ? "forbidden" : "not_found",
          message: error.message,
          runId: message.runId,
        });
        return;
      }
      throw error;
    }
    if (!this.subscriptions.has(message.runId) && this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      this.send({
        type: "error",
        code: "invalid_message",
        message: `同時最多訂閱 ${MAX_SUBSCRIPTIONS} 個 Run`,
        runId: message.runId,
      });
      return;
    }
    const subscription: Subscription = {
      runId: message.runId,
      lastSentSeq: message.afterSeq,
      running: false,
      dirty: false,
    };
    this.subscriptions.set(message.runId, subscription);
    await this.catchUp(subscription);
  }

  /** 從 lastSentSeq 往後送出連續的 Event，直到遇到缺號或沒有更多 Event。 */
  private async catchUp(subscription: Subscription): Promise<void> {
    if (subscription.running) {
      subscription.dirty = true;
      return;
    }
    subscription.running = true;
    try {
      do {
        subscription.dirty = false;
        for (;;) {
          if (this.subscriptions.get(subscription.runId) !== subscription) return;
          const rows = await this.services.eventStore.list(
            subscription.runId,
            subscription.lastSentSeq,
            BATCH_SIZE,
          );
          let sent = 0;
          for (const row of rows) {
            if (row.seq !== subscription.lastSentSeq + 1) break;
            this.send({ type: "run_event", event: toRunEvent(row) });
            subscription.lastSentSeq = row.seq;
            sent++;
          }
          if (sent < BATCH_SIZE) break;
        }
      } while (subscription.dirty);
    } finally {
      subscription.running = false;
    }
  }

  private send(message: WebServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
}
