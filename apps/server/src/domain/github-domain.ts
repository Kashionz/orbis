// 給 D 軌（packages/github）呼叫的 domain service：webhook 觸發的 Task 狀態轉換，以及 Issue 同步的讀寫。
// D 軌只透過這個介面寫入 Task，不直接碰資料表；每次寫入都會發出 domain event
//（task.updated 帶 `source: "github"`，D 軌據此避免同步回音）。

import type { TaskStatus } from "@orbis/api-contract";
import { and, count, eq, notInArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { members, projects, runs, tasks } from "../db/schema";
import { inTransaction } from "../db/tx";
import { ApiError } from "../http/errors";
import { TERMINAL_RUN_STATUSES } from "./run-status";
import type { TaskLifecycleService, TaskRow } from "./task-lifecycle";

export type GitHubTransitionResult =
  | { ok: true; task: TaskRow }
  | {
      ok: false;
      reason: "not_found" | "invalid_transition" | "active_run";
      message: string;
      /** Task 目前的狀態；找不到 Task 時為 null。 */
      status: TaskStatus | null;
    };

/** Issue 同步可以寫入的欄位（ARCHITECTURE §11）。state 另外以狀態轉換處理。 */
export interface IssueFields {
  title?: string;
  description?: string;
  labels?: string[];
  assigneeMemberId?: string | null;
}

export class GitHubDomainService {
  constructor(
    private readonly db: Database,
    private readonly lifecycle: TaskLifecycleService,
  ) {}

  async getTask(taskId: string): Promise<TaskRow | null> {
    const [task] = await this.db.select().from(tasks).where(eq(tasks.id, taskId));
    return task ?? null;
  }

  /** 依 GitHub 數字 user id 找出 Task 所在 Team 的 Member（Issue 的 assignee 對應用）。 */
  async findMemberForTask(taskId: string, githubUserId: number): Promise<string | null> {
    const [row] = await this.db
      .select({ id: members.id })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(members, eq(members.teamId, projects.teamId))
      .where(and(eq(tasks.id, taskId), eq(members.githubUserId, githubUserId)));
    return row?.id ?? null;
  }

  /** PR 已 merge：PR Open → Done。 */
  onPullRequestMerged(taskId: string): Promise<GitHubTransitionResult> {
    return this.transition(taskId, "done");
  }

  /** PR 沒有 merge 就關閉：PR Open → Review Gate。 */
  onPullRequestClosedUnmerged(taskId: string): Promise<GitHubTransitionResult> {
    return this.transition(taskId, "review_gate");
  }

  /** Issue 關閉：Task 轉成 Done；Task 有進行中的 Run 時拒絕（D 軌重開 Issue 並說明）。 */
  async onIssueClosed(taskId: string): Promise<GitHubTransitionResult> {
    const [active] = await this.db
      .select({ n: count() })
      .from(runs)
      .where(and(eq(runs.taskId, taskId), notInArray(runs.status, TERMINAL_RUN_STATUSES)));
    if ((active?.n ?? 0) > 0) {
      const task = await this.getTask(taskId);
      return {
        ok: false,
        reason: "active_run",
        message: "Task 還有進行中的 Run，不能轉成 Done",
        status: task?.status ?? null,
      };
    }
    return this.transition(taskId, "done");
  }

  /** Issue 重開：已 Done 的 Task 回到 Backlog。 */
  onIssueReopened(taskId: string): Promise<GitHubTransitionResult> {
    return this.transition(taskId, "backlog");
  }

  /** 把 Issue 上的變更寫回 Task。 */
  async applyIssueFields(taskId: string, fields: IssueFields): Promise<TaskRow | null> {
    const changes: Partial<typeof tasks.$inferInsert> = {};
    if (fields.title !== undefined) changes.title = fields.title;
    if (fields.description !== undefined) changes.description = fields.description;
    if (fields.labels !== undefined) changes.labels = fields.labels;
    if (fields.assigneeMemberId !== undefined) changes.assigneeMemberId = fields.assigneeMemberId;
    if (Object.keys(changes).length === 0) return this.getTask(taskId);
    return inTransaction(this.db, async (uow) => {
      const [task] = await uow.tx
        .update(tasks)
        .set(changes)
        .where(eq(tasks.id, taskId))
        .returning();
      if (!task) return null;
      uow.afterCommit(() =>
        this.lifecycle.emit({
          type: "task.updated",
          taskId,
          projectId: task.projectId,
          fields: Object.keys(changes),
          source: "github",
        }),
      );
      return task;
    });
  }

  private async transition(taskId: string, to: TaskStatus): Promise<GitHubTransitionResult> {
    try {
      const task = await inTransaction(this.db, (uow) =>
        this.lifecycle.transition(uow, taskId, to, "github"),
      );
      return { ok: true, task };
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "not_found" || error.code === "invalid_transition")
      ) {
        const task = await this.getTask(taskId);
        return {
          ok: false,
          reason: error.code,
          message: error.message,
          status: task?.status ?? null,
        };
      }
      throw error;
    }
  }
}
