// 待我處理（純函式）：依類型分組，每一列要前往的位置。

import type { NeedsYouItem, NeedsYouStoppedRun } from "@orbis/api-contract";
import type { Messages } from "../../i18n";
import { VERIFICATION_FOCUS, type WorkspaceTab } from "../run/workspace/route-state";

/** 分組的順序：權限請求、計畫關卡、審查關卡、停下來的 Run、Child Run 的問題。 */
export const NEEDS_YOU_GROUPS = [
  "permission",
  "plan_gate",
  "review_gate",
  "stopped_run",
  "child_question",
] as const;
export type NeedsYouGroupKind = (typeof NEEDS_YOU_GROUPS)[number];

export function groupOf(item: NeedsYouItem): NeedsYouGroupKind {
  switch (item.kind) {
    case "permission_request":
      return "permission";
    case "gate":
      return item.gateKind === "plan" ? "plan_gate" : "review_gate";
    case "stopped_run":
      return "stopped_run";
    case "child_question":
      return "child_question";
  }
}

export interface NeedsYouGroup {
  kind: NeedsYouGroupKind;
  items: NeedsYouItem[];
}

/** 依類型分組，組內維持 Server 的順序（新的在前）；沒有項目的組不列。 */
export function groupNeedsYou(items: readonly NeedsYouItem[]): NeedsYouGroup[] {
  return NEEDS_YOU_GROUPS.map((kind) => ({
    kind,
    items: items.filter((item) => groupOf(item) === kind),
  })).filter((group) => group.items.length > 0);
}

/** 前往處理的位置：Task 的工作區，指定 Run、分頁與捲動目標。 */
export interface NeedsYouTarget {
  taskKey: string;
  run: string;
  tab?: WorkspaceTab;
  focus?: string;
}

export function targetOf(item: NeedsYouItem): NeedsYouTarget {
  const base = { taskKey: item.taskKey, run: item.runId };
  switch (item.kind) {
    case "permission_request":
      return { ...base, focus: `permission-${item.permissionRequestId}` };
    case "gate":
      return item.gateKind === "review" ? { ...base, tab: "diff" } : base;
    case "stopped_run":
      // Verification 超過重試上限：決定的表單在 Task 分頁的驗收
      return { ...base, tab: "task", focus: VERIFICATION_FOCUS };
    case "child_question":
      return { ...base, run: item.childRunId };
  }
}

/** 停下來的 Run 的說明：依代碼在地化的原因，有原始的錯誤訊息時接在後面。 */
export function stoppedRunSummary(item: NeedsYouStoppedRun, n: Messages["needsYou"]): string {
  const reason =
    item.reasonCode === "verification_limit"
      ? n.stoppedReason.verification_limit(item.attempt)
      : n.stoppedReason[item.reasonCode];
  return item.detail ? n.stoppedWithDetail(reason, item.detail) : reason;
}
