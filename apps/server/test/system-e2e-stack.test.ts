// 完整系統 e2e 的啟動腳本（scripts/system-e2e-stack.ts）：以子程序執行，確認 ready 行、
// 以 session cookie 呼叫 API、Runner 在線，並以真實的 Runner＋Fake Agent 走一次 M1 劇本
// （push 回本機 bare repo → 以 App 開 PR → merged webhook → Task Done），最後確認關閉後
// 沒有殘留的子程序與暫存目錄。另外測試 `--runner-config-out`（不啟動 Runner）模式。
//
// 腳本與其他 DB 測試共用同一個測試用的 Postgres（global-setup 提供：TEST_DATABASE_URL 或
// Testcontainers），以 TEST_DATABASE_URL 傳給腳本，由腳本建立自己的 database、結束時刪除。
// 另外在環境中放一個指向「哨兵 database」的 DATABASE_URL，確認腳本不會使用開發 DB。

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ROUTES,
  apiPath,
  envVar,
  NAMES,
  type NeedsYouListResponse,
  type Run,
  type Runner,
  type Task,
} from "@orbis/api-contract";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  descendants,
  parseReadyLine,
  type ReadyLine,
  StackCommander,
  sendPullRequestMergedWebhook,
} from "../e2e";
import { createScratchDatabase, type ScratchDatabase } from "../src/db/test-database";
import { buildRunnerBinaries } from "./helpers/binaries";
import { dbSkipReason } from "./helpers/db";

const skipStack = dbSkipReason !== null;
if (skipStack) console.warn(`[e2e-stack] 略過：${dbSkipReason}`);

/** 假裝是開發 DB 的 database：腳本不可以在裡面建立任何東西。 */
let sentinel: ScratchDatabase | undefined;

async function sentinelDatabase(): Promise<ScratchDatabase> {
  const adminUrl = inject("postgresAdminUrl");
  if (!adminUrl) throw new Error("沒有可用的測試 Postgres");
  sentinel ??= await createScratchDatabase(adminUrl, "sentinel");
  return sentinel;
}

async function query<T extends pg.QueryResultRow>(
  url: string,
  sql: string,
  params: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const databaseName = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));

const serverDir = fileURLToPath(new URL("..", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

interface StartedStack {
  child: ChildProcess;
  ready: ReadyLine;
  stderr: () => string;
  /** 結束 stack（Windows 的 kill() 不會觸發 SIGTERM 的處理，改用關閉 stdin），回傳結束碼。 */
  stop: () => Promise<number | null>;
}

/** 以子程序執行 stack，等到 ready 行。 */
async function startStack(extraArgs: string[] = []): Promise<StartedStack> {
  // 不繼承本機 .env 的設定（前綴相同的環境變數），只傳需要的。
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith(NAMES.envPrefix)),
    ),
    [envVar("SERVER_PORT")]: String(await freePort()),
    [envVar("TEST_DATABASE_URL")]: inject("postgresAdminUrl") ?? "",
    [envVar("DATABASE_URL")]: (await sentinelDatabase()).url,
  };
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/system-e2e-stack.ts", ...extraArgs],
    { cwd: serverDir, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let stdout = "";
  const ready = await new Promise<ReadyLine>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline >= 0) resolve(parseReadyLine(stdout.slice(0, newline)));
    });
    child.once("exit", (code) =>
      reject(new Error(`腳本提早結束（${code}）\n${stderr.slice(-4000)}`)),
    );
  });
  return {
    child,
    ready,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null) return child.exitCode;
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      if (process.platform === "win32") child.stdin?.end();
      else child.kill("SIGTERM");
      return exited;
    },
  };
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(skipStack)("完整系統 e2e 的啟動腳本", () => {
  let started: StartedStack;
  let stack: ChildProcess;
  let ready: ReadyLine;
  const stderr = () => started?.stderr() ?? "";

  const api = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${ready.serverUrl}${path}`, {
      method,
      headers: {
        cookie: `${ready.sessionCookie.name}=${ready.sessionCookie.value}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };

  const until = async <T>(what: string, check: () => Promise<T | undefined | false>) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`等待${what}逾時\n${stderr().slice(-4000)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    buildRunnerBinaries();
    started = await startStack();
    stack = started.child;
    ready = started.ready;
  }, 600_000);

  afterAll(async () => {
    if (stack && stack.exitCode === null) stack.kill("SIGKILL");
    await sentinel?.drop();
    sentinel = undefined;
  });

  it("stdout 只有一行 ready JSON，欄位齊全", () => {
    expect(ready).toMatchObject({
      ready: true,
      serverUrl: expect.stringMatching(/^http:\/\/localhost:\d+$/),
      sessionCookie: { name: `${NAMES.productSlug}_session`, value: expect.any(String) },
      projectKey: expect.stringMatching(/^[A-Z][A-Z0-9]+$/),
      runnerPid: expect.any(Number),
    });
    for (const key of ["teamId", "memberId", "projectId", "repoId", "runnerId"] as const) {
      expect(ready[key]).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(existsSync(ready.bareRepoPath)).toBe(true);
    expect(existsSync(ready.checkoutPath)).toBe(true);
    expect(ready.runnerConfigPath).toBe(path.join(ready.runnerHome, NAMES.runnerConfigFile));
    expect(ready.github).toMatchObject({
      webhookUrl: `${ready.serverUrl}${API_ROUTES.githubWebhook}`,
      webhookSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
      repo: {
        owner: expect.any(String),
        name: expect.any(String),
        id: expect.any(Number),
        installationId: expect.any(Number),
      },
    });
    expect(ready.databaseUrl).toMatch(/^postgres(ql)?:\/\//);
  });

  it("不使用開發 DB：在測試用的 Postgres 上另建 database，DATABASE_URL 指向的 database 沒有被寫入", async () => {
    const dev = await sentinelDatabase();
    expect(databaseName(ready.databaseUrl)).toMatch(/^e2e_[0-9a-f]{12}$/);
    expect(databaseName(ready.databaseUrl)).not.toBe(dev.name);
    const tables = await query(
      dev.url,
      "select table_name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')",
    );
    expect(tables).toEqual([]);
  });

  it("以 session cookie 呼叫 API；Local Runner 在線、接受派工、Fake Agent 可用", async () => {
    const me = await api<{ member: { id: string; role: string } }>("GET", API_ROUTES.authMe);
    expect(me.status).toBe(200);
    expect(me.body.member).toMatchObject({ id: ready.memberId, role: "owner" });
    const list = await api<Runner[]>("GET", API_ROUTES.runners);
    expect(list.body).toMatchObject([
      {
        id: ready.runnerId,
        kind: "local",
        memberId: ready.memberId,
        online: true,
        acceptingDispatches: true,
        agents: expect.arrayContaining([
          expect.objectContaining({ agent: "claude-code", available: true }),
        ]),
      },
    ]);
  });

  it("M1 劇本走完：權限請求 → 退回「改成第二版」→ 核准 → push → 以 App 開 PR → merged webhook → Done", async () => {
    const created = await api<{ id: string }>(
      "POST",
      apiPath(API_ROUTES.projectTasks, { projectId: ready.projectId }),
      { repoId: ready.repoId, title: "M1 smoke", description: "新增 m1.txt" },
    );
    expect(created.status).toBe(201);
    const taskId = created.body.id;
    const criterion = await api<{ id: string }>(
      "POST",
      apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId }),
      { kind: "manual", description: "m1.txt 存在" },
    );
    expect(
      (await api("POST", apiPath(API_ROUTES.taskTransition, { taskId }), { status: "ready" }))
        .status,
    ).toBe(200);
    const run = await api<Run>("POST", apiPath(API_ROUTES.taskRuns, { taskId }), {
      agent: "claude-code",
      runnerKind: "local",
    });
    expect(run.body.permissionPolicy).toBe("manual");

    const request = await until("權限請求", async () => {
      const items = (await api<NeedsYouListResponse>("GET", API_ROUTES.needsYou)).body;
      return items.find((i) => i.kind === "permission_request");
    });
    if (request.kind !== "permission_request") throw new Error("unreachable");
    const allow = request.options.find((o) => o.kind === "allow_once");
    const responded = await api(
      "POST",
      apiPath(API_ROUTES.runPermissionResponse, {
        runId: run.body.id,
        requestId: request.permissionRequestId,
      }),
      { optionId: allow?.optionId },
    );
    expect(responded.status).toBe(204);

    type GateList = { id: string; decision: string | null }[];
    const gates = () => api<GateList>("GET", apiPath(API_ROUTES.taskGates, { taskId }));
    const first = await until("第一次 Review Gate", async () =>
      (await gates()).body.find((g) => g.decision === null),
    );
    await api("POST", apiPath(API_ROUTES.gateDecision, { gateId: first.id }), {
      action: "reject",
      reviewComments: [{ path: "m1.txt", line: 1, side: "new", body: "請改成第二版" }],
    });
    const second = await until("第二次 Review Gate", async () =>
      (await gates()).body.find((g) => g.decision === null && g.id !== first.id),
    );
    // manual 條件全部打勾後才能核准 Review Gate。
    const checked = await api(
      "POST",
      apiPath(API_ROUTES.acceptanceCriterionCheck, { criterionId: criterion.body.id }),
      { checked: true },
    );
    expect(checked.status).toBe(200);
    const approved = await api("POST", apiPath(API_ROUTES.gateDecision, { gateId: second.id }), {
      action: "approve",
    });
    expect(approved.status).toBe(200);
    const finished = await until("Run 結束", async () => {
      const current = (await api<Run>("GET", apiPath(API_ROUTES.run, { runId: run.body.id }))).body;
      return current.status === "completed" || current.status === "failed" ? current : undefined;
    });
    expect(finished.status).toBe("completed");
    const pushed = execFileSync("git", ["show", `${finished.branch}:m1.txt`], {
      cwd: ready.bareRepoPath,
      encoding: "utf8",
    });
    expect(pushed).toBe("version 2\n");

    // 以 App 開 PR（FakeGitHub），寫入 pull_requests，Task 在 PR Open。
    const task = () => api<Task>("GET", apiPath(API_ROUTES.task, { taskId }));
    expect((await task()).body.status).toBe("pr_open");
    const merged = await until("以 App 開 PR", async () => {
      try {
        return await sendPullRequestMergedWebhook(ready, { branch: finished.branch ?? "" });
      } catch {
        return undefined;
      }
    });
    expect(merged.status).toBe(200);
    expect(merged.pullRequest).toMatchObject({
      taskId,
      headBranch: finished.branch,
      number: expect.any(Number),
    });
    expect((await task()).body).toMatchObject({ status: "done", doneReason: "completed" });

    // 簽章錯誤的 webhook 被拒絕（webhook secret 每次隨機產生）。
    const forged = await sendPullRequestMergedWebhook(
      { ...ready, github: { ...ready.github, webhookSecret: "wrong" } },
      { prNumber: merged.pullRequest.number },
    );
    expect(forged.status).toBe(401);
  }, 180_000);

  it("stdin 指令：seed_checks 餵 FakeGitHub、list_issue_comments 列留言；不認得的指令回 ok: false", async () => {
    const commander = new StackCommander(stack);
    const seeded = await commander.send<{ runs: number; suites: number }>({
      command: "seed_checks",
      sha: "0123456789abcdef0123456789abcdef01234567",
      runs: [
        { id: 1, name: "lint" },
        { id: 2, name: "test", conclusion: "failure" },
      ],
    });
    expect(seeded).toEqual({ runs: 2, suites: 1 });
    // M1 劇本開出的 PR（上一個測試）在 FakeGitHub 上有 Issue 同步與紀錄的留言；不存在的號碼是空陣列
    const none = await commander.send<unknown[]>({ command: "list_issue_comments", number: 9_999 });
    expect(none).toEqual([]);
    await expect(
      commander.send({ command: "no_such_command" } as unknown as Parameters<
        typeof commander.send
      >[0]),
    ).rejects.toThrow("不認得的指令");
    // 指令通道不影響 ready 之後的其他輸出：stack 還活著
    expect(stack.exitCode).toBeNull();
  });

  it("SIGTERM（Windows 為關閉 stdin）後以 0 結束：沒有殘留的子程序，暫存目錄已刪除", async () => {
    const children = descendants(stack.pid as number);
    expect(children).toContain(ready.runnerPid);
    expect(await started.stop()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(children.filter(isAlive)).toEqual([]);
    expect(existsSync(ready.tempDir)).toBe(false);
    // stack 自己建立的 database 已刪除。
    const adminUrl = inject("postgresAdminUrl") as string;
    const left = await query(adminUrl, "select 1 from pg_database where datname = $1", [
      databaseName(ready.databaseUrl),
    ]);
    expect(left).toEqual([]);
  }, 120_000);
});

describe.skipIf(skipStack)("完整系統 e2e 的啟動腳本：--runner-config-out（不啟動 Runner）", () => {
  let started: StartedStack;
  let configDir: string;

  beforeAll(async () => {
    buildRunnerBinaries();
    configDir = await mkdtemp(path.join(tmpdir(), `${NAMES.productSlug}-e2e-runner-home-`));
    started = await startStack(["--runner-config-out", configDir]);
  }, 600_000);

  afterAll(async () => {
    if (started?.child.exitCode === null) started.child.kill("SIGKILL");
    if (configDir) await rm(configDir, { recursive: true, force: true });
    await sentinel?.drop();
    sentinel = undefined;
  });

  it("寫出對應好的 runner.toml，不啟動 Runner；ready 行的 runnerId、runnerPid 是 null", async () => {
    const { ready } = started;
    expect(ready).toMatchObject({ runnerId: null, runnerPid: null, runnerHome: configDir });
    expect(ready.runnerConfigPath).toBe(path.join(configDir, NAMES.runnerConfigFile));
    expect(await readdir(configDir)).toEqual([NAMES.runnerConfigFile]);
    const toml = readFileSync(ready.runnerConfigPath, "utf8");
    const cloneUrl = `https://github.com/${ready.github.repo.owner}/${ready.github.repo.name}.git`;
    // 路徑以 TOML basic string（JSON 的跳脫規則）寫入。
    expect(toml).toContain(`server = ${JSON.stringify(ready.serverUrl)}`);
    expect(toml).toContain(
      `[repos.${JSON.stringify(cloneUrl)}]\npath = ${JSON.stringify(ready.checkoutPath)}`,
    );
    // Fake Agent 以 --state-dir 啟動（session 保存在 runnerHome 底下），Feedback Loop 的修正 Run 才能接回劇本。
    expect(toml).toMatch(
      /\[agents\.claude-code\]\ncommand = ".*fake-agent.*"\nargs = \["--script", ".*m1\.yaml", "--state-dir", ".*agent-sessions.*claude-code"\]/,
    );

    // 沒有啟動 Runner：stack 沒有子程序，Server 上也沒有 Runner。
    expect(descendants(started.child.pid as number)).toEqual([]);
    const res = await fetch(`${ready.serverUrl}${API_ROUTES.runners}`, {
      headers: { cookie: `${ready.sessionCookie.name}=${ready.sessionCookie.value}` },
    });
    expect(await res.json()).toEqual([]);
  });

  it("結束時刪除 stack 自己的暫存目錄，但保留指定的目錄", async () => {
    expect(await started.stop()).toBe(0);
    expect(existsSync(started.ready.tempDir)).toBe(false);
    expect(existsSync(started.ready.runnerConfigPath)).toBe(true);
  }, 120_000);
});
