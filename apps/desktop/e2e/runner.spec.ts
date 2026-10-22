// 真實的 Runner sidecar（使用者決定 sidecar 的 e2e 一律用真實的 Runner，不用 fake）：
// 登入 → 自動 Pairing → 系統匣顯示已連線、當掉後自動重啟、App 結束後沒有殘留的 Runner 程序、登出解除 Pairing。
// Runner 還不支援 sidecar 模式（A1 合併前）時整組明確 skip 並印出原因。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { isProcessAlive } from "../src/main/sidecar/process-tree";
import {
  type Desktop,
  launchDesktop,
  runnerSidecarSkipReason,
  waitUntil,
} from "./fixtures/desktop";
import { type FakeServer, startFakeServer } from "./fixtures/fake-server";

const skipReason = runnerSidecarSkipReason();
if (skipReason) console.warn(`略過真實 Runner 的 e2e：${skipReason}`);

test.describe("真實 Runner sidecar", () => {
  test.skip(skipReason !== null, skipReason ?? "");

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

  async function signInAndConnect(): Promise<{ desktop: Desktop; pid: number }> {
    desktop = await launchDesktop({ config: { serverUrl: server.url } });
    const main = await desktop.mainWindow();
    await main.click("#login");
    const d = desktop;
    await waitUntil(
      () => d.hooks((h) => h.tray().statusLabel),
      (label) => label === "已連線",
      "系統匣顯示已連線",
    );
    const pid = await d.hooks((h) => h.sidecar().pid);
    if (pid === null) throw new Error("已連線但沒有 sidecar 的 pid");
    return { desktop: d, pid };
  }

  test("登入 → 自動 Pairing → 系統匣顯示已連線", async () => {
    const { desktop: d } = await signInAndConnect();
    expect(server.state.pairingRequests).toEqual([{ hadSession: true, body: { kind: "local" } }]);
    expect(server.state.hellos[0]?.pairing).toEqual({
      kind: "pairing_token",
      token: server.state.issuedPairingTokens[0],
    });
    expect(await d.hooks((h) => h.tray().tooltip)).toContain("已連線");
  });

  test("sidecar 當掉後自動重啟，並以保存的 Runner token 重新連線", async () => {
    const { desktop: d, pid } = await signInAndConnect();
    process.kill(pid, "SIGKILL");
    const restarted = await waitUntil(
      () => d.hooks((h) => h.sidecar()),
      (s) => s.restarts >= 1 && s.pid !== null && s.pid !== pid && s.status?.state === "connected",
      "重啟後重新連線",
    );
    expect(isProcessAlive(pid)).toBe(false);
    expect(restarted.lastExit).not.toBeNull();
    expect(server.state.hellos.at(-1)?.pairing.kind).toBe("runner_token");
    // 重啟不會重新取得 Pairing token
    expect(server.state.pairingRequests).toHaveLength(1);
  });

  test("App 結束後沒有殘留的 Runner 程序", async () => {
    const { desktop: d, pid } = await signInAndConnect();
    expect(isProcessAlive(pid)).toBe(true);
    await d.close();
    desktop = undefined;
    await waitUntil(
      async () => isProcessAlive(pid),
      (alive) => !alive,
      "Runner 程序結束",
      5_000,
    );
  });

  test("登出後停止 Runner 並刪除本機的 Runner 狀態", async () => {
    const { desktop: d, pid } = await signInAndConnect();
    const stateDir = join(d.userDataDir, "runner");
    const main = await d.mainWindow();
    await main.click("#logout");
    await waitUntil(
      () => d.hooks((h) => h.sidecar().phase),
      (phase) => phase === "stopped",
      "sidecar 停止",
    );
    expect(isProcessAlive(pid)).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
    expect(await d.hooks((h) => h.tray().statusLabel)).toBe("尚未登入");
  });

  test("系統匣的「暫停領取新 Run」送給 Runner，並保存在設定中", async () => {
    const { desktop: d } = await signInAndConnect();
    await d.hooks((h) => h.trayAction("pause-claiming"));
    await waitUntil(
      () => d.hooks((h) => h.sidecar().status?.claiming_paused),
      (paused) => paused === true,
      "Runner 回報已暫停領取",
    );
    expect(await d.hooks((h) => h.config().claimingPaused)).toBe(true);
    expect(await d.hooks((h) => h.tray().tooltip)).toContain("已暫停領取");
  });
});
