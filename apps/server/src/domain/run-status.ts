// Run 狀態的分類。

import type { RunStatus } from "@orbis/api-contract";

/** 終止狀態：之後不會再有狀態變更。與協定的 RunStatus::is_terminal 一致。 */
export const TERMINAL_RUN_STATUSES: RunStatus[] = ["completed", "failed", "canceled"];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}
