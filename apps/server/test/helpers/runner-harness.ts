// 模擬 Runner 的測試 harness：真實的 Server（HTTP 與 WebSocket）＋直接使用協定型別的 Runner client。

import type { RunnerKind } from "@orbis/api-contract";
import type { AgentAvailability, EventKind, RunnerToServer, ServerToRunner } from "@orbis/protocol";
import { PROTOCOL_VERSION, RUNNER_WS_PATH } from "@orbis/protocol";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";
import type { Database } from "../../src/db/client";
import { agentAvailabilities } from "../../src/db/schema";
import { type RunningServer, startServer } from "../../src/server";
import { client, createTestContext, type SeededMember, type TestContext } from "./api";

export const HEARTBEAT_INTERVAL_MS = 1000;
export const OFFER_TIMEOUT_MS = 5000;

type FrameOf<T extends ServerToRunner["type"]> = Extract<ServerToRunner, { type: T }>;

/** 直接送協定 frame 的 Runner client。收到的 frame 依序排隊，可以依種類等待。 */
export class MockRunner {
  readonly received: ServerToRunner[] = [];
  private waiters: {
    match: (f: ServerToRunner) => boolean;
    resolve: (f: ServerToRunner) => void;
  }[] = [];
  readonly closed: Promise<number>;
  readonly opened: Promise<void>;
  runnerId = "";
  runnerToken = "";
  private seq = new Map<string, number>();

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerToRunner;
      const index = this.waiters.findIndex((w) => w.match(frame));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(frame);
      } else {
        this.received.push(frame);
      }
    });
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
    this.opened = new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  }

  send(frame: RunnerToServer | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** 等待下一個符合條件的 frame（已收到但還沒取走的也算）。 */
  next<T extends ServerToRunner["type"]>(
    type: T,
    predicate: (frame: FrameOf<T>) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<FrameOf<T>> {
    const match = (f: ServerToRunner) => f.type === type && predicate(f as FrameOf<T>);
    const index = this.received.findIndex(match);
    if (index >= 0) {
      const [frame] = this.received.splice(index, 1);
      return Promise.resolve(frame as FrameOf<T>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`等待 ${type} 逾時；已收到：${JSON.stringify(this.received)}`));
      }, timeoutMs);
      const done = (f: ServerToRunner) => {
        clearTimeout(timer);
        resolve(f as FrameOf<T>);
      };
      this.waiters.push({ match, resolve: done });
    });
  }

  /** 目前還沒取走的某種 frame。 */
  pending<T extends ServerToRunner["type"]>(type: T): FrameOf<T>[] {
    return this.received.filter((f) => f.type === type) as FrameOf<T>[];
  }

  hello(pairing: Extract<RunnerToServer, { type: "hello" }>["pairing"]): void {
    this.send({
      type: "hello",
      protocol_version: PROTOCOL_VERSION,
      runner: { name: "mock-runner", runner_version: "0.1.0", os: "windows", arch: "x86_64" },
      pairing,
    });
  }

  heartbeat(extra: Record<string, unknown> = {}): void {
    this.send({ type: "heartbeat", ts: new Date().toISOString(), active_run_ids: [], ...extra });
  }

  availability(agents: { id: string; available?: boolean }[] = [{ id: "claude-code" }]): void {
    const frame: AgentAvailability = {
      agents: agents.map((a) => ({
        id: a.id,
        version: "1.0.0",
        available: a.available ?? true,
        unavailable_reason: a.available === false ? "未登入" : null,
        capabilities: ["load_session"],
        models: [],
        permission_gaps: [],
        credential: "default",
      })),
      credentials: [{ label: "default", max_concurrent_runs: 30, active_runs: 0 }],
    };
    this.send({ type: "agent_availability", ...frame });
  }

  /** 送出一筆 Event；seq 未指定時自動遞增。回傳使用的 seq。 */
  event(dispatchId: string, runId: string, kind: EventKind, seq?: number): number {
    const next = seq ?? (this.seq.get(runId) ?? 0) + 1;
    this.seq.set(runId, Math.max(next, this.seq.get(runId) ?? 0));
    this.send({
      type: "event",
      dispatch_id: dispatchId,
      run_id: runId,
      seq: next,
      ts: new Date().toISOString(),
      ...kind,
    });
    return next;
  }

  /** 送出 Event 並等到對應的 event_ack。 */
  async eventAcked(dispatchId: string, runId: string, kind: EventKind, seq?: number) {
    const used = this.event(dispatchId, runId, kind, seq);
    return this.next("event_ack", (a) => a.run_id === runId && a.seq >= used);
  }

  setSeq(runId: string, seq: number): void {
    this.seq.set(runId, seq);
  }

  close(): void {
    this.ws.close();
  }
}

export interface Harness {
  ctx: TestContext;
  server: RunningServer;
  /** 開一條新的 Runner 連線（還沒送 Hello）。 */
  connect(): Promise<MockRunner>;
  /** 以某位 Member 取得 Pairing token 並完成 Pairing、回報 AgentAvailability、送一次 Heartbeat。 */
  pairRunner(
    member: SeededMember,
    kind: RunnerKind,
    agents?: { id: string; available?: boolean }[],
  ): Promise<MockRunner>;
  /** 以 Runner token 重新連線。 */
  reconnect(previous: MockRunner): Promise<MockRunner>;
  close(): Promise<void>;
}

export async function startHarness(db: Database): Promise<Harness> {
  const ctx = createTestContext(db, {
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    offerTimeoutMs: OFFER_TIMEOUT_MS,
  });
  const server = await startServer({
    config: {
      port: 0,
      publicUrl: "http://localhost:5173",
      bootstrapOwnerGithubUserId: null,
      devPairingToken: null,
      runnerHeartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    },
    db,
    logger: ctx.logger,
    githubOAuth: {
      authorizeUrl: () => "",
      exchangeCode: () => Promise.reject(new Error("unused")),
      fetchUser: () => Promise.reject(new Error("unused")),
    },
    services: ctx.services,
    helloTimeoutMs: 2000,
    dispatcherIntervalMs: 0,
  });
  const runners: MockRunner[] = [];
  let closed = false;

  async function connect(): Promise<MockRunner> {
    const runner = new MockRunner(new WebSocket(`ws://127.0.0.1:${server.port}${RUNNER_WS_PATH}`));
    runners.push(runner);
    await runner.opened;
    return runner;
  }

  async function finishHello(runner: MockRunner, agents?: { id: string; available?: boolean }[]) {
    const ack = await runner.next("hello_ack");
    runner.runnerId = ack.runner_id;
    if (ack.runner_token) runner.runnerToken = ack.runner_token;
    const expected = agents ?? [{ id: "claude-code" }];
    runner.availability(expected);
    runner.heartbeat();
    // 等 Server 記錄完 AgentAvailability（同一條連線的 frame 依序處理）。
    await waitUntil(
      async () => {
        const rows = await db
          .select()
          .from(agentAvailabilities)
          .where(eq(agentAvailabilities.runnerId, ack.runner_id));
        return rows.length === new Set(expected.map((a) => a.id)).size;
      },
      5000,
      "AgentAvailability 寫入",
    );
    await ctx.services.dispatcher.idle();
    return ack;
  }

  return {
    ctx,
    server,
    connect,
    async pairRunner(member, kind, agents) {
      const res = await client(ctx.app, member.cookie).post<{ token: string }>(
        "/api/runner-pairing-tokens",
        { kind },
      );
      if (res.status !== 201) throw new Error(`取得 Pairing token 失敗：${res.status}`);
      const runner = await connect();
      runner.hello({ kind: "pairing_token", token: res.body.token });
      await finishHello(runner, agents);
      await waitUntil(() => ctx.services.hub.isOnline(runner.runnerId));
      return runner;
    },
    async reconnect(previous) {
      const runner = await connect();
      runner.runnerToken = previous.runnerToken;
      runner.hello({
        kind: "runner_token",
        runner_id: previous.runnerId,
        token: previous.runnerToken,
      });
      await finishHello(runner);
      await waitUntil(() => ctx.services.hub.isOnline(runner.runnerId));
      return runner;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const runner of runners) runner.close();
      await server.close();
    },
  };
}

/** 輪詢直到條件成立，逾時就失敗。 */
export async function waitUntil<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 5000,
  what = "條件成立",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`等待逾時：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
