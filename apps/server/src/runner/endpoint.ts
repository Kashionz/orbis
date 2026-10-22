// Runner 的 WebSocket 端點 `/runner`（ARCHITECTURE §6.1、ADR-0001）。
//
// 連線流程：第一個 frame 必須是 Hello → 驗證協定版本與 Pairing → 回 HelloAck 或 HelloRejected。
// 之後處理 Heartbeat；其他 frame 型別先記 debug log 後忽略，不斷線。

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { HelloRejectReason, ServerToRunner } from "@orbis/protocol";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { Database } from "../db/client";
import type { Logger } from "../logger";
import { type AnyFrame, HeartbeatFrame, HelloFrame, parseFrame } from "./frames";
import { type AuthenticatedRunner, pairRunner, reconnectRunner, recordHeartbeat } from "./service";

export const RUNNER_WS_PATH = "/runner";
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/** 協定違規時的 WebSocket close code（RFC 6455 Policy Violation）。 */
const CLOSE_POLICY_VIOLATION = 1008;
/** 同一個 Runner 從別處重新連上時，關閉舊連線用的 close code。 */
const CLOSE_REPLACED = 4000;

export interface RunnerEndpointOptions {
  db: Database;
  logger: Logger;
  devPairingToken: string | null;
  heartbeatIntervalMs: number;
  /** 連線後等待 Hello 的時間。 */
  helloTimeoutMs?: number;
}

export interface RunnerEndpoint {
  /** 目前已完成 Hello 的連線數。 */
  connectedCount(): number;
  close(): Promise<void>;
}

/** 在 HTTP server 上掛載 `/runner` 的 WebSocket upgrade。 */
export function attachRunnerEndpoint(
  server: Server,
  options: RunnerEndpointOptions,
): RunnerEndpoint {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Map<string, RunnerConnection>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== RUNNER_WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      new RunnerConnection(ws, options, connections).start();
    });
  };
  server.on("upgrade", onUpgrade);

  return {
    connectedCount: () => connections.size,
    close: () =>
      new Promise((resolve) => {
        server.off("upgrade", onUpgrade);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

class RunnerConnection {
  private runner: AuthenticatedRunner | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  /** 依序處理 frame，避免 Hello 的 DB 查詢還沒完成就處理下一個 frame。 */
  private queue: Promise<void> = Promise.resolve();
  private readonly log: Logger;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: RunnerEndpointOptions,
    private readonly connections: Map<string, RunnerConnection>,
  ) {
    this.log = options.logger.child({ component: "runner-ws" });
  }

  start(): void {
    this.helloTimer = setTimeout(() => {
      this.reject("hello_expected", "連線後沒有在時限內送出 Hello");
    }, this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);

    this.ws.on("message", (data, isBinary) => {
      this.queue = this.queue
        .then(() => this.onMessage(data, isBinary))
        .catch((error: unknown) => {
          this.log.error({ err: error, runnerId: this.runner?.id }, "處理 Runner frame 時發生錯誤");
        });
    });
    this.ws.on("close", (code) => this.onClose(code));
    this.ws.on("error", (error) => {
      this.log.warn({ err: error, runnerId: this.runner?.id }, "Runner WebSocket 錯誤");
    });
  }

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const frame = isBinary ? null : parseFrame(rawToString(data));

    if (!this.runner) {
      await this.onHello(frame);
      return;
    }
    if (!frame) {
      this.log.warn({ runnerId: this.runner.id }, "收到無法解析的訊息，忽略");
      return;
    }
    switch (frame.type) {
      case "heartbeat":
        await this.onHeartbeat(this.runner, frame);
        return;
      default:
        this.log.debug(
          { runnerId: this.runner.id, frameType: frame.type },
          "忽略尚未支援的 Runner frame",
        );
    }
  }

  private async onHello(frame: AnyFrame | null): Promise<void> {
    this.clearHelloTimer();
    if (frame?.type !== "hello") {
      this.reject("hello_expected", "連線後的第一個 frame 必須是 Hello");
      return;
    }
    // 先只看版本：不同版本的 Hello 形狀可能不同，不能先用目前的 schema 驗證。
    if (frame.protocol_version !== PROTOCOL_VERSION) {
      this.reject(
        "version_mismatch",
        `Runner 協定版本 ${String(frame.protocol_version)} 與 Server 的 ${PROTOCOL_VERSION} 不相容，請更新 Runner`,
      );
      return;
    }
    const parsed = HelloFrame.safeParse(frame);
    if (!parsed.success) {
      this.reject("hello_expected", "Hello 的格式不正確");
      return;
    }
    const hello = parsed.data;
    const { db } = this.options;

    if (hello.pairing.kind === "pairing_token") {
      const result = await pairRunner(db, {
        token: hello.pairing.token,
        devPairingToken: this.options.devPairingToken,
        info: hello.runner,
      });
      if (!result.ok) {
        this.reject("invalid_pairing_token", result.message);
        return;
      }
      this.accept(result.runner, result.runnerToken);
      this.log.info(
        {
          runnerId: result.runner.id,
          runnerName: result.runner.name,
          teamId: result.runner.teamId,
        },
        "Runner 完成 Pairing",
      );
      return;
    }

    const result = await reconnectRunner(db, {
      runnerId: hello.pairing.runner_id,
      token: hello.pairing.token,
      info: hello.runner,
    });
    if (!result.ok) {
      this.reject("invalid_runner_token", "Runner token 不正確或已被撤銷，請重新 Pairing");
      return;
    }
    this.accept(result.runner, null);
    this.log.info(
      { runnerId: result.runner.id, runnerName: result.runner.name },
      "Runner 以 Runner token 重新連線",
    );
  }

  private async onHeartbeat(runner: AuthenticatedRunner, frame: AnyFrame): Promise<void> {
    const parsed = HeartbeatFrame.safeParse(frame);
    if (!parsed.success) {
      this.log.warn({ runnerId: runner.id }, "Heartbeat 的格式不正確，忽略");
      return;
    }
    await recordHeartbeat(this.options.db, runner.id, new Date());
    // M0 的驗收項目：在 Server log 中看得到 Runner 的 Heartbeat。
    this.log.info(
      {
        event: "runner_heartbeat",
        runnerId: runner.id,
        runnerName: runner.name,
        activeRunIds: parsed.data.active_run_ids,
      },
      `Runner Heartbeat：${runner.name}（${runner.id}）`,
    );
  }

  private accept(runner: AuthenticatedRunner, runnerToken: string | null): void {
    this.runner = runner;
    const previous = this.connections.get(runner.id);
    if (previous && previous !== this) {
      previous.ws.close(CLOSE_REPLACED, "replaced by a new connection");
    }
    this.connections.set(runner.id, this);
    this.send({
      type: "hello_ack",
      protocol_version: PROTOCOL_VERSION,
      runner_id: runner.id,
      runner_token: runnerToken,
      heartbeat_interval_ms: this.options.heartbeatIntervalMs,
      // TODO(B1)：帶入每個進行中 Run 已收到的最後 seq。
      resume: [],
    });
  }

  private reject(reason: HelloRejectReason, message: string): void {
    this.clearHelloTimer();
    this.log.warn({ reason }, `拒絕 Runner 連線：${message}`);
    this.send({
      type: "hello_rejected",
      reason,
      server_protocol_version: PROTOCOL_VERSION,
      message,
    });
    this.ws.close(CLOSE_POLICY_VIOLATION, reason);
  }

  private send(frame: ServerToRunner): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private onClose(code: number): void {
    this.clearHelloTimer();
    if (this.runner && this.connections.get(this.runner.id) === this) {
      this.connections.delete(this.runner.id);
      this.log.info(
        { runnerId: this.runner.id, runnerName: this.runner.name, code },
        "Runner 已斷線",
      );
    }
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
