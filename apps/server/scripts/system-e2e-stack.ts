// 完整系統 e2e 的啟動腳本（System E2E Stack）：一次準備好 Postgres、Server、種子資料、真實的
// Local Runner 與 Fake Agent，給 Web 的完整系統 e2e（C 軌）使用。用法見 apps/server/README.md。
//
// - 一切就緒後在 stdout 印「一行」JSON（ready 行），其他 log 一律寫到 stderr。
// - 執行到收到 SIGINT／SIGTERM，或 stdin（是 pipe 時）關閉為止；結束時停掉 Runner 與它的子程序、
//   刪除暫存目錄、停掉 Testcontainers，以 0 結束。
// - 不新增任何 HTTP 登入端點：Member 與 session 直接寫進 DB（決定 R22）。

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, fstatSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { envVar, NAMES } from "@orbis/api-contract";
import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";
import type { GitHubOAuth } from "../src/auth/github-oauth";
import { DEFAULT_PUBLIC_URL, DEFAULT_SERVER_PORT } from "../src/config";
import { randomToken, sha256Hex } from "../src/crypto";
import { createDatabase, type DatabaseHandle, runMigrations } from "../src/db/client";
import {
  agentAvailabilities,
  members,
  projects,
  repos,
  runners,
  sessions,
  teams,
} from "../src/db/schema";
import type { PullRequestOpener } from "../src/github/integration";
import { createLogger } from "../src/logger";
import { SESSION_COOKIE } from "../src/routes/auth";
import { createPairingToken } from "../src/runner/service";
import { type RunningServer, startServer } from "../src/server";
import { createServices } from "../src/services";

const execFileAsync = promisify(execFile);

/** 與 DB 測試、docker compose 相同的 Postgres 版本。 */
const POSTGRES_IMAGE = "postgres:17";
/** e2e 用的 Heartbeat 間隔（毫秒），比預設短，讓派工與逾時快一點。 */
const DEFAULT_E2E_HEARTBEAT_MS = 1000;
/** Fake Agent 執行的劇本（A 軌提供）。 */
const AGENT_PROFILE = "claude-code";
/** 等 Runner 上線並回報 Agent 可用的時間上限。 */
const RUNNER_READY_TIMEOUT_MS = 60_000;
/** 關閉 Runner 時等它自己結束的時間；逾時就連同子程序強制結束。 */
const RUNNER_STOP_TIMEOUT_MS = 10_000;

/** 種子資料的固定值（e2e 依 ready 行的欄位取用，不要寫死在 spec 中）。 */
const SEED = {
  teamName: "System E2E",
  memberLogin: "e2e-owner",
  projectName: "M1 System E2E",
  projectKey: "SYS",
  repoOwner: "e2e",
  repoName: "m1-repo",
  defaultBranch: "main",
  runnerName: "e2e-local-runner",
} as const;

/** 腳本讀取的環境變數（名稱一律由名稱常數組出）。 */
export const E2E_STACK_ENV = {
  databaseUrl: envVar("DATABASE_URL"),
  port: envVar("SERVER_PORT"),
  publicUrl: envVar("PUBLIC_URL"),
  heartbeatIntervalMs: envVar("RUNNER_HEARTBEAT_INTERVAL_MS"),
  logLevel: envVar("LOG_LEVEL"),
  runnerBin: envVar("E2E_RUNNER_BIN"),
  fakeAgentBin: envVar("E2E_FAKE_AGENT_BIN"),
  agentScript: envVar("E2E_AGENT_SCRIPT"),
} as const;

/** ready 行的內容。欄位說明見 README。 */
export interface ReadyLine {
  ready: true;
  serverUrl: string;
  webOrigin: string;
  sessionCookie: { name: string; value: string };
  teamId: string;
  memberId: string;
  projectId: string;
  projectKey: string;
  repoId: string;
  runnerId: string;
  runnerPid: number;
  bareRepoPath: string;
  checkoutPath: string;
  tempDir: string;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function resolvePath(value: string): string {
  return path.normalize(path.resolve(value));
}

// `pnpm e2e:stack -- --port 4100` 會把 `--` 原樣傳進來，先去掉。
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
const { values: args } = parseArgs({
  args: argv,
  options: {
    "runner-bin": { type: "string" },
    "fake-agent-bin": { type: "string" },
    "agent-script": { type: "string" },
    port: { type: "string" },
  },
  strict: true,
});

const env = (key: keyof typeof E2E_STACK_ENV) => {
  const value = process.env[E2E_STACK_ENV[key]]?.trim();
  return value ? value : undefined;
};

const logger = createLogger({
  level: env("logLevel") ?? "info",
  pretty: false,
  destination: pino.destination(2),
}).child({ component: "e2e-stack" });

/** 依序執行的清理工作（後註冊的先執行）。 */
const cleanups: { name: string; run: () => Promise<void> }[] = [];
const onCleanup = (name: string, run: () => Promise<void>) => cleanups.push({ name, run });

let shuttingDown: Promise<void> | null = null;
function shutdown(reason: string, code = 0): Promise<void> {
  shuttingDown ??= (async () => {
    logger.info({ reason }, "結束 e2e stack");
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup.run();
      } catch (error) {
        logger.error({ err: error, cleanup: cleanup.name }, "清理失敗");
        code = code || 1;
      }
    }
    process.exit(code);
  })();
  return shuttingDown;
}

async function git(cwd: string, gitArgs: string[]): Promise<string> {
  // 參數以陣列傳入、不經過 shell，路徑中有空白也不必自己加引號。
  const { stdout } = await execFileAsync("git", gitArgs, { cwd, windowsHide: true });
  return stdout.trim();
}

/** 本機 bare repo（Runner push 的目的地）與從它 clone 的 checkout（Runner 開 Worktree 的來源）。 */
async function createRepos(tempDir: string): Promise<{ bare: string; checkout: string }> {
  const bare = path.join(tempDir, "remote.git");
  const checkout = path.join(tempDir, "checkout");
  await mkdir(bare, { recursive: true });
  await git(bare, ["init", "--bare", `--initial-branch=${SEED.defaultBranch}`]);
  await git(tempDir, ["clone", "--", bare, checkout]);
  // Runner 在 Worktree 中 commit 時用這個 checkout 的設定（CI 機器不一定有全域的 git 身分）。
  await git(checkout, ["config", "user.name", `${NAMES.productName} E2E`]);
  await git(checkout, ["config", "user.email", "e2e@example.test"]);
  await git(checkout, ["config", "core.autocrlf", "false"]);
  // 剛 clone 的空 repo 還沒有分支；不受本機 init.defaultBranch 影響，一律用 SEED.defaultBranch。
  await git(checkout, ["symbolic-ref", "HEAD", `refs/heads/${SEED.defaultBranch}`]);
  await writeFile(
    path.join(checkout, "README.md"),
    "# M1 System E2E\n\n完整系統 e2e 用的 repo。\n",
  );
  await git(checkout, ["add", "README.md"]);
  await git(checkout, ["commit", "-m", "初始 commit：README"]);
  await git(checkout, ["push", "origin", `HEAD:refs/heads/${SEED.defaultBranch}`]);
  await git(checkout, ["branch", `--set-upstream-to=origin/${SEED.defaultBranch}`]);
  return { bare: path.normalize(bare), checkout: path.normalize(checkout) };
}

/** TOML 的 basic string（JSON 的跳脫規則是它的子集合）。 */
const tomlString = (value: string) => JSON.stringify(value);

async function connectDatabase(): Promise<DatabaseHandle> {
  let url = env("databaseUrl");
  if (!url) {
    logger.info(
      { image: POSTGRES_IMAGE },
      `沒有設定 ${E2E_STACK_ENV.databaseUrl}，以 Testcontainers 啟動 Postgres`,
    );
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    onCleanup("Postgres 容器", async () => {
      await container.stop();
    });
    url = container.getConnectionUri();
  }
  const database = createDatabase(url);
  onCleanup("資料庫連線", () => database.close());
  await runMigrations(database.db);
  logger.info("資料庫 migration 完成");
  return database;
}

/** 開 PR 時回假的網址，不連 GitHub。 */
function fakePullRequestOpener(): PullRequestOpener {
  let next = 1;
  return {
    async openPullRequest(input) {
      const url = `https://example.test/${SEED.repoOwner}/${SEED.repoName}/pull/${next++}`;
      logger.info({ ...input, url }, "開 PR（fake，不連 GitHub）");
      return { ok: true, url };
    },
  };
}

const unusedGitHubOAuth: GitHubOAuth = {
  authorizeUrl: () => {
    throw new Error("e2e stack 不支援 GitHub 登入；請使用 ready 行的 session cookie");
  },
  exchangeCode: () => Promise.reject(new Error("e2e stack 不支援 GitHub 登入")),
  fetchUser: () => Promise.reject(new Error("e2e stack 不支援 GitHub 登入")),
};

/** 結束 Runner：先關 stdin（sidecar 模式的關閉指令），逾時就連同子程序強制結束。 */
async function stopRunner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdin?.end();
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), RUNNER_STOP_TIMEOUT_MS)),
  ]);
  if (!timedOut) return;
  logger.warn({ pid: child.pid }, "Runner 沒有在時間內結束，強制結束整個程序樹");
  await killTree(child.pid);
  await exited;
}

/** 強制結束程序與它的子程序（Windows 用 taskkill /T，其他平台結束整個 process group）。 */
async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).catch(
      () => undefined,
    );
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 已經結束了。
  }
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  check: () => Promise<T | undefined>,
  failed?: () => string | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const failure = failed?.();
    if (failure) throw new Error(`${what}失敗：${failure}`);
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待${what}逾時`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main(): Promise<void> {
  const runnerBin = resolvePath(
    args["runner-bin"] ??
      env("runnerBin") ??
      path.join(repoRoot, "target", "debug", exe(`${NAMES.productSlug}-runner`)),
  );
  const fakeAgentBin = resolvePath(
    args["fake-agent-bin"] ??
      env("fakeAgentBin") ??
      path.join(repoRoot, "target", "debug", exe(`${NAMES.productSlug}-fake-agent`)),
  );
  const agentScript = resolvePath(
    args["agent-script"] ??
      env("agentScript") ??
      path.join(repoRoot, "crates", "fake-agent", "scripts", "m1.yaml"),
  );
  for (const [what, file] of [
    ["Runner 執行檔", runnerBin],
    ["Fake Agent 執行檔", fakeAgentBin],
    ["Fake Agent 劇本", agentScript],
  ] as const) {
    if (!existsSync(file)) {
      throw new Error(
        `找不到${what}：${file}。請先執行 cargo build -p ${NAMES.productSlug}-runner -p ${NAMES.productSlug}-fake-agent，或以參數指定路徑`,
      );
    }
  }
  const port = Number(args.port ?? env("port") ?? DEFAULT_SERVER_PORT);
  const publicUrl = (env("publicUrl") ?? DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
  const heartbeatIntervalMs = Number(env("heartbeatIntervalMs") ?? DEFAULT_E2E_HEARTBEAT_MS);

  const tempDir = path.normalize(
    await mkdtemp(path.join(tmpdir(), `${NAMES.productSlug}-e2e-stack-`)),
  );
  onCleanup("暫存目錄", async () => {
    // Windows 上 git 或 Runner 剛結束時檔案可能還被佔用，稍後重試。
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // ---- Postgres 與 Server ----
  const database = await connectDatabase();
  const services = createServices({
    db: database.db,
    logger,
    heartbeatIntervalMs,
    blobDir: path.join(tempDir, "blobs"),
    publicUrl,
    github: { pullRequestOpener: fakePullRequestOpener() },
  });
  const serverUrl = `http://localhost:${port}`;
  const server: RunningServer = await startServer({
    config: {
      port,
      publicUrl,
      apiOrigin: serverUrl,
      bootstrapOwnerGithubUserId: null,
      devPairingToken: null,
      runnerHeartbeatIntervalMs: heartbeatIntervalMs,
    },
    db: database.db,
    logger,
    githubOAuth: unusedGitHubOAuth,
    services,
  });
  onCleanup("Server", () => server.close());
  logger.info({ serverUrl }, "Server 已啟動");

  // ---- 種子資料 ----
  const repoPaths = await createRepos(tempDir);
  const seeded = await database.db.transaction(async (tx) => {
    const [team] = await tx.insert(teams).values({ name: SEED.teamName }).returning();
    if (!team) throw new Error("建立 Team 失敗");
    // 每次執行用不同的 GitHub user id，重複使用同一個資料庫也不會衝突。
    const githubUserId = 900_000_000 + Math.floor(Math.random() * 99_999_999);
    const [member] = await tx
      .insert(members)
      .values({ teamId: team.id, githubUserId, githubLogin: SEED.memberLogin, role: "owner" })
      .returning();
    if (!member) throw new Error("建立 Member 失敗");
    const sessionToken = randomToken();
    const [session] = await tx
      .insert(sessions)
      .values({
        tokenHash: sha256Hex(sessionToken),
        githubUserId,
        githubLogin: SEED.memberLogin,
        currentTeamId: team.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning();
    if (!session) throw new Error("建立 session 失敗");
    // manual：M1 劇本的寫檔權限請求一定會出現在 Needs You。不建立 GitHub Issue。
    const [project] = await tx
      .insert(projects)
      .values({
        teamId: team.id,
        name: SEED.projectName,
        taskKeyPrefix: SEED.projectKey,
        defaultPermissionPolicy: "manual",
        autoCreateIssues: false,
      })
      .returning();
    if (!project) throw new Error("建立 Project 失敗");
    const [repo] = await tx
      .insert(repos)
      .values({
        projectId: project.id,
        githubOwner: SEED.repoOwner,
        githubName: SEED.repoName,
        defaultBranch: SEED.defaultBranch,
      })
      .returning();
    if (!repo) throw new Error("建立 Repo 失敗");
    return { team, member, session, sessionToken, project, repo };
  });
  logger.info({ teamId: seeded.team.id, projectId: seeded.project.id }, "種子資料已建立");

  // ---- Runner ----
  const pairing = await createPairingToken(database.db, {
    teamId: seeded.team.id,
    kind: "local",
    createdByMemberId: seeded.member.id,
    createdBySessionId: seeded.session.id,
    now: new Date(),
  });
  const runnerHome = path.join(tempDir, "runner-home");
  await mkdir(runnerHome, { recursive: true });
  // Server 送出的 clone URL 是 GitHub 的網址；以 [repos."<clone URL>"] 對應到本機 checkout，
  // Runner 從這裡開 Worktree，fetch 與 push 都走它的 origin（本機 bare repo），不連網路。
  const cloneUrl = `https://github.com/${SEED.repoOwner}/${SEED.repoName}.git`;
  const runnerToml = [
    `server = ${tomlString(serverUrl)}`,
    `name = ${tomlString(SEED.runnerName)}`,
    `worktree_root = ${tomlString(path.join(tempDir, "wt"))}`,
    "",
    `[repos.${tomlString(cloneUrl)}]`,
    `path = ${tomlString(repoPaths.checkout)}`,
    "",
    `[agents.${AGENT_PROFILE}]`,
    `command = ${tomlString(fakeAgentBin)}`,
    `args = [${tomlString("--script")}, ${tomlString(agentScript)}]`,
    "",
  ].join("\n");
  await writeFile(path.join(runnerHome, NAMES.runnerConfigFile), runnerToml);

  // 不繼承本機 .env 的設定（前綴相同的環境變數），Runner 只看這裡給的值。
  const runnerEnv: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith(NAMES.envPrefix)),
    ),
    [NAMES.runnerEnv.home]: runnerHome,
  };
  const runner = spawn(
    runnerBin,
    [
      "--sidecar",
      "--server",
      serverUrl,
      "--pairing-token",
      pairing.token,
      "--name",
      SEED.runnerName,
    ],
    {
      env: runnerEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // 其他平台另開 process group，強制結束時可以連同子程序一起結束。
      detached: process.platform !== "win32",
    },
  );
  onCleanup("Runner", () => stopRunner(runner));
  let runnerExit: string | undefined;
  runner.once("exit", (code, signal) => {
    runnerExit = `Runner 結束（code=${code}, signal=${signal}）`;
    if (!shuttingDown) {
      logger.error({ code, signal }, "Runner 意外結束");
      void shutdown("Runner 意外結束", 1);
    }
  });
  // sidecar 的狀態（stdout）與 log（stderr）都轉到 stderr，stdout 只留給 ready 行。
  runner.stdout?.on("data", (chunk: Buffer) => process.stderr.write(`[runner:status] ${chunk}`));
  runner.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[runner] ${chunk}`));

  const runnerId = await waitFor(
    "Runner 完成 Pairing",
    RUNNER_READY_TIMEOUT_MS,
    async () => {
      const [row] = await database.db
        .select({ id: runners.id })
        .from(runners)
        .where(and(eq(runners.pairedSessionId, seeded.session.id), isNull(runners.revokedAt)));
      return row?.id;
    },
    () => runnerExit,
  );
  // 收到第一個 Heartbeat、accepting_dispatches 為 true 之後，Server 才會派工給它。
  await waitFor(
    "Runner 的第一個 Heartbeat",
    RUNNER_READY_TIMEOUT_MS,
    async () =>
      services.hub.isOnline(runnerId) && services.hub.isAcceptingDispatches(runnerId)
        ? true
        : undefined,
    () => runnerExit,
  );
  await waitFor(
    `Runner 回報 ${AGENT_PROFILE} 可用`,
    RUNNER_READY_TIMEOUT_MS,
    async () => {
      const rows = await database.db
        .select()
        .from(agentAvailabilities)
        .where(
          and(
            eq(agentAvailabilities.runnerId, runnerId),
            eq(agentAvailabilities.agent, AGENT_PROFILE),
          ),
        );
      return rows.some((r) => r.available) ? true : undefined;
    },
    () => runnerExit,
  );

  const ready: ReadyLine = {
    ready: true,
    serverUrl,
    webOrigin: publicUrl,
    sessionCookie: { name: SESSION_COOKIE, value: seeded.sessionToken },
    teamId: seeded.team.id,
    memberId: seeded.member.id,
    projectId: seeded.project.id,
    projectKey: seeded.project.taskKeyPrefix,
    repoId: seeded.repo.id,
    runnerId,
    runnerPid: runner.pid ?? -1,
    bareRepoPath: repoPaths.bare,
    checkoutPath: repoPaths.checkout,
    tempDir,
  };
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  logger.info("e2e stack 已就緒；按 Ctrl+C（或送 SIGTERM、關閉 stdin）結束");
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
// stdin 是 pipe 時（例如由測試或 CI 的程序管理），關閉 stdin 也代表結束。
// 是終端機、/dev/null（NUL）或一般檔案時不看 stdin：背景執行時 stdin 常是 /dev/null，會立刻讀到結尾。
// 不用 isFIFO() 判斷：Windows 的 pipe 在 Node 中 isFIFO() 是 false。
try {
  const stat = fstatSync(0);
  if (!process.stdin.isTTY && !stat.isCharacterDevice() && !stat.isFile()) {
    process.stdin.on("end", () => void shutdown("stdin 已關閉"));
    process.stdin.resume();
  }
} catch {
  // 沒有 stdin。
}

main().catch(async (error: unknown) => {
  logger.error({ err: error }, "e2e stack 啟動失敗");
  await shutdown("啟動失敗", 1);
});
