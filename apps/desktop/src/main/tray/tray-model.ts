// 系統匣要顯示的內容：由登入狀態、sidecar 狀態與 Needs You 數量算出來的純資料，方便測試。

import { NAMES } from "@orbis/api-contract/names";
import type { SessionState } from "../session/session-controller";
import type { SupervisorSnapshot } from "../sidecar/supervisor";

export type RunnerView =
  | { kind: "signed_out" }
  | { kind: "no_team" }
  | { kind: "connecting" }
  | { kind: "connected"; activeRuns: number }
  | { kind: "offline"; restarting: boolean }
  /** Runner 與 Server 的協定版本不相容（SIDECAR_EXIT_VERSION_MISMATCH）。 */
  | { kind: "version_mismatch" }
  | { kind: "error"; message: string };

export function deriveRunnerView(session: SessionState, sidecar: SupervisorSnapshot): RunnerView {
  switch (session.phase) {
    case "signed_out":
      return { kind: "signed_out" };
    case "no_team":
      return { kind: "no_team" };
    case "checking":
    case "pairing":
      return { kind: "connecting" };
    case "error":
      // 已經在跑的 sidecar 以它自己的狀態為準；沒有在跑時才顯示錯誤
      if (sidecar.phase !== "running") return { kind: "error", message: session.error ?? "" };
      break;
    case "paired":
      break;
  }
  switch (sidecar.phase) {
    case "running": {
      const status = sidecar.status;
      if (!status || status.state === "connecting") return { kind: "connecting" };
      if (status.state === "connected")
        return { kind: "connected", activeRuns: status.active_runs };
      return { kind: "offline", restarting: false };
    }
    case "backoff":
      return { kind: "offline", restarting: true };
    case "needs_pairing":
      return { kind: "connecting" };
    case "version_mismatch":
      return { kind: "version_mismatch" };
    case "stopping":
    case "stopped":
      return { kind: "offline", restarting: false };
  }
}

/** Runner 版本不相容時，系統匣與視窗顯示的提示。 */
export const VERSION_MISMATCH_MESSAGE = "Runner 版本與 Server 不相容，請更新";

export function runnerStatusLabel(view: RunnerView): string {
  switch (view.kind) {
    case "signed_out":
      return "尚未登入";
    case "no_team":
      return "尚未加入 Team";
    case "connecting":
      return "連線中";
    case "connected":
      return view.activeRuns > 0 ? `已連線・執行中 ${view.activeRuns} 個 Run` : "已連線";
    case "offline":
      return view.restarting ? "離線（Runner 重新啟動中）" : "離線";
    case "version_mismatch":
      return VERSION_MISMATCH_MESSAGE;
    case "error":
      return `錯誤：${view.message}`;
  }
}

/** 系統匣圖示的顏色。 */
export type TrayTone = "idle" | "busy" | "ok" | "warn";

export function trayTone(view: RunnerView): TrayTone {
  switch (view.kind) {
    case "connected":
      return "ok";
    case "connecting":
      return "busy";
    case "offline":
    case "error":
    case "version_mismatch":
      return "warn";
    default:
      return "idle";
  }
}

export type TrayMenuId =
  | "show-window"
  | "pause-claiming"
  | "open-runner-log"
  | "open-settings"
  | "quit";

export type TrayMenuItem =
  | { kind: "label"; label: string }
  | { kind: "separator" }
  | { kind: "action"; id: TrayMenuId; label: string; enabled: boolean }
  | { kind: "checkbox"; id: TrayMenuId; label: string; checked: boolean; enabled: boolean };

export interface TrayModel {
  tooltip: string;
  tone: TrayTone;
  statusLabel: string;
  needsYouCount: number;
  items: TrayMenuItem[];
}

export interface TrayInput {
  runner: RunnerView;
  needsYouCount: number;
  claimingPaused: boolean;
}

export function buildTrayModel(input: TrayInput): TrayModel {
  const statusLabel = runnerStatusLabel(input.runner);
  const signedIn = input.runner.kind !== "signed_out" && input.runner.kind !== "no_team";
  const needsYou = input.needsYouCount > 0 ? `・Needs You ${input.needsYouCount} 項` : "";
  const paused = input.claimingPaused && signedIn ? "・已暫停領取" : "";
  return {
    tooltip: `${NAMES.productName}：${statusLabel}${paused}${needsYou}`,
    tone: trayTone(input.runner),
    statusLabel,
    needsYouCount: input.needsYouCount,
    items: [
      { kind: "label", label: `Runner：${statusLabel}` },
      { kind: "label", label: `Needs You：${input.needsYouCount} 項` },
      { kind: "separator" },
      { kind: "action", id: "show-window", label: "顯示視窗", enabled: true },
      {
        kind: "checkbox",
        id: "pause-claiming",
        label: "暫停領取新 Run",
        checked: input.claimingPaused,
        enabled: signedIn,
      },
      { kind: "separator" },
      { kind: "action", id: "open-runner-log", label: "開啟 Runner log", enabled: true },
      { kind: "action", id: "open-settings", label: "設定…", enabled: true },
      { kind: "separator" },
      { kind: "action", id: "quit", label: `結束 ${NAMES.productName}`, enabled: true },
    ],
  };
}
