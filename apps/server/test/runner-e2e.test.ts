// 跨元件的端到端測試：真實的 orbis-runner 執行檔連上真實的 Server（Testcontainers Postgres），
// 驗證 Pairing、AgentAvailability 與 Heartbeat 都走通，而且 Server 的 log 看得到 Heartbeat（M0）。

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAMES } from "@orbis/api-contract";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitHubOAuth } from "../src/auth/github-oauth";
import { runners, teams } from "../src/db/schema";
import { createLogger } from "../src/logger";
import { type RunningServer, startServer } from "../src/server";
import { buildRunnerBinaries } from "./helpers/binaries";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

const runnerBinary = fileURLToPath(
  new URL(
    `../../../target/debug/${NAMES.productSlug}-runner${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

const PAIRING_TOKEN = "pt_e2e";
const RUNNER_NAME = "e2e-runner";
const HEARTBEAT_INTERVAL_MS = 200;

const unusedGitHub: GitHubOAuth = {
  authorizeUrl: () => {
    throw new Error("unused");
  },
  exchangeCode: () => Promise.reject(new Error("unused")),
  fetchUser: () => Promise.reject(new Error("unused")),
};

type LogLine = Record<string, unknown> & { msg?: string };

async function waitFor<T>(check: () => T | undefined, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待逾時：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(dbSkipReason !== null)("Runner 執行檔連上 Server（端到端）", () => {
  let database: TestDatabase;
  let server: RunningServer;
  let runner: ChildProcess | undefined;
  let runnerStderr = "";
  /** Runner 的本機目錄（Runner token、狀態），放在暫存目錄，不寫進真實的家目錄。 */
  let runnerHome = "";
  const logs: LogLine[] = [];

  beforeAll(async () => {
    // CI 中 cargo test 已先編譯過，這裡只是確保執行檔存在且是最新的。
    buildRunnerBinaries();
    expect(existsSync(runnerBinary)).toBe(true);

    runnerHome = await mkdtemp(path.join(tmpdir(), `${NAMES.productSlug}-e2e-home-`));
    database = await createTestDatabase();
    await database.db.execute(sql`truncate table teams cascade`);
    await database.db.insert(teams).values({ name: "Core" });
    server = await startServer({
      config: {
        port: 0,
        publicUrl: "http://localhost:5173",
        bootstrapOwnerGithubUserId: null,
        devPairingToken: PAIRING_TOKEN,
        runnerHeartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      },
      db: database.db,
      logger: createLogger({
        level: "debug",
        pretty: false,
        destination: { write: (line: string) => void logs.push(JSON.parse(line) as LogLine) },
      }),
      githubOAuth: unusedGitHub,
    });
  }, 600_000);

  afterAll(async () => {
    if (runner && runner.exitCode === null) {
      const exited = new Promise((resolve) => runner?.once("exit", resolve));
      runner.kill();
      await exited;
    }
    await server?.close();
    await database?.drop();
    if (runnerHome) await rm(runnerHome, { recursive: true, force: true });
  });

  it("Runner 完成 Pairing、回報 AgentAvailability，並持續送 Heartbeat", async () => {
    // 參數以陣列傳給 spawn，不經過 shell；不繼承本機 .env 的 Runner 設定，避免干擾。
    // Runner 的本機目錄指向暫存目錄（Runner token 等狀態不寫進真實的家目錄）。
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith(NAMES.envPrefix)),
      ),
      [NAMES.runnerEnv.home]: runnerHome,
    };
    runner = spawn(
      runnerBinary,
      [
        "--server",
        `http://127.0.0.1:${server.port}`,
        "--pairing-token",
        PAIRING_TOKEN,
        "--name",
        RUNNER_NAME,
      ],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    runner.stderr?.on("data", (chunk: Buffer) => {
      runnerStderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => runner?.on("exit", resolve));

    const heartbeats = () =>
      logs.filter((l) => l.event === "runner_heartbeat" && l.runnerName === RUNNER_NAME);
    try {
      await waitFor(
        () => (heartbeats().length >= 2 ? true : undefined),
        30_000,
        "Server log 出現 2 次 Heartbeat",
      );
    } catch (error) {
      const exitCode = await Promise.race([exited, Promise.resolve("still running")]);
      throw new Error(
        `${String(error)}\nRunner 狀態：${exitCode}\nRunner stderr：\n${runnerStderr}`,
      );
    }

    const [heartbeat] = heartbeats();
    expect(heartbeat?.msg).toContain(RUNNER_NAME);
    expect(heartbeat?.runnerId).toEqual(expect.any(String));

    // Runner 在第一次 Heartbeat 之前送出 AgentAvailability，Server 記錄下來
    const availabilityIndex = logs.findIndex((l) => l.event === "agent_availability");
    const firstHeartbeatIndex = logs.indexOf(heartbeat as LogLine);
    expect(availabilityIndex).toBeGreaterThanOrEqual(0);
    expect(availabilityIndex).toBeLessThan(firstHeartbeatIndex);

    const [row] = await database.db
      .select()
      .from(runners)
      .where(eq(runners.id, heartbeat?.runnerId as string));
    expect(row).toMatchObject({ name: RUNNER_NAME, kind: "team" });
    expect(row?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(server.runnerEndpoint.connectedCount()).toBe(1);
  }, 60_000);
});
