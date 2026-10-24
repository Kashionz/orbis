import type { Task } from "@orbis/api-contract";
import { useT } from "../i18n";

/** Done 的關閉原因標記（ARCHITECTURE §11）：已完成與不處理以不同標記區分。不是 Done 時不顯示。 */
export function DoneReasonBadge({ task }: { task: Pick<Task, "status" | "doneReason"> }) {
  const t = useT();
  if (task.status !== "done" || task.doneReason === null) return null;
  return (
    <span className="done-reason" data-done-reason={task.doneReason}>
      {t.labels.taskDoneReason[task.doneReason]}
    </span>
  );
}
