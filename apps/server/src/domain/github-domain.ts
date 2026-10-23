// packages/github 的 DomainService 的 Server 實作：GitHub 整合只透過這個介面讀寫 Task、Repo、Member。
//
// - 寫入一律經過 Task 狀態機（TaskLifecycleService），並在 commit 後發出 domain event，
//   `source: "github"` 讓 Server 不再對同一個變更呼叫 onTaskChanged（避免同步回音）。
// - 由 GitHub 觸發的狀態轉換：Issue 關閉／PR merge → Done（有進行中的 Run 時拒絕）、
//   Issue 重開 → Backlog、PR 沒 merge 就關閉 → Review Gate、PR 重開 → PR Open。

import {
  formatTaskKey,
  parseMentions,
  replaceMentions,
  type TaskStatus,
} from "@orbis/api-contract";
import type {
  AcceptanceCriterionRecord,
  DomainService,
  MemberRecord,
  RepoRecord,
  RunSummary,
  TaskFieldsPatch,
  TaskRecord,
  TransitionCause,
  TransitionResult,
} from "@orbis/github";
import { and, asc, count, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { authorize, effectiveRole } from "../authz/capabilities";
import type { Database } from "../db/client";
import {
  acceptanceCriteria,
  members,
  projectMemberRoles,
  projects,
  repoSpecs,
  repos,
  runs,
  tasks,
} from "../db/schema";
import { type Executor, inTransaction } from "../db/tx";
import { ApiError, notFound } from "../http/errors";
import { TERMINAL_RUN_STATUSES } from "./run-status";
import type { TaskLifecycleService, TaskRow } from "./task-lifecycle";

type RepoRow = typeof repos.$inferSelect;

const toRepoRecord = (row: RepoRow): RepoRecord => ({
  id: row.id,
  projectId: row.projectId,
  owner: row.githubOwner,
  name: row.githubName,
  githubRepoId: row.githubRepoId,
  defaultBranch: row.defaultBranch,
  installationId: row.githubInstallationId,
});

const toMemberRecord = (row: typeof members.$inferSelect): MemberRecord => ({
  id: row.id,
  githubUserId: row.githubUserId,
  githubLogin: row.githubLogin,
});

export class GitHubDomainService implements DomainService {
  constructor(
    private readonly db: Database,
    private readonly lifecycle: TaskLifecycleService,
  ) {}

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const [row] = await this.db
      .select({ task: tasks, specPath: repoSpecs.path })
      .from(tasks)
      .leftJoin(repoSpecs, eq(repoSpecs.id, tasks.repoSpecId))
      .where(eq(tasks.id, taskId));
    return row ? this.toTaskRecord(row.task, row.specPath) : null;
  }

  private async toTaskRecord(row: TaskRow, specPath: string | null): Promise<TaskRecord> {
    return {
      id: row.id,
      key: row.key,
      projectId: row.projectId,
      repoId: row.repoId,
      title: row.title,
      description: await this.issueBody(row.description, row.projectId),
      status: row.status,
      doneReason: row.doneReason,
      assigneeMemberId: row.assigneeMemberId,
      createdByMemberId: row.createdByMemberId,
      labels: row.labels,
      specPath,
      updatedAt: row.updatedAt,
    };
  }

  private async taskRecord(row: TaskRow): Promise<TaskRecord> {
    const [spec] = row.repoSpecId
      ? await this.db
          .select({ path: repoSpecs.path })
          .from(repoSpecs)
          .where(eq(repoSpecs.id, row.repoSpecId))
      : [];
    return this.toTaskRecord(row, spec?.path ?? null);
  }

  /**
   * 同步到 GitHub Issue 的 body：Member 的 mention 換成 `@<GitHub login>`；Agent 的 mention
   * 與找不到（或不在這個 Team）的 Member 只留顯示名稱，避免 GitHub 通知到同名的其他帳號。
   */
  private async issueBody(description: string, projectId: string): Promise<string> {
    const memberIds = parseMentions(description).flatMap((m) =>
      m.target.type === "member" ? [m.target.memberId] : [],
    );
    if (memberIds.length === 0) return description;
    const rows = await this.db
      .select({ id: members.id, login: members.githubLogin })
      .from(members)
      .innerJoin(projects, eq(projects.teamId, members.teamId))
      .where(and(eq(projects.id, projectId), inArray(members.id, memberIds)));
    const logins = new Map(rows.map((r) => [r.id, r.login]));
    return replaceMentions(description, (m) => {
      const login = m.target.type === "member" ? logins.get(m.target.memberId) : undefined;
      return login ? `@${login}` : m.label;
    });
  }

  async getRepo(repoId: string): Promise<RepoRecord | null> {
    const [row] = await this.db.select().from(repos).where(eq(repos.id, repoId));
    return row ? toRepoRecord(row) : null;
  }

  async listReposByGithubRepoId(githubRepoId: number): Promise<RepoRecord[]> {
    const rows = await this.db
      .select()
      .from(repos)
      .where(eq(repos.githubRepoId, githubRepoId))
      .orderBy(asc(repos.createdAt), asc(repos.id));
    return rows.map(toRepoRecord);
  }

  async listReposByInstallationId(installationId: number): Promise<RepoRecord[]> {
    const rows = await this.db
      .select()
      .from(repos)
      .where(eq(repos.githubInstallationId, installationId))
      .orderBy(asc(repos.createdAt), asc(repos.id));
    return rows.map(toRepoRecord);
  }

  async listReposByFullName(owner: string, name: string): Promise<RepoRecord[]> {
    const rows = await this.db
      .select()
      .from(repos)
      .where(
        and(
          sql`lower(${repos.githubOwner}) = lower(${owner})`,
          sql`lower(${repos.githubName}) = lower(${name})`,
        ),
      )
      .orderBy(asc(repos.createdAt), asc(repos.id));
    return rows.map(toRepoRecord);
  }

  async updateRepoGitHubInfo(
    repoId: string,
    info: { installationId?: number | null; githubRepoId?: number; defaultBranch?: string },
  ): Promise<void> {
    const changes: Partial<typeof repos.$inferInsert> = {};
    if (info.installationId !== undefined) changes.githubInstallationId = info.installationId;
    if (info.githubRepoId !== undefined) changes.githubRepoId = info.githubRepoId;
    if (info.defaultBranch !== undefined) changes.defaultBranch = info.defaultBranch;
    if (Object.keys(changes).length === 0) return;
    await this.db.update(repos).set(changes).where(eq(repos.id, repoId));
  }

  async createTaskFromIssue(input: {
    repoId: string;
    title: string;
    description: string;
    labels: string[];
    assigneeMemberId: string | null;
    createdByMemberId: string;
  }): Promise<TaskRecord> {
    const row = await inTransaction(this.db, async (uow) => {
      const { tx } = uow;
      const [repo] = await tx.select().from(repos).where(eq(repos.id, input.repoId));
      if (!repo) throw notFound("Repo");
      // 鎖住 Project：Task 流水號的遞增要序列化（與 Task 的 API 相同）。
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, repo.projectId))
        .for("update");
      if (!project) throw notFound("Project");
      const number = project.nextTaskNumber;
      await tx
        .update(projects)
        .set({ nextTaskNumber: number + 1 })
        .where(eq(projects.id, project.id));
      const [created] = await tx
        .insert(tasks)
        .values({
          projectId: project.id,
          number,
          key: formatTaskKey(project.taskKeyPrefix, number),
          repoId: repo.id,
          title: input.title,
          description: input.description,
          labels: input.labels,
          assigneeMemberId: input.assigneeMemberId,
          createdByMemberId: input.createdByMemberId,
        })
        .returning();
      if (!created) throw new Error("建立 Task 失敗");
      uow.afterCommit(() =>
        this.lifecycle.emit({
          type: "task.created",
          taskId: created.id,
          projectId: created.projectId,
          source: "github",
        }),
      );
      return created;
    });
    return this.taskRecord(row);
  }

  async updateTaskFields(taskId: string, patch: TaskFieldsPatch): Promise<TaskRecord> {
    const row = await inTransaction(this.db, async (uow) => {
      const [current] = await uow.tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
      if (!current) throw notFound("Task");
      const changes: Partial<typeof tasks.$inferInsert> = {};
      if (patch.title !== undefined) changes.title = patch.title;
      if (patch.description !== undefined) changes.description = patch.description;
      if (patch.labels !== undefined) changes.labels = patch.labels;
      if (patch.assigneeMemberId !== undefined) changes.assigneeMemberId = patch.assigneeMemberId;
      // 關閉原因只對 Done 的 Task 有意義（DB 也有 CHECK）。
      if (patch.doneReason !== undefined && current.status === "done") {
        changes.doneReason = patch.doneReason;
      }
      if (Object.keys(changes).length === 0) return current;
      const [updated] = await uow.tx
        .update(tasks)
        .set(changes)
        .where(eq(tasks.id, taskId))
        .returning();
      if (!updated) throw notFound("Task");
      uow.afterCommit(() =>
        this.lifecycle.emit({
          type: "task.updated",
          taskId,
          projectId: updated.projectId,
          fields: Object.keys(changes),
          source: "github",
        }),
      );
      return updated;
    });
    return this.taskRecord(row);
  }

  async transitionTask(
    taskId: string,
    to: TaskStatus,
    cause: TransitionCause,
  ): Promise<TransitionResult> {
    const trigger = cause.kind.startsWith("issue_") ? "issue" : "pull_request";
    try {
      const row = await inTransaction(this.db, async (uow) => {
        if (to === "done") {
          const [active] = await uow.tx
            .select({ n: count() })
            .from(runs)
            .where(and(eq(runs.taskId, taskId), notInArray(runs.status, TERMINAL_RUN_STATUSES)));
          if ((active?.n ?? 0) > 0) return null;
        }
        return this.lifecycle.transition(uow, taskId, to, trigger, {
          ...("doneReason" in cause && { doneReason: cause.doneReason }),
          source: "github",
        });
      });
      if (!row) return { ok: false, reason: "active_run" };
      return { ok: true, task: await this.taskRecord(row) };
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "not_found" || error.code === "invalid_transition")
      ) {
        return { ok: false, reason: "invalid_transition" };
      }
      throw error;
    }
  }

  async listAcceptanceCriteria(taskId: string): Promise<AcceptanceCriterionRecord[]> {
    const rows = await this.db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.taskId, taskId))
      .orderBy(asc(acceptanceCriteria.position));
    return rows.map((row) => ({
      kind: row.kind,
      description: row.description,
      result: row.passed === null ? "pending" : row.passed ? "passed" : "failed",
    }));
  }

  async getLatestRun(taskId: string): Promise<RunSummary | null> {
    const [row] = await this.db
      .select({ id: runs.id, agent: runs.agent, status: runs.status })
      .from(runs)
      .where(and(eq(runs.taskId, taskId), isNull(runs.parentRunId)))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(1);
    return row ?? null;
  }

  async getMember(memberId: string): Promise<MemberRecord | null> {
    const [row] = await this.db.select().from(members).where(eq(members.id, memberId));
    return row ? toMemberRecord(row) : null;
  }

  async findMemberByGithubUserId(
    projectId: string,
    githubUserId: number,
  ): Promise<MemberRecord | null> {
    const [row] = await this.db
      .select({ member: members })
      .from(projects)
      .innerJoin(members, eq(members.teamId, projects.teamId))
      .where(and(eq(projects.id, projectId), eq(members.githubUserId, githubUserId)));
    return row ? toMemberRecord(row.member) : null;
  }

  async canEditTasks(projectId: string, memberId: string): Promise<boolean> {
    return canEditTasks(this.db, projectId, memberId);
  }

  async autoCreateIssues(projectId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ autoCreateIssues: projects.autoCreateIssues })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.autoCreateIssues ?? false;
  }
}

/** Member 在這個 Project 能不能編輯 Task（有效 Role 至少 Member，§12.2）；不是同一個 Team 時為 false。 */
export async function canEditTasks(
  db: Executor,
  projectId: string,
  memberId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ role: members.role, override: projectMemberRoles.role })
    .from(projects)
    .innerJoin(members, and(eq(members.teamId, projects.teamId), eq(members.id, memberId)))
    .leftJoin(
      projectMemberRoles,
      and(
        eq(projectMemberRoles.projectId, projects.id),
        eq(projectMemberRoles.memberId, members.id),
      ),
    )
    .where(eq(projects.id, projectId));
  if (!row) return false;
  return authorize("edit_task", { memberId, role: effectiveRole(row.role, row.override) }).ok;
}
