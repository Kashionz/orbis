import { NAMES } from "@orbis/api-contract/names";
import { describe, expect, it } from "vitest";
import type { SessionState } from "../session/session-controller";
import type { SupervisorSnapshot } from "../sidecar/supervisor";
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
      "open-runner-log",
      "open-settings",
      "separator",
      "quit",
    ]);
  });
});
