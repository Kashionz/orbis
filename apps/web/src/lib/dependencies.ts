// depends_on 的規則（ARCHITECTURE §5）：依賴中還有 Task 沒有 Done 時不能派工。

import type { Task } from "@orbis/api-contract";

/** `task` 依賴、但還沒有 Done 的 Task。不在 `tasks` 中的依賴（例如已刪除）不算。 */
export function unfinishedDependencies(
  task: Pick<Task, "dependsOn">,
  tasks: readonly Task[],
): Task[] {
  return task.dependsOn
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined && t.status !== "done");
}
