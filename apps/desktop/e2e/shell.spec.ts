// 殼：第一次啟動設定 Server URL、載入 Web UI、安全設定、導覽限制。

import { expect, test } from "@playwright/test";
import { DESKTOP_BRIDGE_KEY } from "../src/bridge";
import { type Desktop, launchDesktop, waitUntil } from "./fixtures/desktop";
import { type FakeServer, startFakeServer } from "./fixtures/fake-server";

let server: FakeServer;
let desktop: Desktop | undefined;

test.beforeEach(async () => {
  server = await startFakeServer();
});

test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  await server.close();
});

test("第一次啟動時設定 Server URL，驗證後載入 Web UI", async () => {
  desktop = await launchDesktop();
  const settings = await desktop.app.firstWindow();
  await expect(settings).toHaveURL(/settings\.html\?first-run=1$/);
  await expect(settings.locator("#tools-form")).toBeHidden();

  // 不是 Server 的網址：顯示原因，不關閉設定頁
  await settings.fill("#server-url", "http://127.0.0.1:1");
  await settings.click("#server-save");
  await expect(settings.locator("#server-error")).toContainText("無法連線到 Server");

  await settings.fill("#server-url", "https://team.example.com/app");
  await settings.click("#server-save");
  await expect(settings.locator("#server-error")).toContainText("不要包含路徑");

  await settings.fill("#server-url", `${server.url}/`);
  await settings.click("#server-save");
  const main = await desktop.mainWindow();
  await expect(main.locator("#path")).toHaveText("/");
  expect(await desktop.hooks((h) => h.config().serverUrl)).toBe(server.url);
});

test("主視窗使用嚴格的安全設定，頁面中只有 bridge、沒有 Node", async () => {
  desktop = await launchDesktop({ config: { serverUrl: server.url } });
  const main = await desktop.mainWindow();
  await expect(main.locator("#path")).toHaveText("/");

  const prefs = await desktop.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith("http"),
    );
    // getLastWebPreferences 沒有寫在型別定義中，但能讀出 Chromium 實際套用的設定
    const contents = window?.webContents as unknown as {
      getLastWebPreferences(): Electron.WebPreferences;
    };
    const p = contents?.getLastWebPreferences();
    return {
      contextIsolation: p?.contextIsolation,
      sandbox: p?.sandbox,
      nodeIntegration: p?.nodeIntegration,
      webviewTag: p?.webviewTag,
      webSecurity: p?.webSecurity,
    };
  });
  expect(prefs).toEqual({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    webSecurity: true,
  });

  const page = await main.evaluate((key) => {
    const bridge = (window as unknown as Record<string, Record<string, unknown>>)[key];
    return {
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridgeKeys: bridge ? Object.keys(bridge).sort() : null,
    };
  }, DESKTOP_BRIDGE_KEY);
  expect(page).toEqual({
    require: "undefined",
    process: "undefined",
    bridgeKeys: [
      "beforeLogout",
      "getNotificationsEnabled",
      "getVersion",
      "loginAgent",
      "openWorktreeInEditor",
      "openWorktreeInTerminal",
      "preview",
      "revealWorktree",
      "setNotificationsEnabled",
    ],
  });
  expect(
    await main.evaluate(
      (key) =>
        (window as unknown as Record<string, { getVersion(): Promise<string> }>)[key]?.getVersion(),
      DESKTOP_BRIDGE_KEY,
    ),
  ).toMatch(/^\d+\.\d+\.\d+/);
});

test("不開新視窗，也不離開 Server origin", async () => {
  desktop = await launchDesktop({ config: { serverUrl: server.url } });
  const main = await desktop.mainWindow();
  await expect(main.locator("#path")).toHaveText("/");

  expect(await main.evaluate(() => window.open("about:blank") === null)).toBe(true);
  await main.evaluate(() => {
    location.href = "file:///";
  });
  // 同一個 origin 內的導覽可以
  await main.evaluate(() => {
    location.href = "/tasks/ORB-1";
  });
  await expect(main.locator("#path")).toHaveText("/tasks/ORB-1");
  expect(new URL(main.url()).origin).toBe(server.url);
  await waitUntil(
    () =>
      desktop?.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) ??
      Promise.resolve(0),
    (count) => count === 1,
    "只有主視窗",
  );
});
