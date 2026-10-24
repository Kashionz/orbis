// 建立 Task：先建 Task，再依序建立 Acceptance Criterion；條件齊備時轉 Ready（ARCHITECTURE §5）。

import { Task } from "@orbis/api-contract";
import { apiRequest } from "../../api/client";
import { createAcceptanceCriterion, createTask, transitionTask } from "../../api/resources";
import { filledCriteria, missingRequirements, type NewTaskForm } from "./new-task-form";

/**
 * TODO(backend, task-without-repo)：CreateTaskInput 的 repoId 是必填。後端支援不指定 Repo 之前，
 * 只有 mock 提供這個暫定的路徑（lib/features.ts 的 `taskWithoutRepo`）。
 */
export const TASK_WITHOUT_REPO_PATH = "/api/projects/:projectId/tasks-without-repo";

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
  const task = form.repoId
    ? await createTask(projectId, { ...input, repoId: form.repoId })
    : await apiRequest(
        TASK_WITHOUT_REPO_PATH.replace(":projectId", encodeURIComponent(projectId)),
        Task,
        { method: "POST", body: input },
      );
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
