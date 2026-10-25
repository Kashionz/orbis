// 新工作區介面的 bridge 方法：在檔案總管開啟 Worktree、桌面通知總開關、Agent 重新登入
// （後端缺口 reveal-in-explorer、desktop-notify-toggle、agent-relogin）。

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NeedsYouItem } from "@orbis/api-contract";
import { NAMES } from "@orbis/api-contract/names";
import { expect, test } from "@playwright/test";
import { DESKTOP_BRIDGE_KEY } from "../src/bridge";
import { worktreeRoot } from "../src/main/local-tools/worktree-path";
import { type Desktop, launchDesktop, makeTempWorktree, waitUntil } from "./fixtures/desktop";
import { FAKE_ME, type FakeServer, startFakeServer } from "./fixtures/fake-server";

let server: FakeServer;
let desktop: Desktop | undefined;
const cleanups: (() => void)[] = [];

test.beforeEach(async () => {
  server = await startFakeServer();
});

test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  await server.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** 在主視窗（Server origin）呼叫 bridge 的方法。 */
async function bridge<T>(method: string, ...args: unknown[]): Promise<T> {
  if (!desktop) throw new Error("Desktop 尚未啟動");
  const main = await desktop.mainWindow();
  return main.evaluate(
    ([key, name, params]) => {
      const api = (
        window as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>
      )[key];
      return api?.[name]?.(...params);
    },
    [DESKTOP_BRIDGE_KEY, method, args] as const,
  ) as Promise<T>;
}

test("revealWorktree 只開 Worktree 根目錄底下的 Worktree", async () => {
  const worktree = makeTempWorktree(worktreeRoot(process.platform, homedir()));
  cleanups.push(() => worktree.remove());
  desktop = await launchDesktop({ config: { serverUrl: server.url } });
  await expect((await desktop.mainWindow()).locator("#path")).toHaveText("/");

  expect(await bridge("revealWorktree", worktree.path)).toEqual({ ok: true });
  expect(await desktop.hooks((h) => h.openedPaths)).toEqual([worktree.path]);
  const outside = await bridge<{ ok: boolean; message?: string }>("revealWorktree", homedir());
  expect(outside.ok).toBe(false);
  expect(outside.message).toContain("只能開啟");
  expect(await desktop.hooks((h) => h.openedPaths.length)).toBe(1);
});

const item = (id: string, taskKey: string): NeedsYouItem => ({
  kind: "gate",
  id,
  memberId: FAKE_ME.member.id,
  taskId: `task-${id}`,
  taskKey,
  runId: `run-${id}`,
  createdAt: "2026-10-25T00:00:00.000Z",
  gateKind: "review",
});

test("桌面通知關閉時照常輪詢但不發通知，打開後恢復", async () => {
  desktop = await launchDesktop({
    config: { serverUrl: server.url, notificationsEnabled: false },
  });
  const main = await desktop.mainWindow();
  await main.click("#login");
  await expect(main.locator("#path")).toHaveText("/");
  expect(await bridge("getNotificationsEnabled")).toBe(false);
  await waitUntil(
    async () => server.state.needsYouRequests,
    (n) => n >= 1,
    "第一次輪詢",
  );

  server.state.needsYou = [item("1", "ORB-1")];
  await waitUntil(
    () => desktop?.hooks((h) => h.tray().needsYouCount) ?? Promise.resolve(0),
    (n) => n === 1,
    "系統匣的數量照常更新",
  );
  expect(await desktop.hooks((h) => h.notifications.length)).toBe(0);

  await bridge("setNotificationsEnabled", true);
  expect(await bridge("getNotificationsEnabled")).toBe(true);
  expect(await desktop.hooks((h) => h.config().notificationsEnabled)).toBe(true);
  server.state.needsYou = [item("1", "ORB-1"), item("2", "ORB-2")];
  const notifications = await waitUntil(
    () => desktop?.hooks((h) => h.notifications) ?? Promise.resolve([]),
    (list) => list.length === 1,
    "打開後的新項目發出通知",
  );
  expect(notifications[0]?.title).toContain("ORB-2");
});

/** Fake Agent 的執行檔與劇本（`pnpm test:e2e` 的建置會一起編譯）。 */
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fakeAgent = join(
  repoRoot,
  "target",
  "debug",
  `${NAMES.productSlug}-fake-agent${process.platform === "win32" ? ".exe" : ""}`,
);
const loginScript = join(repoRoot, "crates", "fake-agent", "scripts", "login.yaml");

test("loginAgent 以 sidecar 的狀態目錄執行 Runner 的登入子指令", async () => {
  expect(existsSync(fakeAgent), `${fakeAgent} 不存在，先執行 pnpm test:e2e 的建置`).toBe(true);
  // Runner 的設定：antigravity 換成會要求 authenticate 的 Fake Agent。
  const runnerHome = mkdtempSync(join(tmpdir(), "desktop-login-home-"));
  cleanups.push(() => rmSync(runnerHome, { recursive: true, force: true }));
  mkdirSync(runnerHome, { recursive: true });
  const toml = (value: string) => JSON.stringify(value);
  writeFileSync(
    join(runnerHome, "runner.toml"),
    `[agents.antigravity]\ncommand = ${toml(fakeAgent)}\nargs = ["--script", ${toml(loginScript)}]\n`,
  );
  desktop = await launchDesktop({
    config: { serverUrl: server.url },
    env: { [NAMES.runnerEnv.home]: runnerHome },
  });
  await expect((await desktop.mainWindow()).locator("#path")).toHaveText("/");

  expect(await bridge("loginAgent", "antigravity")).toEqual({ ok: true });
  // 登入標記寫在 sidecar 的狀態目錄，sidecar 下一次 Heartbeat 就會重送可用性。
  expect(existsSync(join(desktop.userDataDir, "runner", "agents", "antigravity.login"))).toBe(true);

  const cli = await bridge<{ ok: boolean; message?: string }>("loginAgent", "codex");
  expect(cli.ok).toBe(false);
  expect(cli.message).toContain("自己的 CLI");
  const invalid = await bridge<{ ok: boolean }>("loginAgent", "../evil");
  expect(invalid.ok).toBe(false);
});
