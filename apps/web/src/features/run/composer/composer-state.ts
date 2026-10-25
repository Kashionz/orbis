// 輸入框的狀態（純函式）：dock 顯示什麼待處理的動作、送出鍵做什麼。
//
// 送出鍵依 Run 的狀態決定（協調者 Q2）：
// - 計畫關卡：退回並附上意見。
// - 審查關卡：把文字當整體說明退回。
// - Verification 超過重試上限：附意見再試。
// - 執行中：傳訊息給 Agent（回合中或等待權限回覆時排隊，回合結束後送出；也可以中斷後送出）。
//   還沒開始、Verification 中不接受（Server 回 `run_not_accepting_prompts`）。
// - Run 已結束：停用。

import type { GateKind, RunStatus } from "@orbis/protocol";
import { TERMINAL_RUN_STATUSES } from "@orbis/protocol";

export interface PendingPermission {
  /** 時間軸項目的 key（跳到請求用）。 */
  key: string;
  title: string;
  detail: string | null;
}

export interface ComposerSituation {
  status: RunStatus;
  gate: GateKind | null;
  /** 最早一筆還沒回覆的權限請求。 */
  pendingPermission: PendingPermission | null;
  /** 這個 Run 有等待決定的 Plan Gate。 */
  planGatePending: boolean;
  /** 這個 Run 有等待決定的 Review Gate（Verification 進行中時也會有）。 */
  reviewGatePending: boolean;
  /** Verification 超過重試上限，等人決定。 */
  verificationAwaitingDecision: boolean;
}

export type DockState =
  | { kind: "permission"; permission: PendingPermission }
  | { kind: "review_gate" }
  | { kind: "plan_gate" }
  | { kind: "verification_decision" };

/** 審查關卡：Run 停在 Review Gate，而且不在 Verification 中。 */
export function atReviewGate(s: ComposerSituation): boolean {
  return s.reviewGatePending && s.status === "awaiting_gate" && s.gate === "review";
}

export function atPlanGate(s: ComposerSituation): boolean {
  return s.planGatePending && s.status === "awaiting_gate" && s.gate === "plan";
}

/** dock 顯示的待處理動作，依優先順序：權限請求、審查關卡、計畫關卡、驗收的決定。 */
export function dockFor(s: ComposerSituation): DockState | null {
  if (s.pendingPermission) return { kind: "permission", permission: s.pendingPermission };
  if (atReviewGate(s)) return { kind: "review_gate" };
  if (atPlanGate(s)) return { kind: "plan_gate" };
  if (s.verificationAwaitingDecision) return { kind: "verification_decision" };
  return null;
}

export type SendAction = "plan_reject" | "review_reject" | "verification_retry" | "prompt";

/** 送出鍵為什麼不能用。 */
export type SendBlocker = "finished" | "forbidden" | "not_accepting";

/** 可以傳訊息給 Agent 的 Run 狀態（其他狀態 Server 回 `run_not_accepting_prompts`）。 */
const ACCEPTS_PROMPT: readonly RunStatus[] = [
  "starting",
  "running",
  "awaiting_permission",
  "rate_limited",
];

export interface SendCapabilities {
  /** 能退回 Gate（`gate.reject`）。 */
  reject: boolean;
  /** 能控制 Run（`run.control`）：Verification 的決定、傳訊息。 */
  control: boolean;
}

export interface SendState {
  action: SendAction;
  /** 可以送出時為 null。 */
  blocker: SendBlocker | null;
}

export function sendStateFor(s: ComposerSituation, can: SendCapabilities): SendState {
  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(s.status)) {
    return { action: "prompt", blocker: "finished" };
  }
  if (atPlanGate(s)) return { action: "plan_reject", blocker: can.reject ? null : "forbidden" };
  if (atReviewGate(s)) {
    return { action: "review_reject", blocker: can.reject ? null : "forbidden" };
  }
  if (s.verificationAwaitingDecision) {
    return { action: "verification_retry", blocker: can.control ? null : "forbidden" };
  }
  if (!can.control) return { action: "prompt", blocker: "forbidden" };
  return { action: "prompt", blocker: ACCEPTS_PROMPT.includes(s.status) ? null : "not_accepting" };
}
