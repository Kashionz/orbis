// 開啟本機工具：Web UI 經由 bridge 要求用編輯器／終端機開啟 Worktree。
// test hooks 攔截實際的啟動，只記錄要執行的指令。

import { homedir } from "node:os";
import { expect, test } from "@playwright/test";
import { DESKTOP_BRIDGE_KEY, type DesktopActionResult } from "../src/bridge";
import { worktreeRoot } from "../src/main/local-tools/worktree-path";
import { type Desktop, launchDesktop, makeTempWorktree } from "./fixtures/desktop";
import { type FakeServer, startFakeServer } from "./fixtures/fake-server";

let server: FakeServer;
let desktop: Desktop | undefined;
let worktree: ReturnType<typeof makeTempWorktree>;

test.beforeEach(async () => {
  server = await startFakeServer();
  worktree = makeTempWorktree(worktreeRoot(process.platform, homedir()));
});

test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  await server.close();
  worktree.remove();
});

type Action = "openWorktreeInEditor" | "openWorktreeInTerminal";

async function invoke(action: Action, path: string): Promise<DesktopActionResult> {
  if (!desktop) throw new Error("Desktop 尚未啟動");
  const main = await desktop.mainWindow();
  return main.evaluate(
    ([key, name, p]) =>
      (
        window as unknown as Record<
          string,
          Record<string, (p: string) => Promise<DesktopActionResult>>
        >
      )[key]?.[name]?.(p) as Promise<DesktopActionResult>,
    [DESKTOP_BRIDGE_KEY, action, path] as const,
  );
}

test("依設定的自訂指令開啟 Worktree，{path} 換成 Worktree 路徑", async () => {
  // 用 Node 執行檔當作「編輯器」與「終端機」：每個平台都有，而且是絕對路徑
  const program = process.execPath;
  desktop = await launchDesktop({
    config: {
      serverUrl: server.url,
      editor: { preset: "custom", customCommand: `"${program}" --editor {path}` },
      terminal: { preset: "custom", customCommand: `"${program}" --cwd={path}` },
    },
  });
  await expect((await desktop.mainWindow()).locator("#path")).toHaveText("/");

  expect(await invoke("openWorktreeInEditor", worktree.path)).toEqual({ ok: true });
  expect(await invoke("openWorktreeInTerminal", worktree.path)).toEqual({ ok: true });
  const launches = await desktop.hooks((h) => h.launches);
  // Windows 上一律加上 NoDefaultCurrentDirectoryInExePath，不在目前目錄中找執行檔
  const env =
    process.platform === "win32" ? { NoDefaultCurrentDirectoryInExePath: "1" } : undefined;
  expect(launches).toEqual([
    {
      command: program,
      args: ["--editor", worktree.path],
      cwd: worktree.path,
      windowsHide: false,
      ...(env && { env }),
    },
    {
      command: program,
      args: [`--cwd=${worktree.path}`],
      cwd: worktree.path,
      windowsHide: false,
      ...(env && { env }),
    },
  ]);
});

test("拒絕 Worktree 根目錄以外與不存在的路徑", async () => {
  desktop = await launchDesktop({
    config: {
      serverUrl: server.url,
      editor: { preset: "custom", customCommand: `"${process.execPath}" {path}` },
    },
  });
  await expect((await desktop.mainWindow()).locator("#path")).toHaveText("/");

  const outside = await invoke("openWorktreeInEditor", homedir());
  expect(outside).toMatchObject({ ok: false });
  expect(outside.ok === false && outside.message).toContain("只能開啟");

  const missing = await invoke("openWorktreeInEditor", `${worktree.path}-missing`);
  expect(missing.ok === false && missing.message).toContain("找不到 Worktree");

  expect(await desktop.hooks((h) => h.launches.length)).toBe(0);
});
