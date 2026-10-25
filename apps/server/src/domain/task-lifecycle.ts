// Task 狀態的唯一寫入點。每次轉換都先經過狀態機檢查，再以「狀態仍是 from」為條件更新，
// 避免兩個請求同時轉換同一個 Task。commit 後發出 task.status_changed。

import type { READY_REQUIREMENTS, TaskDoneReason, TaskStatus } from "@orbis/api-contract";
import { and, count, eq } from "drizzle-orm";
import { acceptanceCriteria, tasks } from "../db/schema";
import type { Executor, UnitOfWork } from "../db/tx";
import { ApiError, notFound } from "../http/errors";
import type { ChangeSource, DomainEvent, DomainEvents } from "./events";
import { findTransition, type TransitionTrigger } from "./task-state-machine";

export type TaskRow = typeof tasks.$inferSelect;

export type ReadyRequirement = (typeof READY_REQUIREMENTS)[number];

export class TaskLifecycleService {
  constructor(private readonly events: DomainEvents) {}

  /**
   * 把 Task 轉到 `to`。不合法的轉換丟出 409 `invalid_transition`；
   * 手動轉成 Ready 時另外檢查 Spec 與 Acceptance Criterion 是否齊備。
   * 轉成 Done 時記下關閉原因（預設 `completed`）；離開 Done 時清空。
   */
  async transition(
    uow: UnitOfWork,
    taskId: string,
    to: TaskStatus,
    trigger: TransitionTrigger,
    options: {
      doneReason?: TaskDoneReason;
      /** domain event 的來源，預設 `system`（手動轉換由路由傳 `api`）。 */
      source?: ChangeSource;
      actorMemberId?: string | null;
    } = {},
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
        // 沒有 Repo 的 Task 只能停在 Backlog（ADR-0011 的修訂），以專用代碼表示；其他條件不足沿用 invalid_transition。
        throw new ApiError(
          409,
          missing.includes("repo") ? "repo_required" : "invalid_transition",
          `還不能進入 Ready：${missing.map((m) => READY_REQUIREMENT_LABELS[m]).join("、")}`,
          {
            from: task.status,
            to,
            trigger,
            missing,
          },
        );
      }
    }
    const [updated] = await tx
      .update(tasks)
      .set({ status: to, doneReason: to === "done" ? (options.doneReason ?? "completed") : null })
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
        source: options.source ?? "system",
        actorMemberId: options.actorMemberId ?? null,
      }),
    );
    return updated;
  }

  /** 發出 domain event（給同一層的服務在 commit 後使用）。 */
  emit(event: DomainEvent): Promise<void> {
    return this.events.emit(event);
  }

  /**
   * 派工：Ready → Planning。Plan Gate 開啟時停在 Planning，等 Runner 送出 plan；
   * 關閉時直接轉到 Running（ARCHITECTURE §5）。
   */
  async startRun(
    uow: UnitOfWork,
    taskId: string,
    options: { planGate: boolean },
  ): Promise<TaskRow> {
    const planning = await this.transition(uow, taskId, "planning", "dispatch");
    if (options.planGate) return planning;
    return this.transition(uow, taskId, "running", "planning");
  }
}

/** Task 的 Plan Gate 是否開啟：Task 的覆寫優先，否則看 Project 的設定。 */
export function planGateEnabled(
  task: Pick<TaskRow, "planGateEnabled">,
  project: { planGateEnabled: boolean },
): boolean {
  return task.planGateEnabled ?? project.planGateEnabled;
}

/** 每個 Ready 條件給人看的說明。 */
const READY_REQUIREMENT_LABELS: Record<ReadyRequirement, string> = {
  repo: "尚未指定 Repo",
  description: "沒有描述或 Spec",
  acceptance_criteria: "沒有 Acceptance Criterion",
};

/**
 * Ready 的進入條件：已有 Repo、描述不為空或連結了 Spec、至少一條 Acceptance Criterion。
 * 回傳缺少的條件（契約的 READY_REQUIREMENTS）。
 */
export async function readinessProblems(tx: Executor, task: TaskRow): Promise<ReadyRequirement[]> {
  const problems: ReadyRequirement[] = [];
  if (!task.repoId) problems.push("repo");
  if (task.description.trim() === "" && !task.repoSpecId) problems.push("description");
  const [row] = await tx
    .select({ n: count() })
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, task.id));
  if ((row?.n ?? 0) === 0) problems.push("acceptance_criteria");
  return problems;
}
