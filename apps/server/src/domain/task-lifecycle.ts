// Task 狀態的唯一寫入點。每次轉換都先經過狀態機檢查，再以「狀態仍是 from」為條件更新，
// 避免兩個請求同時轉換同一個 Task。commit 後發出 task.status_changed。

import type { TaskStatus } from "@orbis/api-contract";
import { and, count, eq } from "drizzle-orm";
import { acceptanceCriteria, tasks } from "../db/schema";
import type { Executor, UnitOfWork } from "../db/tx";
import { ApiError, notFound } from "../http/errors";
import type { DomainEvent, DomainEvents } from "./events";
import { findTransition, type TransitionTrigger } from "./task-state-machine";

export type TaskRow = typeof tasks.$inferSelect;

/**
 * Planning 與 Verification 的掛鉤。B1 一律「直接通過」；B2 換成真正的流程
 * （產出 plan 後進 Plan Gate、依 Acceptance Criterion 做 Verification）。
 */
export interface LifecycleHooks {
  /** 派工後是否直接跳過 Planning。回傳 false 時 Task 停在 Planning，等 Runner 回報 plan。 */
  planningPassesImmediately(task: TaskRow): boolean;
  /** Agent 回報完成後是否直接通過 Verification。回傳 false 時 Task 停在 Verifying。 */
  verificationPassesImmediately(task: TaskRow): boolean;
}

export const PASS_THROUGH_HOOKS: LifecycleHooks = {
  planningPassesImmediately: () => true,
  verificationPassesImmediately: () => true,
};

export class TaskLifecycleService {
  constructor(
    private readonly events: DomainEvents,
    private readonly hooks: LifecycleHooks = PASS_THROUGH_HOOKS,
  ) {}

  /**
   * 把 Task 轉到 `to`。不合法的轉換丟出 409 `invalid_transition`；
   * 手動轉成 Ready 時另外檢查 Spec 與 Acceptance Criterion 是否齊備。
   */
  async transition(
    uow: UnitOfWork,
    taskId: string,
    to: TaskStatus,
    trigger: TransitionTrigger,
  ): Promise<TaskRow> {
    const { tx } = uow;
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (!task) throw notFound("Task");
    const transition = findTransition(task.status, to, trigger);
    if (!transition) {
      throw new ApiError(
        409,
        "invalid_transition",
        `Task 不能從 ${task.status} 轉換到 ${to}（觸發來源：${trigger}）`,
        { from: task.status, to, trigger },
      );
    }
    if (task.status === "backlog" && to === "ready") {
      const missing = await readinessProblems(tx, task);
      if (missing.length > 0) {
        throw new ApiError(409, "invalid_transition", `還不能進入 Ready：${missing.join("、")}`, {
          from: task.status,
          to,
          trigger,
          missing,
        });
      }
    }
    const [updated] = await tx
      .update(tasks)
      .set({ status: to })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status)))
      .returning();
    if (!updated) throw new ApiError(409, "conflict", "Task 狀態已被其他操作改變，請重試");
    uow.afterCommit(() =>
      this.events.emit({
        type: "task.status_changed",
        taskId,
        projectId: task.projectId,
        from: task.status,
        to,
        trigger,
      }),
    );
    return updated;
  }

  /** 發出 domain event（給同一層的服務在 commit 後使用）。 */
  emit(event: DomainEvent): Promise<void> {
    return this.events.emit(event);
  }

  /** 派工：Ready → Planning，Planning 直接通過時再轉到 Running。 */
  async startRun(uow: UnitOfWork, taskId: string): Promise<TaskRow> {
    const planning = await this.transition(uow, taskId, "planning", "dispatch");
    if (!this.hooks.planningPassesImmediately(planning)) return planning;
    return this.transition(uow, taskId, "running", "planning");
  }

  /** Agent 回報完成：Running → Verifying，Verification 直接通過時再轉到 Review Gate。 */
  async agentFinished(uow: UnitOfWork, taskId: string): Promise<TaskRow> {
    const verifying = await this.transition(uow, taskId, "verifying", "run");
    if (!this.hooks.verificationPassesImmediately(verifying)) return verifying;
    return this.transition(uow, taskId, "review_gate", "verification");
  }
}

/** Ready 的進入條件：已有 Repo、描述不為空或連結了 Spec、至少一條 Acceptance Criterion。 */
export async function readinessProblems(tx: Executor, task: TaskRow): Promise<string[]> {
  const problems: string[] = [];
  if (!task.repoId) problems.push("尚未指定 Repo");
  if (task.description.trim() === "" && !task.repoSpecId) problems.push("沒有描述或 Spec");
  const [row] = await tx
    .select({ n: count() })
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, task.id));
  if ((row?.n ?? 0) === 0) problems.push("沒有 Acceptance Criterion");
  return problems;
}
