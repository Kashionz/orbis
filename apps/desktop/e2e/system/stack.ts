// Desktop 完整系統 e2e 的程序管理：以 `--runner-config-out` 啟動 B 軌的 `e2e:stack`（不啟動 Runner，
// Runner 由 Electron 的 sidecar 自己 Pairing）與接到它的 Vite，結束時關閉並確認沒有殘留的程序。
//
// Server 與 Web 都用向作業系統要來的空 port，不佔用使用者自己 `pnpm dev` 的 4000 與 5173。
// 殘留程序的檢查只比對自己啟動的程序樹，不用程序名稱，避免把平行跑的其他測試誤判成殘留。

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envVar } from "@orbis/api-contract/names";
import {
  aliveProcesses,
  type ProcessEntry,
  parseReadyLine,
  processTree,
  type ReadyLine,
} from "@orbis/server/e2e";
import { killProcessTree } from "../../src/main/sidecar/process-tree";

const desktopDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const serverDir = join(desktopDir, "..", "server");
const webDir = join(desktopDir, "..", "web");
const repoRoot = join(desktopDir, "..", "..");

/** stack、Vite 與 Desktop 的 log（CI 失敗時上傳）。 */
export const LOG_DIR = join(desktopDir, "test-results", "system-logs");

/** 向作業系統要一個空的 port。 */
export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export function logTo(name: string): WriteStream {
  mkdirSync(LOG_DIR, { recursive: true });
  return createWriteStream(join(LOG_DIR, name));
}

/**
 * 記下自己啟動的程序樹。程序樹會隨時間變化（Runner、Agent 會中途啟動與結束），
 * 所以在測試的幾個時間點各記一次，結束時確認記過的程序都已經結束。
 */
export class ProcessLedger {
  // 以 PID 加建立時間辨識程序：記下的程序結束後，PID 可能被無關的程序重用
  private readonly processes = new Map<string, ProcessEntry>();

  /** 記下根程序與它目前的子孫程序。 */
  record(rootPid: number | undefined): void {
    if (rootPid === undefined) return;
    for (const entry of processTree(rootPid)) {
      this.processes.set(`${entry.pid}:${entry.created ?? ""}`, entry);
    }
  }

  /** 還活著的程序，以 `<pid> <名稱>` 表示（殘留時錯誤訊息直接看得到是哪些程序）。 */
  alive(): string[] {
    return aliveProcesses([...this.processes.values()]).map(
      (entry) => `${entry.pid} ${entry.name ?? "?"}`,
    );
  }

  get size(): number {
    return this.processes.size;
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null | "timeout"> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit("timeout"), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

/** Unix 上以 detached 啟動，自成一個 process group，強制結束時連同子孫程序一起結束。 */
const DETACHED = process.platform !== "win32";

export interface StartedStack {
  ready: ReadyLine;
  pid: number | undefined;
  /** 關閉 stdin 讓 stack 自己清理；逾時就強制結束。回傳結束碼。 */
  stop: () => Promise<number | null | "timeout">;
}

/**
 * 啟動 `e2e:stack`，等它印出 ready 行。有 `runnerHome` 時以 `--runner-config-out <runnerHome>` 啟動
 * （不啟動 Runner，由 Desktop 的 sidecar 自己 Pairing）；沒有時 stack 自己啟動 Runner。
 * 有 repo 根目錄的 `.env` 時讀取（例如本機的 `<前綴>DATABASE_URL`）；沒有資料庫設定時 stack 以
 * Testcontainers 啟動 Postgres。
 */
export async function startStack(options: {
  serverPort: number;
  webOrigin: string;
  runnerHome?: string;
  /** 額外的環境變數（例如 Preview 網域）。 */
  env?: Record<string, string>;
}): Promise<StartedStack> {
  const log = logTo("stack.log");
  const child = spawn(
    process.execPath,
    [
      `--env-file-if-exists=${join(repoRoot, ".env")}`,
      "--import",
      "tsx",
      "scripts/system-e2e-stack.ts",
      ...(options.runnerHome ? ["--runner-config-out", options.runnerHome] : []),
    ],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        [envVar("SERVER_PORT")]: String(options.serverPort),
        [envVar("PUBLIC_URL")]: options.webOrigin,
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: DETACHED,
      windowsHide: true,
    },
  );
  child.stderr?.pipe(log);

  let stdout = "";
  const ready = await new Promise<ReadyLine>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 e2e:stack 的 ready 行逾時")), 600_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolveReady(parseReadyLine(stdout.slice(0, newline)));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`e2e:stack 提早結束（${code}），log 見 ${join(LOG_DIR, "stack.log")}`));
    });
  });

  return {
    ready,
    pid: child.pid,
    stop: async () => {
      // apps/server/README.md：由程式管理時關閉 stdin，Windows 的 kill() 不會觸發清理
      child.stdin?.end();
      const code = await waitForExit(child, 60_000);
      if (code === "timeout" && child.pid !== undefined) await killProcessTree(child.pid);
      log.end();
      return code;
    },
  };
}

export interface StartedWeb {
  pid: number | undefined;
  stop: () => Promise<void>;
}

/** 啟動 Web 的 Vite（一般模式，`/api` proxy 到 stack 的 Server），等到首頁可以取得。 */
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
      detached: DETACHED,
      windowsHide: true,
    },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  const stop = async () => {
    if (child.pid !== undefined) await killProcessTree(child.pid);
    await waitForExit(child, 10_000);
    log.end();
  };

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
      await stop();
      throw new Error("等待 Vite 啟動逾時");
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return { pid: child.pid, stop };
}
