// 桌面通知：登入後每 5 秒輪詢 Needs You，新項目發出通知，點擊後跳到對應頁面，系統匣的數量更新。

import type { NeedsYouItem } from "@orbis/api-contract";
import { expect, test } from "@playwright/test";
import { type Desktop, launchDesktop, waitUntil } from "./fixtures/desktop";
import { FAKE_ME, type FakeServer, startFakeServer } from "./fixtures/fake-server";

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

const gate: NeedsYouItem = {
  kind: "gate",
  id: "needs-you-1",
  memberId: FAKE_ME.member.id,
  taskId: "task-1",
  taskKey: "ORB-12",
  runId: "run-1",
  createdAt: "2026-10-23T00:00:00.000Z",
  gateKind: "review",
};

test("Needs You 出現新項目時發出通知，點擊後跳到 diff review", async () => {
  desktop = await launchDesktop({ config: { serverUrl: server.url } });
  const main = await desktop.mainWindow();
  await main.click("#login");
  await expect(main.locator("#path")).toHaveText("/");

  // 第一次輪詢建立基準，不發通知
  await waitUntil(
    async () => server.state.needsYouRequests,
    (n) => n >= 1,
    "第一次輪詢",
  );
  expect(await desktop.hooks((h) => h.notifications.length)).toBe(0);

  server.state.needsYou = [gate];
  const notifications = await waitUntil(
    () => desktop?.hooks((h) => h.notifications) ?? Promise.resolve([]),
    (list) => list.length === 1,
    "出現通知",
  );
  expect(notifications[0]).toEqual({
    title: "ORB-12 的 Review Gate 等待核准",
    body: "點擊查看並核准",
    href: "/runs/run-1/review",
  });
  const tray = await desktop.hooks((h) => h.tray());
  expect(tray.needsYouCount).toBe(1);
  expect(tray.tooltip).toContain("Needs You 1 項");

  await desktop.hooks((h) => h.clickNotification(0));
  await expect(main.locator("#path")).toHaveText("/runs/run-1/review");

  // 同一個項目不會重複通知；處理完之後數量歸零
  server.state.needsYou = [];
  await waitUntil(
    () => desktop?.hooks((h) => h.tray().needsYouCount) ?? Promise.resolve(-1),
    (n) => n === 0,
    "Needs You 歸零",
  );
  expect(await desktop.hooks((h) => h.notifications.length)).toBe(1);
});

test("登出後停止輪詢，數量歸零", async () => {
  server.state.needsYou = [gate];
  desktop = await launchDesktop({ config: { serverUrl: server.url } });
  const main = await desktop.mainWindow();
  await main.click("#login");
  await waitUntil(
    () => desktop?.hooks((h) => h.tray().needsYouCount) ?? Promise.resolve(0),
    (n) => n === 1,
    "Needs You 1 項",
  );

  await main.click("#logout");
  await waitUntil(
    () => desktop?.hooks((h) => h.session().phase) ?? Promise.resolve(""),
    (phase) => phase === "signed_out",
    "偵測到登出",
  );
  const tray = await desktop.hooks((h) => h.tray());
  expect(tray.needsYouCount).toBe(0);
  expect(tray.statusLabel).toBe("尚未登入");
  const requests = server.state.needsYouRequests;
  await new Promise((r) => setTimeout(r, 6_000));
  expect(server.state.needsYouRequests).toBe(requests);
});
