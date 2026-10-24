// 版本相容（ARCHITECTURE §16）：Desktop 比對 /api/health 回報的 API 與協定版本，系統匣與對話框明說要更新哪個元件。

import { API_VERSION } from "@orbis/api-contract";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { expect, test } from "@playwright/test";
import {
  type Desktop,
  launchDesktop,
  runnerSidecarSkipReason,
  waitUntil,
} from "./fixtures/desktop";
import { type FakeServer, startFakeServer } from "./fixtures/fake-server";

const UPDATE_DESKTOP = "Desktop 版本過舊，請更新 Desktop";
const UPDATE_SERVER = "Server 版本過舊，請更新 Server";

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

async function launchAndWaitForVerdict(): Promise<Desktop> {
  desktop = await launchDesktop({ config: { serverUrl: server.url } });
  await desktop.mainWindow();
  const d = desktop;
  await waitUntil(
    () => d.hooks((h) => h.compat()),
    (verdict) => verdict !== null,
    "版本相容的判定",
  );
  return d;
}

test("版本相同時沒有任何提示", async () => {
  const d = await launchAndWaitForVerdict();
  expect(await d.hooks((h) => h.compat())).toEqual({ kind: "compatible" });
  expect(await d.hooks((h) => h.dialogs)).toEqual([]);
  expect(await d.hooks((h) => h.tray().tone)).not.toBe("warn");
});

test("Server 的 API 版本比 Desktop 新：系統匣與對話框提示更新 Desktop", async () => {
  server.state.versions = { server: "9.9.9", api: API_VERSION + 1, protocol: PROTOCOL_VERSION };
  const d = await launchAndWaitForVerdict();
  expect(await d.hooks((h) => h.compat())).toMatchObject({
    kind: "update_desktop",
    message: UPDATE_DESKTOP,
    detail: expect.stringContaining(`API 版本 ${API_VERSION}，Server 需要 ${API_VERSION + 1}`),
  });
  expect(await d.hooks((h) => h.dialogs)).toEqual([UPDATE_DESKTOP]);
  const tray = await d.hooks((h) => h.tray());
  expect(tray.tone).toBe("warn");
  expect(tray.tooltip).toContain(UPDATE_DESKTOP);
  expect(tray.items).toContainEqual({ kind: "label", label: `⚠ ${UPDATE_DESKTOP}` });
});

test("Server 沒有回報版本（比 Phase 1 更早）：提示更新 Server", async () => {
  server.state.versions = undefined;
  const d = await launchAndWaitForVerdict();
  expect(await d.hooks((h) => h.compat())).toMatchObject({ kind: "update_server" });
  expect(await d.hooks((h) => h.dialogs)).toEqual([UPDATE_SERVER]);
  expect(await d.hooks((h) => h.tray().tooltip)).toContain(UPDATE_SERVER);
});

test.describe("Runner 被 Server 以 version_mismatch 拒絕", () => {
  const skipReason = runnerSidecarSkipReason();
  test.skip(skipReason !== null, skipReason ?? "");

  test("Runner 停止後，系統匣直接說要更新 Desktop，同一個問題只提示一次", async () => {
    server.state.versions = { server: "9.9.9", api: API_VERSION, protocol: PROTOCOL_VERSION + 1 };
    server.state.rejectHelloVersion = true;
    const d = await launchAndWaitForVerdict();
    const main = await d.mainWindow();
    await main.click("#login");
    await waitUntil(
      () => d.hooks((h) => h.sidecar().phase),
      (phase) => phase === "version_mismatch",
      "sidecar 以協定版本不相容結束",
    );
    expect(await d.hooks((h) => h.sidecar().lastExit?.code)).toBe(76);
    await waitUntil(
      () => d.hooks((h) => h.tray().statusLabel),
      (label) => label === UPDATE_DESKTOP,
      "系統匣顯示要更新 Desktop",
    );
    expect(await d.hooks((h) => h.tray().items)).toContainEqual({
      kind: "label",
      label: `Runner：${UPDATE_DESKTOP}`,
    });
    // 啟動時已經提示過同一個問題，Runner 停止時不再跳一次，也不顯示籠統的訊息
    expect(await d.hooks((h) => h.dialogs)).toEqual([UPDATE_DESKTOP]);
  });
});
