import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type UpdateChoice,
  UpdateController,
  type UpdateControllerDeps,
  type UpdatePrompt,
  type UpdaterLike,
  updateView,
} from "./controller";

/** 模擬 electron-updater：事件由測試自己發，記錄被呼叫的方法。 */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checks = 0;
  quitAndInstallCalls = 0;
  /** checkForUpdates() 要不要 reject（模擬沒有發 error 事件的失敗）。 */
  rejectWith: Error | null = null;

  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    this.emit("checking-for-update");
    return this.rejectWith ? Promise.reject(this.rejectWith) : Promise.resolve(null);
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls += 1;
  }
}

interface Harness {
  updater: FakeUpdater;
  controller: UpdateController;
  prompts: UpdatePrompt[];
  informed: string[];
  opened: string[];
  log: string[];
  skipped: { value: string | null };
  prepareInstallResult: { value: boolean };
  prepareInstallCalls: { value: number };
  answers: UpdateChoice[];
}

function harness(
  platform: NodeJS.Platform,
  overrides: Partial<UpdateControllerDeps> = {},
): Harness {
  const updater = new FakeUpdater();
  const prompts: UpdatePrompt[] = [];
  const informed: string[] = [];
  const opened: string[] = [];
  const log: string[] = [];
  const skipped = { value: null as string | null };
  const prepareInstallResult = { value: true };
  const prepareInstallCalls = { value: 0 };
  const answers: UpdateChoice[] = [];
  const controller = new UpdateController({
    updater,
    platform,
    currentVersion: "0.1.0",
    prompt: async (prompt) => {
      prompts.push(prompt);
      return answers.shift() ?? "later";
    },
    inform: (message) => informed.push(message),
    openDownloadPage: (version) => opened.push(version),
    prepareInstall: async () => {
      prepareInstallCalls.value += 1;
      return prepareInstallResult.value;
    },
    skippedVersion: {
      get: () => skipped.value,
      set: (v) => {
        skipped.value = v;
      },
    },
    log: (message) => log.push(message),
    initialDelayMs: 1_000,
    intervalMs: 10_000,
    ...overrides,
  });
  return {
    updater,
    controller,
    prompts,
    informed,
    opened,
    log,
    skipped,
    prepareInstallResult,
    prepareInstallCalls,
    answers,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("UpdateController", () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] }),
  );
  afterEach(() => vi.useRealTimers());

  it("沒有 updater 時狀態是 unavailable，start 與 checkNow 都不做事", () => {
    const h = harness("win32", { updater: null });
    h.controller.start();
    h.controller.checkNow();
    expect(h.controller.snapshot()).toEqual({ kind: "unavailable" });
    expect(updateView(h.controller.snapshot()).action.enabled).toBe(false);
  });

  it("Windows 自動下載並在結束時安裝；macOS 只檢查", () => {
    expect(harness("win32").updater).toMatchObject({
      autoDownload: true,
      autoInstallOnAppQuit: true,
    });
    expect(harness("darwin").updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
    });
  });

  it("ready 後延遲第一次檢查，之後定期檢查", () => {
    const h = harness("win32");
    h.controller.start();
    expect(h.updater.checks).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(h.updater.checks).toBe(1);
    expect(h.controller.snapshot().kind).toBe("checking");
    h.updater.emit("update-not-available", { version: "0.1.0" });
    expect(h.controller.snapshot().kind).toBe("up_to_date");
    vi.advanceTimersByTime(10_000);
    expect(h.updater.checks).toBe(2);
    h.controller.dispose();
    h.updater.emit("update-not-available", { version: "0.1.0" });
    vi.advanceTimersByTime(60_000);
    expect(h.updater.checks).toBe(2);
    // 自動檢查的結果不打擾使用者
    expect(h.informed).toEqual([]);
  });

  it("手動檢查時回報已是最新版本或失敗", async () => {
    const h = harness("win32");
    h.controller.checkNow();
    h.updater.emit("update-not-available", { version: "0.1.0" });
    expect(h.informed).toEqual(["已是最新版本（v0.1.0）"]);

    h.controller.checkNow();
    h.updater.emit("error", new Error("網路中斷"));
    expect(h.controller.snapshot()).toEqual({ kind: "error", message: "網路中斷" });
    expect(h.informed).toEqual(["已是最新版本（v0.1.0）", "檢查更新失敗：網路中斷"]);

    // checkForUpdates() 直接 reject、沒有發 error 事件時也一樣
    h.updater.rejectWith = new Error("feed 不存在");
    h.controller.checkNow();
    await flush();
    expect(h.controller.snapshot()).toEqual({ kind: "error", message: "feed 不存在" });
    expect(h.informed).toHaveLength(3);
  });

  it("Windows：下載完成後問使用者，選「稍後」就留到結束 App 時安裝，同一版本不再主動提示", async () => {
    const h = harness("win32");
    h.controller.checkNow();
    h.updater.emit("update-available", { version: "0.2.0" });
    expect(h.controller.snapshot()).toEqual({ kind: "downloading", version: "0.2.0", percent: 0 });
    h.updater.emit("download-progress", { percent: 42.4 });
    expect(h.controller.snapshot()).toMatchObject({ kind: "downloading", percent: 42 });
    expect(updateView(h.controller.snapshot()).label).toBe("下載更新 v0.2.0（42%）");

    h.updater.emit("update-downloaded", { version: "0.2.0" });
    await flush();
    expect(h.prompts).toEqual([{ kind: "downloaded", version: "0.2.0" }]);
    expect(h.controller.snapshot()).toEqual({ kind: "downloaded", version: "0.2.0" });
    expect(h.updater.quitAndInstallCalls).toBe(0);
    expect(updateView(h.controller.snapshot())).toEqual({
      label: "更新 v0.2.0 已下載，結束 App 時安裝",
      action: { label: "立即安裝更新 v0.2.0…", enabled: true },
    });

    // 之後的自動檢查不會再問，也不會重新檢查
    h.controller.start();
    vi.advanceTimersByTime(1_000);
    expect(h.updater.checks).toBe(1);
    expect(h.prompts).toHaveLength(1);
  });

  it("Windows：選「立即更新」時先停止 Runner 再 quitAndInstall；取消就不安裝", async () => {
    const h = harness("win32");
    h.answers.push("install_now");
    h.prepareInstallResult.value = false;
    h.controller.checkNow();
    h.updater.emit("update-available", { version: "0.2.0" });
    h.updater.emit("update-downloaded", { version: "0.2.0" });
    await flush();
    expect(h.prepareInstallCalls.value).toBe(1);
    expect(h.updater.quitAndInstallCalls).toBe(0);

    // 手動再按一次：已下載時直接再問，不重新檢查
    h.answers.push("install_now");
    h.prepareInstallResult.value = true;
    h.controller.checkNow();
    await flush();
    expect(h.updater.checks).toBe(1);
    expect(h.prompts).toHaveLength(2);
    expect(h.prepareInstallCalls.value).toBe(2);
    expect(h.updater.quitAndInstallCalls).toBe(1);
  });

  it("macOS：偵測到新版時問使用者，選「開啟下載頁」就用瀏覽器開 Release 頁", async () => {
    const h = harness("darwin");
    h.answers.push("open_download");
    h.controller.checkNow();
    h.updater.emit("update-available", { version: "0.2.0" });
    await flush();
    expect(h.prompts).toEqual([{ kind: "available", version: "0.2.0" }]);
    expect(h.opened).toEqual(["0.2.0"]);
    expect(h.controller.snapshot()).toEqual({
      kind: "available",
      version: "0.2.0",
      skipped: false,
    });
    expect(updateView(h.controller.snapshot())).toEqual({
      label: "有新版本 v0.2.0，請手動下載",
      action: { label: "下載新版本 v0.2.0…", enabled: true },
    });
    expect(h.updater.quitAndInstallCalls).toBe(0);
  });

  it("macOS：略過的版本保存在設定中，自動檢查不再提示；手動檢查仍會問", async () => {
    const h = harness("darwin");
    h.answers.push("skip_version");
    h.controller.start();
    vi.advanceTimersByTime(1_000);
    h.updater.emit("update-available", { version: "0.2.0" });
    await flush();
    expect(h.skipped.value).toBe("0.2.0");
    expect(h.controller.snapshot()).toEqual({ kind: "available", version: "0.2.0", skipped: true });
    expect(updateView(h.controller.snapshot()).label).toBeNull();

    // 下一次啟動（新的 controller）自動檢查到同一個版本：不提示
    const next = harness("darwin", {
      skippedVersion: {
        get: () => h.skipped.value,
        set: (v) => {
          h.skipped.value = v;
        },
      },
    });
    next.controller.start();
    vi.advanceTimersByTime(1_000);
    next.updater.emit("update-available", { version: "0.2.0" });
    await flush();
    expect(next.prompts).toEqual([]);

    // 更新的版本會提示
    vi.advanceTimersByTime(10_000);
    next.updater.emit("update-available", { version: "0.3.0" });
    await flush();
    expect(next.prompts).toEqual([{ kind: "available", version: "0.3.0" }]);

    // 手動檢查略過的版本也會問
    const manual = harness("darwin", {
      skippedVersion: { get: () => "0.2.0", set: () => {} },
    });
    manual.controller.checkNow();
    manual.updater.emit("update-available", { version: "0.2.0" });
    await flush();
    expect(manual.prompts).toEqual([{ kind: "available", version: "0.2.0" }]);
  });

  it("同一個版本每次啟動只主動提示一次，對話框顯示中不會再疊一個", async () => {
    const prompts: UpdatePrompt[] = [];
    const pending: { resolve: ((choice: UpdateChoice) => void) | null } = { resolve: null };
    const slow = harness("darwin", {
      prompt: (prompt) => {
        prompts.push(prompt);
        return new Promise((resolve) => {
          pending.resolve = resolve;
        });
      },
    });
    slow.controller.start();
    vi.advanceTimersByTime(1_000);
    slow.updater.emit("update-available", { version: "0.2.0" });
    // 對話框還開著時又檢查到同一個版本
    vi.advanceTimersByTime(10_000);
    slow.updater.emit("update-available", { version: "0.2.0" });
    await flush();
    expect(prompts).toHaveLength(1);
    pending.resolve?.("later");
    await flush();
    vi.advanceTimersByTime(10_000);
    slow.updater.emit("update-available", { version: "0.2.0" });
    await flush();
    expect(prompts).toHaveLength(1);
  });
});
