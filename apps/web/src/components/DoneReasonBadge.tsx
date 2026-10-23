import type { Task } from "@orbis/api-contract";
import { TASK_DONE_REASON_LABELS } from "../lib/labels";

/** Done 的關閉原因標記（ARCHITECTURE §11）：已完成與不處理以不同標記區分。不是 Done 時不顯示。 */
export function DoneReasonBadge({ task }: { task: Pick<Task, "status" | "doneReason"> }) {
  if (task.status !== "done" || task.doneReason === null) return null;
  return (
    <span className="done-reason" data-done-reason={task.doneReason}>
      {TASK_DONE_REASON_LABELS[task.doneReason]}
    </span>
  );
}
