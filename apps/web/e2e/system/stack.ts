// 完整系統 e2e 用的程序管理：啟動 B1 的 `e2e:stack`（Postgres、Server、Local Runner、Fake Agent）
// 與接到它的 Vite，結束時關閉並確認沒有殘留的程序。
//
// Server 與 Web 都用向作業系統要來的空 port，不佔用使用者自己 `pnpm dev` 的 4000 與 5173。

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envVar } from "@orbis/api-contract/names";

const webDir = fileURLToPath(new URL("../..", import.meta.url));
const serverDir = fileURLToPath(new URL("../../../server", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

/** stack 與 Vite 的 log（CI 失敗時上傳）。 */
export const LOG_DIR = join(webDir, "test-results", "system-logs");

/** 完整系統啟動後交給測試的資訊（環境變數 `<前綴>SYSTEM_E2E_STACK`，JSON）。 */
export const STACK_ENV = envVar("SYSTEM_E2E_STACK");

/** `e2e:stack` 印出的 ready 行（欄位見 apps/server/README.md）。 */
export interface ReadyLine {
  ready: true;
  serverUrl: string;
  webOrigin: string;
  sessionCookie: { name: string; value: string };
  memberId: string;
  projectId: string;
  projectKey: string;
  repoId: string;
  runnerId: string;
  runnerPid: number;
  bareRepoPath: string;
  tempDir: string;
}

export function readStack(): ReadyLine {
  const raw = process.env[STACK_ENV];
  if (!raw) throw new Error(`沒有 ${STACK_ENV}：完整系統沒有由 globalSetup 啟動`);
  return JSON.parse(raw) as ReadyLine;
}

/** 向作業系統要一個空的 port。 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function logTo(name: string): WriteStream {
  mkdirSync(LOG_DIR, { recursive: true });
  return createWriteStream(join(LOG_DIR, name));
}

/** 某個程序的所有子孫程序。 */
export function descendants(rootPid: number): number[] {
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

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 強制結束整個程序樹：Windows 用 `taskkill /T`，其他平台結束 process group。 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      // 程序已經結束
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // 程序已經結束
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null | "timeout"> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export interface StartedStack {
  ready: ReadyLine;
  /** 關閉 stdin 讓 stack 自己清理；逾時就強制結束。回傳結束碼。 */
  stop: () => Promise<number | null | "timeout">;
  /** stack 與它的子孫程序（關閉前記下，關閉後確認都已結束）。 */
  processes: () => number[];
}

/**
 * 啟動 `e2e:stack`，等它印出 ready 行。Runner 與 Fake Agent 要先 `cargo build`。
 * 有 repo 根目錄的 `.env` 時讀取（例如本機的 `<前綴>DATABASE_URL`），沒有資料庫設定時 stack 以
 * Testcontainers 啟動 Postgres。
 */
export async function startStack(serverPort: number, webOrigin: string): Promise<StartedStack> {
  const log = logTo("stack.log");
  const child = spawn(
    process.execPath,
    [
      `--env-file-if-exists=${join(repoRoot, ".env")}`,
      "--import",
      "tsx",
      "scripts/system-e2e-stack.ts",
    ],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        [envVar("SERVER_PORT")]: String(serverPort),
        [envVar("PUBLIC_URL")]: webOrigin,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  child.stderr?.pipe(log);

  let stdout = "";
  const ready = await new Promise<ReadyLine>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 e2e:stack 的 ready 行逾時")), 600_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(stdout.slice(0, newline)) as ReadyLine);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`e2e:stack 提早結束（${code}），log 見 ${join(LOG_DIR, "stack.log")}`));
    });
  });

  return {
    ready,
    processes: () => (child.pid === undefined ? [] : [child.pid, ...descendants(child.pid)]),
    stop: async () => {
      // README：由程式管理時關閉 stdin，Windows 的 kill() 不會觸發清理
      child.stdin?.end();
      const code = await waitForExit(child, 60_000);
      if (code === "timeout") killTree(child);
      log.end();
      return code;
    },
  };
}

export interface StartedWeb {
  pid: number | undefined;
  stop: () => Promise<void>;
}

/** 啟動 Vite（一般模式，`/api` proxy 到 stack 的 Server），等到首頁可以取得。 */
export async function startWeb(webPort: number, serverPort: number): Promise<StartedWeb> {
  const log = logTo("vite.log");
  const child = spawn(
    process.execPath,
    [
      join(webDir, "node_modules", "vite", "bin", "vite.js"),
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      cwd: webDir,
      env: { ...process.env, [envVar("SERVER_PORT")]: String(serverPort) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  const url = `http://localhost:${webPort}/`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Vite 提早結束（${child.exitCode}）`);
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // 還沒開始接受連線
    }
    if (Date.now() > deadline) {
      killTree(child);
      throw new Error("等待 Vite 啟動逾時");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return {
    pid: child.pid,
    stop: async () => {
      killTree(child);
      await waitForExit(child, 10_000);
      log.end();
    },
  };
}
