import { NAMES } from "@orbis/api-contract/names";
import { describe, expect, it } from "vitest";
import type { SessionState } from "../session/session-controller";
import type { SupervisorSnapshot } from "../sidecar/supervisor";
import { checkCompatibility } from "../version/compat";
import { buildTrayModel, deriveRunnerView, runnerStatusLabel } from "./tray-model";

const session = (phase: SessionState["phase"], error: string | null = null): SessionState => ({
  phase,
  me: null,
  error,
});
const sidecar = (
  phase: SupervisorSnapshot["phase"],
  status: Partial<NonNullable<SupervisorSnapshot["status"]>> | null = null,
): SupervisorSnapshot => ({
  phase,
  pid: phase === "running" ? 1 : null,
  restarts: 0,
  lastExit: null,
  status: status && {
    type: "status",
    state: "connected",
    runner_id: "r",
    active_runs: 0,
    claiming_paused: false,
    ...status,
  },
});

describe("deriveRunnerView", () => {
  it("依登入狀態與 sidecar 狀態決定顯示", () => {
    expect(deriveRunnerView(session("signed_out"), sidecar("stopped"))).toEqual({
      kind: "signed_out",
    });
    expect(deriveRunnerView(session("no_team"), sidecar("stopped")).kind).toBe("no_team");
    expect(deriveRunnerView(session("pairing"), sidecar("stopped")).kind).toBe("connecting");
    expect(deriveRunnerView(session("paired"), sidecar("running")).kind).toBe("connecting");
    expect(
      deriveRunnerView(session("paired"), sidecar("running", { state: "connecting" })).kind,
    ).toBe("connecting");
    expect(deriveRunnerView(session("paired"), sidecar("running", { active_runs: 2 }))).toEqual({
      kind: "connected",
      activeRuns: 2,
    });
    expect(deriveRunnerView(session("paired"), sidecar("running", { state: "offline" }))).toEqual({
      kind: "offline",
      restarting: false,
    });
    expect(deriveRunnerView(session("paired"), sidecar("backoff"))).toEqual({
      kind: "offline",
      restarting: true,
    });
  });

  it("暫時連不上 Server 時，正在跑的 sidecar 以它自己的狀態為準", () => {
    expect(
      deriveRunnerView(session("error", "無法確認登入狀態"), sidecar("running", {})).kind,
    ).toBe("connected");
    expect(deriveRunnerView(session("error", "Pairing 失敗"), sidecar("stopped"))).toEqual({
      kind: "error",
      message: "Pairing 失敗",
    });
  });
});

describe("runnerStatusLabel", () => {
  it("顯示連線中、已連線與執行中的 Run 數、離線", () => {
    expect(runnerStatusLabel({ kind: "connecting" })).toBe("連線中");
    expect(runnerStatusLabel({ kind: "connected", activeRuns: 0 })).toBe("已連線");
    expect(runnerStatusLabel({ kind: "connected", activeRuns: 3 })).toBe("已連線・執行中 3 個 Run");
    expect(runnerStatusLabel({ kind: "offline", restarting: false })).toBe("離線");
    expect(runnerStatusLabel({ kind: "offline", restarting: true })).toBe(
      "離線（Runner 重新啟動中）",
    );
  });
});

describe("buildTrayModel", () => {
  it("Runner 版本與 Server 不相容時顯示要更新的提示", () => {
    const view = deriveRunnerView(session("paired"), sidecar("version_mismatch"));
    expect(view).toEqual({ kind: "version_mismatch" });
    expect(runnerStatusLabel(view)).toBe("Runner 版本與 Server 不相容，請更新");
    expect(buildTrayModel({ runner: view, needsYouCount: 0, claimingPaused: false }).tone).toBe(
      "warn",
    );
  });

  it("查得到是哪一邊過舊時，Runner 的狀態與 tooltip 直接說要更新哪個元件", () => {
    const local = { api: 1, protocol: 2 };
    const desktopOld = checkCompatibility(local, { server: "0.2.0", api: 2, protocol: 2 });
    const stopped = buildTrayModel({
      runner: { kind: "version_mismatch" },
      needsYouCount: 0,
      claimingPaused: false,
      compat: desktopOld,
    });
    expect(stopped.statusLabel).toBe("Desktop 版本過舊，請更新 Desktop");
    expect(stopped.items).toContainEqual({
      kind: "label",
      label: "Runner：Desktop 版本過舊，請更新 Desktop",
    });
    // Runner 還在跑（只有 API 版本不同）時，另外加一行提示
    const running = buildTrayModel({
      runner: { kind: "connected", activeRuns: 0 },
      needsYouCount: 0,
      claimingPaused: false,
      compat: checkCompatibility(local, { server: "0.0.1", api: 0, protocol: 2 }),
    });
    expect(running.statusLabel).toBe("已連線");
    expect(running.tone).toBe("warn");
    expect(running.tooltip).toContain("・Server 版本過舊，請更新 Server");
    expect(running.items).toContainEqual({
      kind: "label",
      label: "⚠ Server 版本過舊，請更新 Server",
    });
    // 相容時沒有提示
    const ok = buildTrayModel({
      runner: { kind: "connected", activeRuns: 0 },
      needsYouCount: 0,
      claimingPaused: false,
      compat: { kind: "compatible" },
    });
    expect(ok.tone).toBe("ok");
    expect(ok.items.some((i) => i.kind === "label" && i.label.startsWith("⚠"))).toBe(false);
  });

  it("更新狀態顯示在系統匣，「檢查更新…」依狀態改變文字與可用性", () => {
    const model = buildTrayModel({
      runner: { kind: "connected", activeRuns: 0 },
      needsYouCount: 0,
      claimingPaused: false,
      update: {
        label: "更新 v0.2.0 已下載，結束 App 時安裝",
        action: { label: "立即安裝更新 v0.2.0…", enabled: true },
      },
    });
    expect(model.items).toContainEqual({
      kind: "label",
      label: "更新：更新 v0.2.0 已下載，結束 App 時安裝",
    });
    expect(model.items).toContainEqual({
      kind: "action",
      id: "check-updates",
      label: "立即安裝更新 v0.2.0…",
      enabled: true,
    });
    expect(model.tooltip).toContain("・更新 v0.2.0 已下載");
    // 沒有更新來源時不能按
    const none = buildTrayModel({
      runner: { kind: "signed_out" },
      needsYouCount: 0,
      claimingPaused: false,
    });
    expect(none.items.find((i) => "id" in i && i.id === "check-updates")).toMatchObject({
      enabled: false,
    });
  });

  it("tooltip 帶產品名稱、狀態與 Needs You 數量", () => {
    const model = buildTrayModel({
      runner: { kind: "connected", activeRuns: 1 },
      needsYouCount: 2,
      claimingPaused: true,
    });
    expect(model.tooltip).toBe(
      `${NAMES.productName}：已連線・執行中 1 個 Run・已暫停領取・Needs You 2 項`,
    );
    expect(model.tone).toBe("ok");
    expect(model.items).toContainEqual({
      kind: "checkbox",
      id: "pause-claiming",
      label: "暫停領取新 Run",
      checked: true,
      enabled: true,
    });
    expect(model.items).toContainEqual({ kind: "label", label: "Needs You：2 項" });
  });

  it("沒有登入時不能切換暫停領取", () => {
    const model = buildTrayModel({
      runner: { kind: "signed_out" },
      needsYouCount: 0,
      claimingPaused: true,
    });
    expect(model.tooltip).toBe(`${NAMES.productName}：尚未登入`);
    expect(model.items.find((i) => "id" in i && i.id === "pause-claiming")).toMatchObject({
      enabled: false,
    });
    expect(model.items.map((i) => ("id" in i ? i.id : i.kind))).toEqual([
      "label",
      "label",
      "separator",
      "show-window",
      "pause-claiming",
      "separator",
      "check-updates",
      "open-runner-log",
      "open-settings",
      "separator",
      "quit",
    ]);
  });
});
