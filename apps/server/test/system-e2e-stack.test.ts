// 完整系統 e2e 的啟動腳本（scripts/system-e2e-stack.ts）：以子程序執行，確認 ready 行、
// 以 session cookie 呼叫 API、Runner 在線，並以真實的 Runner＋Fake Agent 走一次 M1 劇本
// （push 回本機 bare repo），最後確認關閉後沒有殘留的子程序與暫存目錄。
//
// 沒有設定 DATABASE_URL，所以腳本會自己以 Testcontainers 啟動 Postgres（需要 Docker），
// 和其他 DB 測試一樣只在 Linux CI 跑。

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  API_ROUTES,
  apiPath,
  envVar,
  NAMES,
  type NeedsYouListResponse,
  type Run,
  type Runner,
} from "@orbis/api-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReadyLine } from "../scripts/system-e2e-stack";
import { dbSkipReason } from "./helpers/db";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

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

/** 某個程序的所有子孫程序。 */
function descendants(rootPid: number): number[] {
  const table =
    process.platform === "win32"
      ? execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
          { encoding: "utf8" },
        )
      : execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of table.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(dbSkipReason !== null)("完整系統 e2e 的啟動腳本", () => {
  let stack: ChildProcess;
  let stderr = "";
  let ready: ReadyLine;

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
      if (Date.now() > deadline) throw new Error(`等待${what}逾時\n${stderr.slice(-4000)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    execFileSync(
      "cargo",
      [
        "build",
        "--quiet",
        "-p",
        `${NAMES.productSlug}-runner`,
        "-p",
        `${NAMES.productSlug}-fake-agent`,
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    // 不繼承本機 .env 的設定：沒有 DATABASE_URL，腳本會自己啟動 Postgres 容器。
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith(NAMES.envPrefix)),
    );
    stack = spawn(process.execPath, ["--import", "tsx", "scripts/system-e2e-stack.ts"], {
      cwd: serverDir,
      env: { ...env, [envVar("SERVER_PORT")]: String(await freePort()) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    stack.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let stdout = "";
    ready = await new Promise<ReadyLine>((resolve, reject) => {
      stack.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const newline = stdout.indexOf("\n");
        if (newline >= 0) resolve(JSON.parse(stdout.slice(0, newline)) as ReadyLine);
      });
      stack.once("exit", (code) =>
        reject(new Error(`腳本提早結束（${code}）\n${stderr.slice(-4000)}`)),
      );
    });
  }, 600_000);

  afterAll(async () => {
    if (stack && stack.exitCode === null) stack.kill("SIGKILL");
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
        agents: [expect.objectContaining({ agent: "claude-code", available: true })],
      },
    ]);
  });

  it("M1 劇本走完：權限請求 → 退回「改成第二版」→ 核准 → push 回本機 bare repo", async () => {
    const created = await api<{ id: string }>(
      "POST",
      apiPath(API_ROUTES.projectTasks, { projectId: ready.projectId }),
      { repoId: ready.repoId, title: "M1 smoke", description: "新增 m1.txt" },
    );
    expect(created.status).toBe(201);
    const taskId = created.body.id;
    await api("POST", apiPath(API_ROUTES.taskAcceptanceCriteria, { taskId }), {
      kind: "manual",
      description: "m1.txt 存在",
    });
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
    await api("POST", apiPath(API_ROUTES.gateDecision, { gateId: second.id }), {
      action: "approve",
    });
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
  }, 180_000);

  it("SIGTERM（Windows 為關閉 stdin）後以 0 結束：沒有殘留的子程序，暫存目錄已刪除", async () => {
    const children = descendants(stack.pid as number);
    expect(children).toContain(ready.runnerPid);
    const exited = new Promise<number | null>((resolve) =>
      stack.once("exit", (code) => resolve(code)),
    );
    // Windows 的 kill() 會直接終止程序、不會觸發 SIGTERM 的處理，所以改用關閉 stdin。
    if (process.platform === "win32") stack.stdin?.end();
    else stack.kill("SIGTERM");
    expect(await exited).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(children.filter(isAlive)).toEqual([]);
    expect(existsSync(ready.tempDir)).toBe(false);
  }, 120_000);
});
