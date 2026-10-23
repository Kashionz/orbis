// Runner 的 WebSocket 端點 `/runner`（ARCHITECTURE §6.1、ADR-0001）。
//
// 連線流程：第一個 frame 必須是 Hello → 驗證協定版本與 Pairing → 回 HelloAck（含 resume）或 HelloRejected。
// 之後依序處理 Heartbeat、AgentAvailability、Dispatch 的回覆、Event 與 RunControl 的結果。

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { HelloRejectReason, ServerToRunner } from "@orbis/protocol";
import { PROTOCOL_VERSION, RUNNER_WS_PATH } from "@orbis/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import type { Logger } from "../logger";
import type { EventIngest } from "../runs/event-ingest";
import type { RunControlService } from "../runs/run-control";
import type { UpgradeRouter } from "../ws-upgrade";
import type { Dispatcher } from "./dispatcher";
import {
  AgentAvailabilityFrame,
  type AnyFrame,
  DispatchAcceptFrame,
  DispatchRejectFrame,
  HeartbeatFrame,
  HelloFrame,
  parseFrame,
  RunControlResultFrame,
} from "./frames";
import type { RunnerHub, RunnerLink } from "./hub";
import {
  type AuthenticatedRunner,
  pairRunner,
  reconnectRunner,
  recordAgentAvailability,
  recordHeartbeat,
} from "./service";

export { RUNNER_WS_PATH };
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/** 協定違規時的 WebSocket close code（RFC 6455 Policy Violation）。 */
const CLOSE_POLICY_VIOLATION = 1008;
/** 同一個 Runner 從別處重新連上時，關閉舊連線用的 close code。 */
const CLOSE_REPLACED = 4000;

export interface RunnerEndpointOptions {
  db: Database;
  logger: Logger;
  clock: Clock;
  hub: RunnerHub;
  dispatcher: Dispatcher;
  ingest: EventIngest;
  runControls: RunControlService;
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

/** 在 upgrade router 上登記 `/runner` 的 WebSocket。 */
export function attachRunnerEndpoint(
  router: UpgradeRouter,
  options: RunnerEndpointOptions,
): RunnerEndpoint {
  const wss = new WebSocketServer({ noServer: true });
  router.register(RUNNER_WS_PATH, (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      new RunnerConnection(ws, options).start();
    });
  });

  return {
    connectedCount: () => options.hub.onlineRunnerIds().length,
    close: () =>
      new Promise((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

class RunnerConnection implements RunnerLink {
  private runner: AuthenticatedRunner | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  /** 依序處理 frame，避免 Hello 的 DB 查詢還沒完成就處理下一個 frame。 */
  private queue: Promise<void> = Promise.resolve();
  private readonly log: Logger;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: RunnerEndpointOptions,
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

  // ---- RunnerLink ----

  send(frame: ServerToRunner): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  // ---- frame 處理 ----

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const frame = isBinary ? null : parseFrame(rawToString(data));

    if (!this.runner) {
      await this.onHello(frame);
      return;
    }
    const runner = this.runner;
    if (!frame) {
      this.log.warn({ runnerId: runner.id }, "收到無法解析的訊息，忽略");
      return;
    }
    const { dispatcher } = this.options;
    switch (frame.type) {
      case "heartbeat":
        await this.onHeartbeat(runner, frame);
        return;
      case "agent_availability": {
        const parsed = AgentAvailabilityFrame.safeParse(frame);
        if (!parsed.success) return this.malformed(runner, frame);
        await recordAgentAvailability(this.options.db, runner.id, parsed.data);
        this.log.info(
          {
            event: "agent_availability",
            runnerId: runner.id,
            agents: parsed.data.agents.map((a) => a.id),
          },
          "Runner 回報 AgentAvailability",
        );
        dispatcher.availabilityChanged(runner.id);
        return;
      }
      case "dispatch_accept": {
        const parsed = DispatchAcceptFrame.safeParse(frame);
        if (!parsed.success) return this.malformed(runner, frame);
        // 改派後由這台 Runner 接手時，補送前一個 Dispatch 還沒有結果的 RunControl。
        const accepted = await dispatcher.onAccept(runner.id, parsed.data);
        if (accepted) await this.options.runControls.resend(runner.id, accepted.runId);
        return;
      }
      case "dispatch_reject": {
        const parsed = DispatchRejectFrame.safeParse(frame);
        if (!parsed.success) return this.malformed(runner, frame);
        await dispatcher.onReject(runner.id, parsed.data);
        return;
      }
      case "event": {
        const result = await this.options.ingest.ingest(runner.id, frame);
        if (result.ok) this.send({ type: "event_ack", ...result.ack });
        return;
      }
      case "run_control_result": {
        const parsed = RunControlResultFrame.safeParse(frame);
        if (!parsed.success) return this.malformed(runner, frame);
        const { type: _type, ...result } = parsed.data;
        await this.options.runControls.onResult(runner.id, result);
        return;
      }
      default:
        this.log.debug({ runnerId: runner.id, frameType: frame.type }, "忽略不認得的 Runner frame");
    }
  }

  private malformed(runner: AuthenticatedRunner, frame: AnyFrame): void {
    this.log.warn({ runnerId: runner.id, frameType: frame.type }, "frame 格式不正確，忽略");
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
    const { db, clock } = this.options;

    if (hello.pairing.kind === "pairing_token") {
      const result = await pairRunner(db, {
        token: hello.pairing.token,
        devPairingToken: this.options.devPairingToken,
        info: hello.runner,
        now: clock.now(),
      });
      if (!result.ok) {
        this.reject("invalid_pairing_token", result.message);
        return;
      }
      await this.accept(result.runner, result.runnerToken);
      this.log.info(
        {
          runnerId: result.runner.id,
          runnerName: result.runner.name,
          teamId: result.runner.teamId,
          kind: result.runner.kind,
          viaDevToken: result.viaDevToken ?? false,
        },
        result.viaDevToken
          ? "Runner 以開發用 Pairing token 完成 Pairing（僅供開發）"
          : "Runner 完成 Pairing",
      );
      return;
    }

    const result = await reconnectRunner(db, {
      runnerId: hello.pairing.runner_id,
      token: hello.pairing.token,
      info: hello.runner,
      now: clock.now(),
    });
    if (!result.ok) {
      this.reject("invalid_runner_token", "Runner token 不正確或已被撤銷，請重新 Pairing");
      return;
    }
    await this.accept(result.runner, null);
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
    const { hub, dispatcher } = this.options;
    await recordHeartbeat(this.options.db, runner.id, this.options.clock.now());
    const accepting = parsed.data.accepting_dispatches;
    const changed = hub.isAcceptingDispatches(runner.id) !== accepting;
    hub.setAcceptingDispatches(runner.id, accepting);
    if (changed && accepting) void dispatcher.kick();
    // M0 的驗收項目：在 Server log 中看得到 Runner 的 Heartbeat。
    this.log.info(
      {
        event: "runner_heartbeat",
        runnerId: runner.id,
        runnerName: runner.name,
        activeRunIds: parsed.data.active_run_ids,
        acceptingDispatches: accepting,
      },
      `Runner Heartbeat：${runner.name}（${runner.id}）`,
    );
  }

  private async accept(runner: AuthenticatedRunner, runnerToken: string | null): Promise<void> {
    const { hub, dispatcher } = this.options;
    this.runner = runner;
    // 連上就算一次 Heartbeat，避免剛連上就被判定逾時。
    await recordHeartbeat(this.options.db, runner.id, this.options.clock.now());
    const resume = await dispatcher.resumeFor(runner.id);
    if (hub.isOnline(runner.id))
      hub.disconnect(runner.id, CLOSE_REPLACED, "replaced by a new connection");
    this.send({
      type: "hello_ack",
      protocol_version: PROTOCOL_VERSION,
      runner_id: runner.id,
      runner_token: runnerToken,
      heartbeat_interval_ms: this.options.heartbeatIntervalMs,
      resume,
    });
    hub.register(runner.id, this);
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

  private onClose(code: number): void {
    this.clearHelloTimer();
    if (this.runner) {
      const wasCurrent = this.options.hub.isOnline(this.runner.id);
      this.options.hub.unregister(this.runner.id, this);
      if (wasCurrent && !this.options.hub.isOnline(this.runner.id)) {
        this.log.info(
          { runnerId: this.runner.id, runnerName: this.runner.name, code },
          "Runner 已斷線",
        );
      }
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
