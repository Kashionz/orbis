// Web 的即時推送（WebSocket，只推 Run Event）。
//
// Client 送 `subscribe_run { runId, afterSeq }` 後，Server 先從資料庫重播 afterSeq 之後的 Event，
// 再接上即時串流。每個訂閱記住「已送出的最後 seq」，有新 Event 寫入時從那裡往後讀，
// 而且只送連續的 seq，所以重播與即時的交界不會漏送或重複。看板與 Needs You 由 Web 輪詢 REST。
//
// Event 以 `run_events { runId, events }` 批次送出：一次從資料庫讀到的連續 Event（最多
// BATCH_SIZE 筆）放在同一則訊息；即時推送時通常一則一筆。每條連線最多訂閱
// WEB_WS_MAX_SUBSCRIPTIONS 個 Run，超過時回 `limit_exceeded`。
//
// 安全：
// - upgrade 時檢查 Origin 必須是 Web 的 origin（防止跨站 WebSocket 劫持），並以 session cookie 認證。
// - 訂閱期間定期重新檢查 session 與權限：登出、被移出 Team 或 Role 改變後不會繼續收到 Event。

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  API_ROUTES,
  type RunEvent,
  WEB_WS_MAX_SUBSCRIPTIONS,
  WebClientMessage,
  type WebServerMessage,
} from "@orbis/api-contract";
import { parse as parseCookie } from "hono/utils/cookie";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { loadRunScope, requireProjectCapability } from "../authz/scope";
import { toRunEvent } from "../http/dto";
import { ApiError } from "../http/errors";
import { type Actor, resolveActor } from "../http/session";
import type { Logger } from "../logger";
import { SESSION_COOKIE } from "../routes/auth";
import type { Services } from "../services";
import type { UpgradeRouter } from "../ws-upgrade";

/** 一次從資料庫讀取的 Event 數，也是一則 `run_events` 訊息最多的 Event 數。 */
export const WEB_WS_BATCH_SIZE = 500;
/** 權限檢查結果的有效時間；過期後下一次送 Event 前重新檢查。 */
export const WEB_AUTHZ_RECHECK_MS = 30_000;
/** session 失效時關閉連線用的 close code。 */
const CLOSE_UNAUTHORIZED = 4401;

export interface WebEndpointOptions {
  /** Web 的 origin；upgrade 請求的 Origin 必須與它相同。 */
  publicUrl: string;
  /** 權限檢查結果的有效時間，預設 WEB_AUTHZ_RECHECK_MS（測試用）。 */
  authzRecheckMs?: number;
}

export interface WebEndpoint {
  connectedCount(): number;
  close(): Promise<void>;
}

export function attachWebEndpoint(
  router: UpgradeRouter,
  services: Services,
  options: WebEndpointOptions,
): WebEndpoint {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<WebConnection>();
  const allowedOrigin = new URL(options.publicUrl).origin;
  const unsubscribe = services.eventStore.onAppended((runId) => {
    for (const connection of connections) connection.onAppended(runId);
  });

  router.register(API_ROUTES.ws, (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // 瀏覽器一定會帶 Origin；沒有 Origin 的是非瀏覽器的 client，拿不到別人的 cookie。
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== allowedOrigin) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const token = parseCookie(request.headers.cookie ?? "", SESSION_COOKIE)[SESSION_COOKIE];
    resolveActor(services.db, services.clock, token).then(
      (actor) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
          const connection = new WebConnection(
            ws,
            actor,
            token,
            services,
            options.authzRecheckMs ?? WEB_AUTHZ_RECHECK_MS,
          );
          connections.add(connection);
          ws.on("close", () => connections.delete(connection));
        });
      },
      (error: unknown) => {
        const status = error instanceof ApiError ? error.status : 500;
        const text = { 401: "Unauthorized", 403: "Forbidden" }[status as 401 | 403];
        socket.end(`HTTP/1.1 ${status} ${text ?? "Internal Server Error"}\r\n\r\n`);
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
  /** 權限檢查結果的有效期限（epoch ms）。 */
  authorizedUntil: number;
}

class WebConnection {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly log: Logger;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ws: WebSocket,
    private actor: Actor,
    private readonly sessionToken: string | undefined,
    private readonly services: Services,
    private readonly authzRecheckMs: number,
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
    if (!subscription) return;
    // 推送失敗（例如資料庫暫時出錯）只記 log：下一筆 Event 寫入或重新訂閱時會從 lastSentSeq 補送。
    this.catchUp(subscription).catch((error: unknown) =>
      this.log.error({ err: error, runId }, "推送 Run Event 時發生錯誤"),
    );
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
    if (
      !this.subscriptions.has(message.runId) &&
      this.subscriptions.size >= WEB_WS_MAX_SUBSCRIPTIONS
    ) {
      this.send({
        type: "error",
        code: "limit_exceeded",
        message: `同時最多訂閱 ${WEB_WS_MAX_SUBSCRIPTIONS} 個 Run`,
        runId: message.runId,
      });
      return;
    }
    const subscription: Subscription = {
      runId: message.runId,
      lastSentSeq: message.afterSeq,
      running: false,
      dirty: false,
      authorizedUntil: 0,
    };
    if (!(await this.authorize(subscription))) return;
    this.subscriptions.set(message.runId, subscription);
    await this.catchUp(subscription);
  }

  /**
   * 重新檢查 session 與「可以查看這個 Run」的權限。session 失效時關閉連線；
   * 沒有權限時送出錯誤並取消訂閱。
   */
  private async authorize(subscription: Subscription): Promise<boolean> {
    const { db, clock } = this.services;
    try {
      this.actor = await resolveActor(db, clock, this.sessionToken);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      this.subscriptions.clear();
      this.ws.close(CLOSE_UNAUTHORIZED, "session expired");
      return false;
    }
    try {
      const scope = await loadRunScope(db, this.actor, subscription.runId);
      requireProjectCapability(this.actor, scope, "view");
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      this.subscriptions.delete(subscription.runId);
      this.send({
        type: "error",
        code: error.status === 403 ? "forbidden" : "not_found",
        message: error.message,
        runId: subscription.runId,
      });
      return false;
    }
    subscription.authorizedUntil = Date.now() + this.authzRecheckMs;
    return true;
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
          if (Date.now() >= subscription.authorizedUntil && !(await this.authorize(subscription))) {
            return;
          }
          const rows = await this.services.eventStore.list(
            subscription.runId,
            subscription.lastSentSeq,
            WEB_WS_BATCH_SIZE,
          );
          const events: RunEvent[] = [];
          for (const row of rows) {
            if (row.seq !== subscription.lastSentSeq + events.length + 1) break;
            events.push(toRunEvent(row));
          }
          if (events.length > 0) {
            this.send({ type: "run_events", runId: subscription.runId, events });
            subscription.lastSentSeq += events.length;
          }
          if (events.length < WEB_WS_BATCH_SIZE) break;
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
