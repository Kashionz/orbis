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
  StoppedRunInfo,
  StoppedRunReason,
  Task,
  TaskNote,
  TaskPullRequest,
  Team,
  Verification,
} from "@orbis/api-contract";
import type { PermissionPurpose } from "@orbis/protocol";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { taskAccess } from "../authz/capabilities";
import {
  acceptanceCriteria,
  type draftTasks,
  type gates,
  type members,
  needsYouItems,
  type notifications,
  type projects,
  pullRequests,
  repoSpecs,
  type repos,
  reviewComments,
  runControls,
  type runEvents,
  runs,
  taskDependencies,
  taskMembers,
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
    allowExternalPreview: row.allowExternalPreview,
    allowTeamRunnerTerminal: row.allowTeamRunnerTerminal,
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
    email: row.email,
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
      localMergeStrategy: row.localMergeStrategy,
      localPushBase: row.localPushBase,
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
    kind: row.kind,
    owner: row.githubOwner,
    name: row.githubName,
    // 契約要求非空；建立 Repo 時一律寫入 default branch。
    defaultBranch: row.defaultBranch ?? "main",
    github: row.kind === "github" ? { installed, installUrl: installed ? null : installUrl } : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type TaskRow = typeof tasks.$inferSelect;

/** 看 Task 的人：算出 `viewerAccess` 用（ADR-0012）。 */
export interface TaskViewer {
  memberId: string;
  /** 在各 Project 的有效 Role。 */
  projectRole: (projectId: string) => Role;
}

/** 一次查出多個 Task 的相依、Spec 路徑、PR 與登入者的有效權限，組成 API 回應。 */
export async function toTasks(db: Executor, rows: TaskRow[], viewer: TaskViewer): Promise<Task[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((t) => t.id);
  const shares = await db
    .select({ taskId: taskMembers.taskId, role: taskMembers.role })
    .from(taskMembers)
    .where(and(inArray(taskMembers.taskId, ids), eq(taskMembers.memberId, viewer.memberId)));
  const shareRole = new Map(shares.map((s) => [s.taskId, s.role]));
  const prs = await db
    .select()
    .from(pullRequests)
    .where(inArray(pullRequests.taskId, ids))
    .orderBy(desc(pullRequests.createdAt));
  const latestPr = new Map<string, (typeof prs)[number]>();
  for (const pr of prs) if (!latestPr.has(pr.taskId)) latestPr.set(pr.taskId, pr);
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
    pullRequest: toTaskPullRequest(latestPr.get(row.id)),
    generalAccess: row.generalAccess,
    // 呼叫端只會傳入登入者看得到的 Task；萬一看不到時以最低的權限表示。
    viewerAccess:
      taskAccess({
        role: viewer.projectRole(row.projectId),
        taskRole: shareRole.get(row.id) ?? null,
        generalAccess: row.generalAccess,
      }) ?? "view",
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
}

function toTaskPullRequest(
  row: typeof pullRequests.$inferSelect | undefined,
): TaskPullRequest | null {
  if (!row) return null;
  return {
    number: row.number,
    url: row.url,
    state: row.state,
    runId: row.runId,
    openedAt: iso(row.createdAt),
    mergedAt: isoOrNull(row.mergedAt),
  };
}

export async function toTask(db: Executor, row: TaskRow, viewer: TaskViewer): Promise<Task> {
  const [task] = await toTasks(db, [row], viewer);
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
    effort: row.effort,
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

/**
 * 一批 Event 轉成 API 回應，並補上作者（`actorMemberId`）：依 Event 的 `control_id` 查出送出那個 RunControl 的
 * Member；Run 第一則人送出的 prompt（沒有 control id、來源是 `user`）的作者是派工的人。其他為 null。
 */
export async function toRunEvents(
  db: Executor,
  rows: (typeof runEvents.$inferSelect)[],
): Promise<RunEvent[]> {
  if (rows.length === 0) return [];
  const controlIds = [
    ...new Set(
      rows.flatMap((row) => {
        const id = (row.payload as { control_id?: unknown }).control_id;
        return typeof id === "string" ? [id] : [];
      }),
    ),
  ];
  const controls =
    controlIds.length > 0
      ? await db
          .select({ id: runControls.controlId, memberId: runControls.requestedByMemberId })
          .from(runControls)
          .where(inArray(runControls.controlId, controlIds))
      : [];
  const authorOf = new Map(controls.map((c) => [c.id, c.memberId]));
  const runIds = [...new Set(rows.map((row) => row.runId))];
  const requesters = await db
    .select({ id: runs.id, memberId: runs.requestedByMemberId })
    .from(runs)
    .where(inArray(runs.id, runIds));
  const requesterOf = new Map(requesters.map((r) => [r.id, r.memberId]));
  return rows.map((row) => {
    const payload = row.payload as { kind: string; control_id?: unknown; source?: unknown };
    let actorMemberId: string | null = null;
    if (typeof payload.control_id === "string") {
      actorMemberId = authorOf.get(payload.control_id) ?? null;
    } else if (
      payload.kind === "prompt_submitted" &&
      (payload.source === undefined || payload.source === "user")
    ) {
      actorMemberId = requesterOf.get(row.runId) ?? null;
    }
    return {
      runId: row.runId,
      seq: row.seq,
      ts: iso(row.ts),
      event: row.payload as RunEvent["event"],
      actorMemberId,
    };
  });
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
    finishedWithoutChanges: subject.noChanges === true,
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
      return { ...base, kind: "stopped_run", ...stoppedRunInfo(payload) };
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
    stoppedRun: (row.stoppedRun as StoppedRunInfo | null) ?? null,
    readAt: isoOrNull(row.readAt),
    createdAt: iso(row.createdAt),
  };
}

/**
 * Needs You `stopped_run` 的 payload 轉成契約的 StoppedRunInfo。migration 0004 之前建立的項目只有
 * 中文的 `reason`，依原因文字推回代碼（見 `legacyStoppedRunInfo`）。
 */
export function stoppedRunInfo(payload: Record<string, unknown>): StoppedRunInfo {
  if (typeof payload.reasonCode === "string") {
    return {
      reasonCode: payload.reasonCode as StoppedRunReason,
      attempt: typeof payload.attempt === "number" ? payload.attempt : null,
      detail: typeof payload.detail === "string" ? payload.detail : null,
    };
  }
  return legacyStoppedRunInfo(String(payload.reason ?? ""), payload.verificationId !== undefined);
}

/**
 * migration 0004 之前的原因文字：`Verification 連續失敗 N 次`、`開 PR 失敗：<錯誤>`、
 * `push 分支失敗：<錯誤>`（或沒有錯誤的 `push 分支失敗`）。冒號後面的錯誤放進 detail；
 * 解析不到 Verification 的次數時 attempt 為 null（不給錯的數字）。
 */
export function legacyStoppedRunInfo(reason: string, hasVerification: boolean): StoppedRunInfo {
  const separator = reason.indexOf("：");
  const detail = separator >= 0 ? reason.slice(separator + 1).trim() || null : null;
  if (hasVerification || reason.startsWith("Verification")) {
    const count = /連續失敗 (\d+) 次/.exec(reason)?.[1];
    return {
      reasonCode: "verification_limit",
      attempt: count === undefined ? null : Number(count),
      detail: null,
    };
  }
  if (reason.startsWith("開 PR 失敗"))
    return { reasonCode: "pr_open_failed", attempt: null, detail };
  if (reason.startsWith("push 分支失敗"))
    return { reasonCode: "push_failed", attempt: null, detail };
  return { reasonCode: "push_failed", attempt: null, detail: reason || null };
}
