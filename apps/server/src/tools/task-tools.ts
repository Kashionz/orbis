// 與 Task 有關的 Orbis MCP 工具（ARCHITECTURE §9）：
// - `propose_tasks`：提出 Draft Task（同一次呼叫一批），經人確認後才進入 Backlog。
// - `update_task_note`：在 Task 上留下進度或決策紀錄（記下來源 Run）；寫在其他 Task 時依派工的人在那個
//   Task 上的權限。
// 兩者都不會改動既有 Task 的狀態、指派對象與 Acceptance Criterion。

import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { roleAtLeast } from "../authz/capabilities";
import { memberOnTask } from "../authz/task-access";
import type { Database } from "../db/client";
import { draftTasks, taskNotes, tasks } from "../db/schema";
import { ToolError, type ToolHandlers } from "./service";

/** Draft Task 的依賴：同一批的 `#<n>`，或既有的 Task Key（同 api-contract 的 DraftDependency）。 */
const DEPENDENCY = /^(#[1-9][0-9]*|[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*)$/;

export function taskToolHandlers(db: Database): ToolHandlers {
  return {
    propose_tasks: async (context, call) => {
      const batchId = uuidv7();
      const rows = call.tasks.map((proposed, index) => {
        for (const dependency of proposed.depends_on) {
          if (!DEPENDENCY.test(dependency)) {
            throw new ToolError("invalid_state", `依賴必須是 #<n> 或 Task Key：${dependency}`);
          }
          if (dependency.startsWith("#")) {
            const n = Number(dependency.slice(1));
            if (n > call.tasks.length || n === index + 1) {
              throw new ToolError(
                "invalid_state",
                `第 ${index + 1} 個 Task 的依賴 ${dependency} 不存在`,
              );
            }
          }
        }
        for (const criterion of proposed.acceptance_criteria) {
          if (criterion.kind !== "command" && criterion.command !== null) {
            throw new ToolError("invalid_state", "只有 command 類型的條件可以有指令");
          }
        }
        return {
          projectId: context.task.projectId,
          proposedByRunId: context.caller.id,
          repoId: context.task.repoId,
          spec: call.spec,
          title: proposed.title,
          description: proposed.description,
          acceptanceCriteria: proposed.acceptance_criteria,
          dependsOn: proposed.depends_on,
          batchId,
          position: index + 1,
        };
      });
      const created = await db.insert(draftTasks).values(rows).returning({ id: draftTasks.id });
      return { tool: "propose_tasks", draft_task_ids: created.map((r) => r.id) };
    },

    update_task_note: async (context, call) => {
      let taskId = context.task.id;
      if (call.task !== null && call.task !== context.task.key) {
        // 只能寫在同一個 Project、派工的人在上面能操作的 Task 上（ADR-0012）。派工的人看不到的 Task
        // 和不存在的 Task 一樣回 not_found，不透露它是否存在。
        const notFound = new ToolError("not_found", `這個 Project 沒有 Task ${call.task}`);
        const [other] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.projectId, context.task.projectId), eq(tasks.key, call.task)));
        const requester = context.caller.requestedByMemberId;
        if (!other || !requester) throw notFound;
        const access = await memberOnTask(db, other.id, requester);
        if (!access) throw notFound;
        if (!roleAtLeast(access.taskRole, "member")) {
          throw new ToolError("invalid_state", `派工的人在 Task ${call.task} 上只能檢視，不能寫入`);
        }
        taskId = other.id;
      }
      const [note] = await db
        .insert(taskNotes)
        .values({ taskId, runId: context.caller.id, source: "agent", body: call.note })
        .returning({ id: taskNotes.id });
      if (!note) throw new Error("建立 Task note 失敗");
      return { tool: "update_task_note", note_id: note.id };
    },
  };
}
