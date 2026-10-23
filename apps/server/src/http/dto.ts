// 資料庫的列轉成 API 回應（packages/api-contract 的形狀）。測試會用契約的 schema 驗證這裡的輸出。

import type {
  AcceptanceCriterion,
  DraftTask,
  Gate,
  Member,
  NeedsYouItem,
  Notification,
  PreviewComment,
  Project,
  Repo,
  ReviewComment,
  Role,
  Run,
  RunEvent,
  RunUsage,
  Task,
  TaskNote,
  Team,
  Verification,
} from "@orbis/api-contract";
import type { PermissionPurpose } from "@orbis/protocol";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  acceptanceCriteria,
  type draftTasks,
  type gates,
  type members,
  needsYouItems,
  type notifications,
  type projects,
  repoSpecs,
  type repos,
  reviewComments,
  type runEvents,
  type runs,
  taskDependencies,
  type taskNotes,
  type tasks,
  type teams,
  verificationResults,
  type verifications,
} from "../db/schema";
import type { Executor } from "../db/tx";
import type { GateSubject } from "../runs/gates";

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

/** `viewerRole` 是目前登入者在這個 Project 的有效 Role（authz 的 effectiveRole）。 */
export function toProject(row: typeof projects.$inferSelect, viewerRole: Role): Project {
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
      autoCreateIssues: row.autoCreateIssues,
      verificationMaxRetries: row.verificationMaxRetries,
      feedbackBotAllowlist: row.feedbackBotAllowlist,
    },
    viewerRole,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * `installUrl` 是 GitHub App 的安裝網址（GitHub 整合停用時為 null）；
 * App 已安裝在這個 repo（有 installation id）時回應中一律是 null。
 */
export function toRepo(row: typeof repos.$inferSelect, installUrl: string | null): Repo {
  const installed = row.githubInstallationId !== null;
  return {
    id: row.id,
    projectId: row.projectId,
    owner: row.githubOwner,
    name: row.githubName,
    // 契約要求非空；建立 Repo 時一律寫入 default branch。
    defaultBranch: row.defaultBranch ?? "main",
    github: { installed, installUrl: installed ? null : installUrl },
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
    repoId: row.repoId,
    title: row.title,
    description: row.description,
    status: row.status,
    doneReason: row.doneReason,
    assigneeMemberId: row.assigneeMemberId,
    specPath: row.repoSpecId ? (specPath.get(row.repoSpecId) ?? null) : null,
    dependsOn: deps
      .filter((d) => d.taskId === row.id)
      .map((d) => d.dependsOnTaskId)
      .sort(),
    planGateEnabled: row.planGateEnabled,
    createdByMemberId: row.createdByMemberId,
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
    resultSummary: row.resultSummary,
    checkedByRunId: row.checkedByRunId,
    checkedByMemberId: row.checkedByMemberId,
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
    origin: row.origin,
    credential: row.credential,
    consultOfRunId: row.consultOfRunId,
    resumesRunId: row.resumesRunId,
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

type GateRow = typeof gates.$inferSelect;
type ReviewCommentRow = typeof reviewComments.$inferSelect;

/** `kind = diff` 的列（DB 的 check 保證 path、line、side 都有值）。 */
export function toReviewComment(row: ReviewCommentRow): ReviewComment {
  return {
    id: row.id,
    gateId: row.gateId,
    path: row.path ?? "",
    line: row.line ?? 1,
    side: row.side ?? "new",
    body: row.body,
    authorMemberId: row.authorMemberId,
    // W5–7 契約新增；@agent 建立的 Run 由 B2 從 mentions 查出後填入。
    consultRunIds: [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** `kind = preview` 的列（DB 的 check 保證 url 有值）。 */
export function toPreviewComment(row: ReviewCommentRow): PreviewComment {
  return {
    id: row.id,
    gateId: row.gateId,
    body: row.body,
    url: row.url ?? "",
    selector: row.selector,
    screenshotBlobId: row.screenshotBlobId,
    authorMemberId: row.authorMemberId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toGate(row: GateRow, comments: ReviewCommentRow[]): Gate {
  const subject = (row.subject ?? {}) as GateSubject;
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    kind: row.kind,
    decision: row.decision,
    decidedByMemberId: row.decidedByMemberId,
    decidedAt: isoOrNull(row.decidedAt),
    comment: row.comment,
    reviewComments: comments
      .filter((c) => c.gateId === row.id && c.kind === "diff")
      .map(toReviewComment),
    previewComments: comments
      .filter((c) => c.gateId === row.id && c.kind === "preview")
      .map(toPreviewComment),
    planSeq: row.kind === "plan" ? (subject.planSeq ?? null) : null,
    reviewDiffSeq: row.kind === "review" ? (subject.reviewDiffSeq ?? null) : null,
    createdAt: iso(row.createdAt),
  };
}

/** 一次查出多個 Gate 的行內留言，組成 API 回應。 */
export async function toGates(db: Executor, rows: GateRow[]): Promise<Gate[]> {
  if (rows.length === 0) return [];
  const comments = await db
    .select()
    .from(reviewComments)
    .where(
      inArray(
        reviewComments.gateId,
        rows.map((g) => g.id),
      ),
    )
    .orderBy(asc(reviewComments.path), asc(reviewComments.line), asc(reviewComments.createdAt));
  return rows.map((row) => toGate(row, comments));
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
        purpose: (payload.purpose as PermissionPurpose | undefined) ?? "tool",
        options: payload.options as Extract<
          NeedsYouItem,
          { kind: "permission_request" }
        >["options"],
      };
    case "gate":
      return { ...base, kind: "gate", gateKind: context.gateKind ?? "review" };
    case "stopped_run":
      return { ...base, kind: "stopped_run", reason: String(payload.reason ?? "") };
    // W5–7 契約新增，B2 建立這種項目時把問題與 Child Run 放進 payload。
    case "child_question":
      return {
        ...base,
        kind: "child_question",
        questionId: row.childQuestionId ?? "",
        childRunId: String(payload.childRunId ?? ""),
        question: String(payload.question ?? ""),
      };
  }
}

type VerificationRow = typeof verifications.$inferSelect;

/** 一次查出多輪 Verification 的結果，組成 API 回應（結果依 Task 中條件的順序）。 */
export async function toVerifications(
  db: Executor,
  rows: VerificationRow[],
): Promise<Verification[]> {
  if (rows.length === 0) return [];
  const results = await db
    .select({ result: verificationResults, position: acceptanceCriteria.position })
    .from(verificationResults)
    .innerJoin(acceptanceCriteria, eq(acceptanceCriteria.id, verificationResults.criterionId))
    .where(
      inArray(
        verificationResults.verificationId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(acceptanceCriteria.position));
  // 停下來等人決定的那一輪（verification.ts 建立「停下來的 Run」時記下 verificationId）。
  const waiting = await db
    .select({ payload: needsYouItems.payload })
    .from(needsYouItems)
    .where(
      and(
        inArray(
          needsYouItems.runId,
          rows.map((r) => r.runId),
        ),
        eq(needsYouItems.kind, "stopped_run"),
        isNull(needsYouItems.resolvedAt),
      ),
    );
  const awaiting = new Set(
    waiting.map((w) => (w.payload as { verificationId?: string }).verificationId),
  );
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    taskId: row.taskId,
    attempt: row.attempt,
    awaitingDecision: awaiting.has(row.id),
    status: row.status,
    resolution: row.resolution,
    resolvedByMemberId: row.resolvedByMemberId,
    comment: row.comment,
    results: results
      .filter(({ result }) => result.verificationId === row.id)
      .map(({ result }) => ({
        criterionId: result.criterionId,
        outcome: result.outcome,
        summary: result.summary,
        evidence: result.evidence as Verification["results"][number]["evidence"],
        judgedByRunId: result.judgedByRunId,
        createdAt: iso(result.createdAt),
      })),
    startedAt: iso(row.startedAt),
    completedAt: isoOrNull(row.completedAt),
  }));
}

/** Draft Task（DB 的 draft_tasks）。 */
export function toDraftTask(row: typeof draftTasks.$inferSelect): DraftTask {
  return {
    id: row.id,
    projectId: row.projectId,
    batchId: row.batchId,
    position: row.position,
    proposedByRunId: row.proposedByRunId,
    repoId: row.repoId,
    spec: row.spec,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria as DraftTask["acceptanceCriteria"],
    dependsOn: row.dependsOn as string[],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Task note（DB 的 task_notes）。 */
export function toTaskNote(row: typeof taskNotes.$inferSelect): TaskNote {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    source: row.source,
    body: row.body,
    url: row.url,
    createdAt: iso(row.createdAt),
  };
}

/** 通知（DB 的 notifications）；呼叫端提供 Task Key。 */
export function toNotification(
  row: typeof notifications.$inferSelect,
  taskKey: string | null,
): Notification {
  return {
    id: row.id,
    kind: row.kind,
    taskId: row.taskId,
    taskKey,
    runId: row.runId,
    gateId: row.gateId,
    actorMemberId: row.actorMemberId,
    title: row.title,
    body: row.body,
    url: row.url,
    readAt: isoOrNull(row.readAt),
    createdAt: iso(row.createdAt),
  };
}
