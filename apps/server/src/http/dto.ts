// 資料庫的列轉成 API 回應（packages/api-contract 的形狀）。測試會用契約的 schema 驗證這裡的輸出。

import type {
  AcceptanceCriterion,
  NeedsYouItem,
  Project,
  Repo,
  Run,
  RunEvent,
  RunUsage,
  Task,
} from "@orbis/api-contract";
import { inArray } from "drizzle-orm";
import type { Gate, Member, ReviewComment, Team } from "../contract-pending";
import {
  type acceptanceCriteria,
  type gates,
  type members,
  type needsYouItems,
  type projects,
  repoSpecs,
  type repos,
  type runEvents,
  type runs,
  taskDependencies,
  type tasks,
  type teams,
} from "../db/schema";
import type { Executor } from "../db/tx";

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

export function toTeam(row: typeof teams.$inferSelect): Team {
  return {
    id: row.id,
    name: row.name,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toMember(row: typeof members.$inferSelect): Member {
  return {
    id: row.id,
    teamId: row.teamId,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    name: row.name,
    avatarUrl: row.avatarUrl,
    role: row.role,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// TODO(contract): `defaultPermissionPolicy` 尚未進入契約的 ProjectPolicy。
export function toProject(
  row: typeof projects.$inferSelect,
): Project & { policy: { defaultPermissionPolicy: string } } {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    keyPrefix: row.taskKeyPrefix,
    description: row.description,
    policy: {
      planGateEnabled: row.planGateEnabled,
      delegationEnabled: row.delegationEnabled,
      delegationAgents: row.delegationAllowedAgents,
      forbidSelfApproval: row.forbidSelfApproval,
      memberCanDispatchToTeamRunner: row.allowMemberTeamRunnerDispatch,
      defaultPermissionPolicy: row.defaultPermissionPolicy,
    },
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toRepo(row: typeof repos.$inferSelect): Repo {
  return {
    id: row.id,
    projectId: row.projectId,
    owner: row.githubOwner,
    name: row.githubName,
    // 契約要求非空；建立 Repo 時一律寫入 default branch。
    defaultBranch: row.defaultBranch ?? "main",
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type TaskRow = typeof tasks.$inferSelect;

/** 一次查出多個 Task 的相依與 Spec 路徑，組成 API 回應。 */
export async function toTasks(db: Executor, rows: TaskRow[]): Promise<Task[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((t) => t.id);
  const deps = await db
    .select()
    .from(taskDependencies)
    .where(inArray(taskDependencies.taskId, ids));
  const specIds = rows.flatMap((t) => (t.repoSpecId ? [t.repoSpecId] : []));
  const specs =
    specIds.length > 0
      ? await db
          .select({ id: repoSpecs.id, path: repoSpecs.path })
          .from(repoSpecs)
          .where(inArray(repoSpecs.id, specIds))
      : [];
  const specPath = new Map(specs.map((s) => [s.id, s.path]));
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    projectId: row.projectId,
    // 建立 Task 時一律要求 Repo（ADR-0011），所以 API 上不會是 null。
    repoId: row.repoId ?? "",
    title: row.title,
    description: row.description,
    status: row.status,
    assigneeMemberId: row.assigneeMemberId,
    specPath: row.repoSpecId ? (specPath.get(row.repoSpecId) ?? null) : null,
    dependsOn: deps
      .filter((d) => d.taskId === row.id)
      .map((d) => d.dependsOnTaskId)
      .sort(),
    planGateEnabled: row.planGateEnabled,
    // TODO(contract): 契約的 createdByMemberId 是非 null，但建立者被移除時 DB 會設成 null。
    createdByMemberId: row.createdByMemberId ?? "",
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
}

export async function toTask(db: Executor, row: TaskRow): Promise<Task> {
  const [task] = await toTasks(db, [row]);
  if (!task) throw new Error("unreachable");
  return task;
}

export function toAcceptanceCriterion(
  row: typeof acceptanceCriteria.$inferSelect,
): AcceptanceCriterion {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    description: row.description,
    command: row.command,
    position: row.position,
    result: row.passed === null ? "pending" : row.passed ? "passed" : "failed",
    resultUpdatedAt: isoOrNull(row.checkedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

const EMPTY_USAGE: RunUsage = {
  inputTokens: null,
  outputTokens: null,
  thoughtTokens: null,
  cachedReadTokens: null,
  cachedWriteTokens: null,
  contextUsedTokens: null,
  contextWindowTokens: null,
  cost: null,
};

export function toRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    taskId: row.taskId,
    parentRunId: row.parentRunId,
    delegationMode: row.parentRunId ? row.delegationMode : null,
    agent: row.agent,
    model: row.model,
    permissionPolicy: row.permissionPolicy,
    runnerKind: row.target,
    runnerId: row.runnerId,
    worktreePath: row.worktreePath,
    branch: row.branch,
    baseCommit: row.baseCommit,
    status: row.status,
    usage: { ...EMPTY_USAGE, ...(row.usage as Partial<RunUsage>) },
    startedByMemberId: row.requestedByMemberId,
    createdAt: iso(row.createdAt),
    startedAt: isoOrNull(row.startedAt),
    endedAt: isoOrNull(row.finishedAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toRunEvent(row: typeof runEvents.$inferSelect): RunEvent {
  return {
    runId: row.runId,
    seq: row.seq,
    ts: iso(row.ts),
    event: row.payload as RunEvent["event"],
  };
}

export function toGate(row: typeof gates.$inferSelect): Gate {
  // TODO(contract): 行內留言改存 gates.review_comments（contract/db）；目前暫存在 subject。
  const subject = (row.subject ?? {}) as { reviewComments?: ReviewComment[] };
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    kind: row.kind,
    decision: row.decision,
    decidedByMemberId: row.decidedByMemberId,
    decidedAt: isoOrNull(row.decidedAt),
    comment: row.comment,
    reviewComments: subject.reviewComments ?? [],
    createdAt: iso(row.createdAt),
  };
}

/** Needs You 項目；呼叫端要一併提供 Task Key。 */
export function toNeedsYou(
  row: typeof needsYouItems.$inferSelect,
  context: { taskKey: string; gateKind: "plan" | "review" | null },
): NeedsYouItem {
  const payload = row.payload as Record<string, unknown>;
  const base = {
    id: row.id,
    memberId: row.memberId ?? "",
    taskId: row.taskId ?? "",
    taskKey: context.taskKey,
    runId: row.runId ?? "",
    createdAt: iso(row.createdAt),
  };
  switch (row.kind) {
    case "permission_request":
      return {
        ...base,
        kind: "permission_request",
        permissionRequestId: String(payload.permissionRequestId),
        toolCallId: (payload.toolCallId as string | null) ?? null,
        title: String(payload.title ?? ""),
        options: payload.options as Extract<
          NeedsYouItem,
          { kind: "permission_request" }
        >["options"],
      };
    case "gate":
      return { ...base, kind: "gate", gateKind: context.gateKind ?? "review" };
    case "stopped_run":
      return { ...base, kind: "stopped_run", reason: String(payload.reason ?? "") };
  }
}
