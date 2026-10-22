// Task 狀態的手動轉換（ARCHITECTURE §5）：看板上只能把 Task 在 Backlog 與 Ready 之間移動。
// 其他轉換由系統觸發（派工、Runner 的 Event、Gate 的決定、GitHub webhook），定義在 Server 的狀態機。
// Server 的 transition API 與 Web 的拖曳都以這張表為準。

import type { TaskStatus } from "./enums";

export const MANUAL_TASK_TRANSITIONS = {
  backlog: ["ready"],
  ready: ["backlog"],
  planning: [],
  plan_gate: [],
  running: [],
  verifying: [],
  review_gate: [],
  pr_open: [],
  done: [],
} as const satisfies Readonly<Record<TaskStatus, readonly TaskStatus[]>>;

/** 是否可以在看板上手動把 Task 從 `from` 移到 `to`。 */
export function canTransitionManually(from: TaskStatus, to: TaskStatus): boolean {
  return (MANUAL_TASK_TRANSITIONS[from] as readonly TaskStatus[]).includes(to);
}
