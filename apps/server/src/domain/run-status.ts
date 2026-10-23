// Run 狀態的分類。終止狀態沿用協定的定義（RunStatus::is_terminal）。

import type { RunStatus } from "@orbis/api-contract";
import { TERMINAL_RUN_STATUSES as PROTOCOL_TERMINAL, RUN_STATUSES } from "@orbis/protocol";

/** 終止狀態：之後不會再有狀態變更。 */
export const TERMINAL_RUN_STATUSES: RunStatus[] = [...PROTOCOL_TERMINAL];

/** 還沒結束的狀態。 */
export const NON_TERMINAL_RUN_STATUSES: RunStatus[] = RUN_STATUSES.filter(
  (status) => !TERMINAL_RUN_STATUSES.includes(status),
);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * 主 Run：推動 Task 生命週期的 Run（人派工的 Run，以及 Feedback Loop 接續的 Run）。
 * Child Run、判定 Verification 與 @agent 的 consult Run 都不會改變 Task 的狀態。
 */
export function isPrimaryRun(run: {
  parentRunId: string | null;
  origin: "dispatch" | "delegation" | "verification" | "mention" | "feedback_loop";
}): boolean {
  return run.parentRunId === null && (run.origin === "dispatch" || run.origin === "feedback_loop");
}
