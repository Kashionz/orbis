import type { RunnerToServer, ServerToRunner } from "@orbis/protocol";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { GitHubOAuth } from "../src/auth/github-oauth";
import { sha256Hex } from "../src/crypto";
import { runners, teams } from "../src/db/schema";
import { createLogger } from "../src/logger";
import { RUNNER_WS_PATH } from "../src/runner/endpoint";
import { type RunningServer, startServer } from "../src/server";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

const DEV_PAIRING_TOKEN = "pt_dev_test";
const HEARTBEAT_INTERVAL_MS = 7000;
const RUNNER_INFO = { name: "dev-desktop", runner_version: "0.1.0", os: "windows", arch: "x86_64" };

const unusedGitHub: GitHubOAuth = {
  authorizeUrl: () => {
    throw new Error("unused");
  },
  exchangeCode: () => Promise.reject(new Error("unused")),
  fetchUser: () => Promise.reject(new Error("unused")),
};

type LogLine = Record<string, unknown> & { msg?: string; level?: number };

/** 測試用的 Runner 端：直接送協定 frame。 */
class TestRunnerClient {
  private readonly received: ServerToRunner[] = [];
  private waiters: ((frame: ServerToRunner) => void)[] = [];
  readonly closed: Promise<number>;
  readonly opened: Promise<void>;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerToRunner;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.received.push(frame);
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

  next(): Promise<ServerToRunner> {
    const frame = this.received.shift();
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.ws.close();
  }
}

function hello(
  pairing: Extract<RunnerToServer, { type: "hello" }>["pairing"],
  version = PROTOCOL_VERSION,
) {
  return { type: "hello", protocol_version: version, runner: RUNNER_INFO, pairing } as const;
}

function heartbeat(activeRunIds: string[] = []) {
  return { type: "heartbeat", ts: new Date().toISOString(), active_run_ids: activeRunIds } as const;
}

/** 等到條件成立（輪詢），逾時就失敗。 */
async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("等待逾時");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(dbSkipReason !== null)("Runner WebSocket 端點", () => {
  let database: TestDatabase;
  let server: RunningServer;
  let logs: LogLine[];
  const clients: TestRunnerClient[] = [];

  async function start(options: { devPairingToken?: string | null } = {}) {
    await server?.close();
    logs = [];
    server = await startServer({
      config: {
        port: 0,
        publicUrl: "http://localhost:5173",
        bootstrapOwner: null,
        devPairingToken:
          options.devPairingToken === undefined ? DEV_PAIRING_TOKEN : options.devPairingToken,
        runnerHeartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      },
      db: database.db,
      logger: createLogger({
        level: "debug",
        pretty: false,
        destination: { write: (line: string) => void logs.push(JSON.parse(line) as LogLine) },
      }),
      githubOAuth: unusedGitHub,
      helloTimeoutMs: 300,
    });
  }

  async function connect(): Promise<TestRunnerClient> {
    const client = new TestRunnerClient(
      new WebSocket(`ws://127.0.0.1:${server.port}${RUNNER_WS_PATH}`),
    );
    clients.push(client);
    await client.opened;
    return client;
  }

  /** 以 Pairing token 完成 Pairing，回傳 HelloAck。 */
  async function pair(client: TestRunnerClient) {
    client.send(hello({ kind: "pairing_token", token: DEV_PAIRING_TOKEN }));
    const ack = await client.next();
    if (ack.type !== "hello_ack") throw new Error(`預期 hello_ack，收到 ${ack.type}`);
    return ack;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  beforeEach(async () => {
    await database.db.execute(sql`truncate table teams cascade`);
    await database.db.insert(teams).values({ name: "Core" });
    await start();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  it("以 Pairing token 送 Hello 後收到 HelloAck，並建立只存 token 雜湊的 Runner 紀錄", async () => {
    const client = await connect();
    const ack = await pair(client);
    expect(ack).toMatchObject({
      type: "hello_ack",
      protocol_version: PROTOCOL_VERSION,
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
      resume: [],
    });
    expect(ack.runner_token).toEqual(expect.any(String));

    const [runner] = await database.db.select().from(runners).where(eq(runners.id, ack.runner_id));
    const [team] = await database.db.select().from(teams);
    expect(runner).toMatchObject({
      teamId: team?.id,
      memberId: null,
      kind: "team",
      name: RUNNER_INFO.name,
      runnerVersion: RUNNER_INFO.runner_version,
      os: RUNNER_INFO.os,
      arch: RUNNER_INFO.arch,
      tokenHash: sha256Hex(ack.runner_token ?? ""),
    });
    expect(runner?.lastConnectedAt).toBeInstanceOf(Date);
    expect(server.runnerEndpoint.connectedCount()).toBe(1);
  });

  it("協定版本不符時回 version_mismatch 並關閉連線", async () => {
    const client = await connect();
    client.send(hello({ kind: "pairing_token", token: DEV_PAIRING_TOKEN }, PROTOCOL_VERSION + 1));
    expect(await client.next()).toEqual({
      type: "hello_rejected",
      reason: "version_mismatch",
      server_protocol_version: PROTOCOL_VERSION,
      message: expect.stringContaining(String(PROTOCOL_VERSION + 1)),
    });
    expect(await client.closed).toBe(1008);
    expect(await database.db.select().from(runners)).toHaveLength(0);
  });

  it("Pairing token 錯誤時回 invalid_pairing_token", async () => {
    const client = await connect();
    client.send(hello({ kind: "pairing_token", token: "wrong" }));
    expect(await client.next()).toMatchObject({
      type: "hello_rejected",
      reason: "invalid_pairing_token",
    });
    await client.closed;
    expect(await database.db.select().from(runners)).toHaveLength(0);
  });

  it("Server 未設定開發用 Pairing token 時拒絕所有 Pairing", async () => {
    await start({ devPairingToken: null });
    const client = await connect();
    client.send(hello({ kind: "pairing_token", token: "" }));
    expect(await client.next()).toMatchObject({ reason: "invalid_pairing_token" });
  });

  it("還沒有任何 Team 時拒絕 Pairing", async () => {
    await database.db.execute(sql`truncate table teams cascade`);
    const client = await connect();
    client.send(hello({ kind: "pairing_token", token: DEV_PAIRING_TOKEN }));
    expect(await client.next()).toMatchObject({
      reason: "invalid_pairing_token",
      message: expect.stringContaining("Team"),
    });
  });

  it("第一個 frame 不是 Hello 時回 hello_expected", async () => {
    const client = await connect();
    client.send(heartbeat());
    expect(await client.next()).toMatchObject({
      type: "hello_rejected",
      reason: "hello_expected",
      server_protocol_version: PROTOCOL_VERSION,
    });
    expect(await client.closed).toBe(1008);
  });

  it("第一個訊息不是 JSON 時回 hello_expected", async () => {
    const client = await connect();
    client.ws.send("hello?");
    expect(await client.next()).toMatchObject({ reason: "hello_expected" });
  });

  it("逾時沒有送出 Hello 時回 hello_expected 並關閉連線", async () => {
    const client = await connect();
    expect(await client.next()).toMatchObject({ reason: "hello_expected" });
    expect(await client.closed).toBe(1008);
  });

  it("Heartbeat 更新 DB 的最後 Heartbeat 時間，並輸出可辨識的 Heartbeat log", async () => {
    const client = await connect();
    const ack = await pair(client);
    const before = new Date();
    client.send(heartbeat(["0192f3a0-0000-7000-8000-0000000000aa"]));

    const line = await waitFor(() => logs.find((l) => l.event === "runner_heartbeat"));
    expect(line).toMatchObject({
      runnerId: ack.runner_id,
      runnerName: RUNNER_INFO.name,
      activeRunIds: ["0192f3a0-0000-7000-8000-0000000000aa"],
    });
    expect(line.msg).toContain(RUNNER_INFO.name);
    expect(line.msg).toContain(ack.runner_id);

    const [runner] = await database.db.select().from(runners).where(eq(runners.id, ack.runner_id));
    expect(runner?.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it("其他 frame 型別記 debug log 後忽略，不會斷線", async () => {
    const client = await connect();
    const ack = await pair(client);
    client.send({ type: "agent_availability", agents: [] });
    client.ws.send("not json");
    client.send(heartbeat());

    await waitFor(() => logs.find((l) => l.event === "runner_heartbeat"));
    expect(
      logs.find((l) => l.frameType === "agent_availability" && l.runnerId === ack.runner_id),
    ).toMatchObject({ level: 20 });
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("以 Runner token 重新連線成功，並更新 Runner 資訊", async () => {
    const first = await connect();
    const ack = await pair(first);
    first.close();
    await first.closed;

    const client = await connect();
    client.send({
      ...hello({
        kind: "runner_token",
        runner_id: ack.runner_id,
        token: ack.runner_token ?? "",
      }),
      runner: { ...RUNNER_INFO, runner_version: "0.2.0" },
    });
    expect(await client.next()).toEqual({
      type: "hello_ack",
      protocol_version: PROTOCOL_VERSION,
      runner_id: ack.runner_id,
      runner_token: null,
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
      resume: [],
    });
    const [runner] = await database.db.select().from(runners).where(eq(runners.id, ack.runner_id));
    expect(runner?.runnerVersion).toBe("0.2.0");

    client.send(heartbeat());
    await waitFor(() => logs.find((l) => l.event === "runner_heartbeat"));
  });

  it("Runner token 錯誤、Runner 不存在或已撤銷時回 invalid_runner_token", async () => {
    const first = await connect();
    const ack = await pair(first);

    const cases = [
      { runner_id: ack.runner_id, token: "wrong" },
      { runner_id: "0192f3a0-0000-7000-8000-000000000000", token: ack.runner_token ?? "" },
      { runner_id: "not-a-uuid", token: ack.runner_token ?? "" },
    ];
    for (const pairing of cases) {
      const client = await connect();
      client.send(hello({ kind: "runner_token", ...pairing }));
      expect(await client.next()).toMatchObject({ reason: "invalid_runner_token" });
    }

    await database.db
      .update(runners)
      .set({ revokedAt: new Date() })
      .where(eq(runners.id, ack.runner_id));
    const revoked = await connect();
    revoked.send(
      hello({ kind: "runner_token", runner_id: ack.runner_id, token: ack.runner_token ?? "" }),
    );
    expect(await revoked.next()).toMatchObject({ reason: "invalid_runner_token" });
  });

  it("同一個 Runner 重新連上時關閉舊的連線", async () => {
    const first = await connect();
    const ack = await pair(first);
    const second = await connect();
    second.send(
      hello({ kind: "runner_token", runner_id: ack.runner_id, token: ack.runner_token ?? "" }),
    );
    expect(await second.next()).toMatchObject({ type: "hello_ack" });
    expect(await first.closed).toBe(4000);
    expect(server.runnerEndpoint.connectedCount()).toBe(1);
  });

  it("/runner 以外的路徑不接受 WebSocket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/other`);
    const error = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(error).toBeInstanceOf(Error);
  });
});
