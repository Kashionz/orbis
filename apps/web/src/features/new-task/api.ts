// 建立 Task：先建 Task，再依序建立 Acceptance Criterion；條件齊備時轉 Ready（ARCHITECTURE §5）。

import type { Task } from "@orbis/api-contract";
import { createAcceptanceCriterion, createTask, transitionTask } from "../../api/resources";
import { filledCriteria, missingRequirements, type NewTaskForm } from "./new-task-form";

export interface CreatedTask {
  task: Task;
  /** 建立 Task 之後的步驟（條件、轉 Ready）失敗時的錯誤；Task 本身已經建立。 */
  followUpError: unknown;
}

export async function createTaskFromForm(
  projectId: string,
  form: NewTaskForm,
): Promise<CreatedTask> {
  const input = {
    title: form.title.trim(),
    description: form.description.trim(),
    assigneeMemberId: form.assigneeMemberId,
    dependsOn: form.dependsOn ? [form.dependsOn] : [],
  };
  // 可以不指定 Repo（ADR-0011 的修訂）：這種 Task 停在待辦，之後補指定一次
  const task = await createTask(projectId, { ...input, repoId: form.repoId });
  try {
    for (const [position, criterion] of filledCriteria(form).entries()) {
      await createAcceptanceCriterion(task.id, {
        kind: criterion.kind,
        description: criterion.description.trim(),
        command: criterion.kind === "command" ? criterion.command.trim() || null : null,
        position,
      });
    }
    if (missingRequirements(form).length === 0) {
      return { task: await transitionTask(task.id, "ready"), followUpError: null };
    }
    return { task, followUpError: null };
  } catch (error) {
    return { task, followUpError: error };
  }
}
