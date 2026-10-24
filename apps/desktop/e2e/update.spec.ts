// 自動更新（ARCHITECTURE §16）：用本機的 fake feed 當更新來源（DESKTOP_ENV.updateFeedUrl）跑真實的 electron-updater。
// Windows 會下載安裝檔並詢問（測試時不在結束 App 時安裝）；macOS 只提示並開下載頁。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { DESKTOP_ENV } from "../src/main/names";
import { releasePageUrl } from "../src/main/update/release-source";
import { type Desktop, launchDesktop, waitUntil } from "./fixtures/desktop";
import { type FakeServer, startFakeServer } from "./fixtures/fake-server";
import { startUpdateFeed, type UpdateFeed } from "./fixtures/update-feed";

let server: FakeServer;
let feed: UpdateFeed | undefined;
let desktop: Desktop | undefined;
/** Windows 上 electron-updater 的下載快取放在 LOCALAPPDATA 底下，測試用暫存目錄，不留在使用者的電腦上。 */
let cacheDir: string | undefined;

test.beforeEach(async () => {
  server = await startFakeServer();
});

test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  await feed?.close();
  feed = undefined;
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  cacheDir = undefined;
  await server.close();
});

async function launchWithFeed(version: string): Promise<Desktop> {
  feed = await startUpdateFeed(version);
  cacheDir = mkdtempSync(join(tmpdir(), "desktop-update-cache-"));
  desktop = await launchDesktop({
    config: { serverUrl: server.url },
    env: {
      [DESKTOP_ENV.updateFeedUrl]: feed.url,
      ...(process.platform === "win32" ? { LOCALAPPDATA: cacheDir } : {}),
    },
  });
  await desktop.mainWindow();
  return desktop;
}

test("有新版本：Windows 自動下載後詢問，macOS 提示並開下載頁", async () => {
  const d = await launchWithFeed("99.0.0");
  expect(await d.hooks((h) => h.update())).toEqual({ kind: "idle" });
  if (process.platform !== "win32") await d.hooks((h) => h.answerUpdatePrompt("open_download"));
  await d.hooks((h) => h.trayAction("check-updates"));

  if (process.platform === "win32") {
    await waitUntil(
      () => d.hooks((h) => h.update()),
      (state) => state.kind === "downloaded",
      "更新下載完成",
      60_000,
    );
    expect(feed?.requests).toContain("/latest.yml");
    expect(await d.hooks((h) => h.updatePrompts)).toEqual([
      { kind: "downloaded", version: "99.0.0" },
    ]);
    const tray = await d.hooks((h) => h.tray());
    expect(tray.tooltip).toContain("更新 v99.0.0 已下載，結束 App 時安裝");
    expect(tray.items).toContainEqual({
      kind: "action",
      id: "check-updates",
      label: "立即安裝更新 v99.0.0…",
      enabled: true,
    });
    return;
  }

  await waitUntil(
    () => d.hooks((h) => h.updatePrompts),
    (prompts) => prompts.length === 1,
    "更新提示",
    60_000,
  );
  expect(await d.hooks((h) => h.updatePrompts)).toEqual([{ kind: "available", version: "99.0.0" }]);
  expect(await d.hooks((h) => h.externalUrls)).toEqual([releasePageUrl("99.0.0")]);
  expect(await d.hooks((h) => h.update())).toEqual({
    kind: "available",
    version: "99.0.0",
    skipped: false,
  });
  expect(await d.hooks((h) => h.tray().tooltip)).toContain("有新版本 v99.0.0");
  // 沒有下載安裝檔
  expect(feed?.requests.filter((p) => p.endsWith(".zip"))).toEqual([]);
});

test("已是最新版本：手動檢查時告訴使用者", async () => {
  const d = await launchWithFeed("0.0.1");
  await d.hooks((h) => h.trayAction("check-updates"));
  await waitUntil(
    () => d.hooks((h) => h.update()),
    (state) => state.kind === "up_to_date",
    "已是最新版本",
    60_000,
  );
  expect(await d.hooks((h) => h.dialogs)).toEqual([expect.stringMatching(/^已是最新版本（v/)]);
  expect(await d.hooks((h) => h.updatePrompts)).toEqual([]);
});
