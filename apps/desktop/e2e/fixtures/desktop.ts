// 以 Playwright 的 Electron 模式啟動 Desktop：每個測試有獨立的 userData，啟用 test hooks。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import type { DesktopConfig } from "../../src/main/config-store";
import { DESKTOP_ENV, runnerBinaryName } from "../../src/main/names";
import { SIDECAR_FLAG } from "../../src/main/sidecar/protocol";
import { type DesktopTestHooks, TEST_HOOKS_GLOBAL } from "../../src/main/test-hooks";

// resolve() 去掉結尾的分隔符號：Windows 命令列上 `\"` 會被當成跳脫的引號
const desktopDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const RUNNER_BINARY = join(desktopDir, "..", "..", "target", "debug", runnerBinaryName());

export interface Desktop {
  app: ElectronApplication;
  userDataDir: string;
  /** 在 main 程序中讀取 test hooks。 */
  hooks<T>(read: (hooks: DesktopTestHooks) => T): Promise<T>;
  /** 載入 Server Web UI 的主視窗。 */
  mainWindow(): Promise<Page>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** 預先寫入的設定；不給時是第一次啟動。 */
  config?: Partial<DesktopConfig>;
  env?: Record<string, string>;
}

export async function launchDesktop(options: LaunchOptions = {}): Promise<Desktop> {
  const userDataDir = mkdtempSync(join(tmpdir(), "desktop-e2e-"));
  if (options.config) {
    writeFileSync(join(userDataDir, "desktop-config.json"), JSON.stringify(options.config));
  }
  const app = await _electron.launch({
    // GitHub Actions 的 Linux runner 不允許 Chromium sandbox 需要的 user namespace
    args: [desktopDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      [DESKTOP_ENV.userDataDir]: userDataDir,
      [DESKTOP_ENV.testHooks]: "1",
      ...options.env,
    } as Record<string, string>,
  });
  let closed = false;
  const desktop: Desktop = {
    app,
    userDataDir,
    hooks: <T>(read: (hooks: DesktopTestHooks) => T) =>
      app.evaluate(
        (_electron, [key, source]) => {
          const hooks = (globalThis as Record<string, unknown>)[key];
          // 測試中把讀取函式的原始碼送進 main 程序執行（evaluate 只能傳可序列化的值）
          // biome-ignore lint/security/noGlobalEval: 只在測試中使用
          const read = globalThis.eval(source) as (h: unknown) => unknown;
          return read(hooks);
        },
        [TEST_HOOKS_GLOBAL, read.toString()] as const,
      ) as Promise<T>,
    mainWindow: async () => {
      for (;;) {
        const page = app.windows().find((w) => w.url().startsWith("http"));
        if (page) return page;
        await app.waitForEvent("window", { timeout: 15_000 });
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  return desktop;
}

/** 等待條件成立（用於讀取 main 程序狀態的輪詢）。 */
export async function waitUntil<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (check(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`等待逾時：${what}（最後的值：${JSON.stringify(last)}）`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * 真實的 Runner 是否支援 sidecar 模式。A1 的 sidecar 模式合併前回傳 skip 的原因。
 * 使用者決定 sidecar 的 e2e 一律用真實的 Runner，不用 fake。
 */
export function runnerSidecarSkipReason(): string | null {
  // 執行檔不存在是環境問題，直接失敗（pnpm test:e2e 會先 cargo build），不 skip
  const help = execFileSync(RUNNER_BINARY, ["--help"], { encoding: "utf8", windowsHide: true });
  if (!help.includes(SIDECAR_FLAG)) {
    return `Runner 還不支援 ${SIDECAR_FLAG}（等 A1 的 sidecar 模式合併後自動執行）`;
  }
  return null;
}

/** 在 Worktree 根目錄底下建立一個暫時的目錄（測試結束後刪除）。 */
export function makeTempWorktree(root: string): { path: string; remove(): void } {
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, "desktop-e2e-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
