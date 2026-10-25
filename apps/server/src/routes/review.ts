// Needs You 與 Gate（ARCHITECTURE §5、§8、§10）。
//
// - Needs You：權限請求依授權即時計算（本人有權回覆的才列出）；Gate 與停下來的 Run 依指派的 Member。
// - 權限請求：有權回覆的人送出選項後轉成 RunControl `permission_response` 送給 Runner。
// - Plan Gate：核准（Task → Running，送 gate_result，Runner 切換成執行模式）、退回（只收整體說明，
//   Task → Planning，意見以 prompt 送回）、中止。
// - Review Gate：核准（manual 條件要全部打勾；Task → PR Open，送 gate_result 與 push_branch；push 完成後
//   由 D 軌開 PR）、退回（行內留言與 Preview 留言存進 review_comments 並打包成同一個 prompt，Task →
//   Running，同一個 session 繼續）、中止（cancel，Task → Ready）。
// - Review Gate 的 diff 為空時沒有東西可以 push：不能核准，改為結束（沒有變更）（manual 條件同樣要全部
//   打勾；Task → Done，關閉原因 completed；送 cancel 結束 Run，不 push、不開 PR），或退回、中止。

import {
  AnswerChildQuestionInput,
  API_ROUTES,
  CheckAcceptanceCriterionInput,
  GateDecisionInput,
  type LocalMergeRetryRequested,
  type NeedsYouItem,
  type NeedsYouListResponse,
  PermissionResponseInput,
  type PreviewCommentInput,
  type ReviewCommentInput,
} from "@orbis/api-contract";
import type {
  BlobRef,
  ContentBlock,
  PermissionPurpose,
  RunControlAction,
  RunDiff,
} from "@orbis/protocol";
import { and, asc, count, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { z } from "zod";
import {
  authorize,
  authorizePermissionResponse,
  roleOnTask,
  taskAccess,
} from "../authz/capabilities";
import { requirePermissionResponder, runnerOwnerOf } from "../authz/runner-owner";
import {
  actorProjectRoles,
  loadRunScope,
  loadTaskScope,
  requireProjectCapability,
} from "../authz/scope";
import {
  acceptanceCriteria,
  blobs,
  childQuestions,
  gates,
  needsYouItems,
  projects,
  repos,
  reviewComments,
  runEvents,
  runners,
  runs,
  taskMembers,
  tasks,
} from "../db/schema";
import { type Executor, inTransaction } from "../db/tx";
import { isTerminalRunStatus } from "../domain/run-status";
import { toAcceptanceCriterion, toGates, toNeedsYou } from "../http/dto";
import { ApiError, conflict, notFound, readId, readJson } from "../http/errors";
import type { AppEnv } from "../http/session";
import { type PreviewDomain, runIdFromHost } from "../preview/domain";
import { type GateSubject, RUN_DIFF_EVENT_KIND } from "../runs/gates";
import type { Services } from "../services";
import { answerQuestion, questionKey } from "../tools/delegation-tools";

/** needs_you_items.payload 中權限請求的內容（runs/event-ingest.ts 寫入）。 */
interface PermissionRequestPayload {
  permissionRequestId: string;
  purpose?: PermissionPurpose;
  options: { optionId: string }[];
}

/** 權限請求最早的資料沒有 purpose，視為一般的 tool call。 */
const purposeOf = (payload: unknown): PermissionPurpose =>
  (payload as PermissionRequestPayload).purpose ?? "tool";

/** Run 所在 Runner 的擁有者：Local Run 一律交給派工者自己的 Local Runner。 */
export function createReviewRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  /**
   * 等待我處理的項目（Web 與 Desktop 定期輪詢），只列出本人有權處理的項目，新的在前：
   * - 權限請求：Team 中所有還沒回覆、本人有權回覆的（authorizePermissionResponse）。
   * - Gate：指派給本人、而且本人能核准的。
   * - 停下來的 Run：指派給本人的。
   */
  app.get(API_ROUTES.needsYou, auth, async (c) => {
    const actor = c.get("actor");
    const rows = await db
      .select({
        item: needsYouItems,
        taskKey: tasks.key,
        task: tasks,
        project: projects,
        gateKind: gates.kind,
        gateAssignee: gates.assigneeMemberIdAtCreation,
        run: runs,
        runnerMemberId: runners.memberId,
        shareRole: taskMembers.role,
      })
      .from(needsYouItems)
      .innerJoin(projects, eq(projects.id, needsYouItems.projectId))
      .innerJoin(tasks, eq(tasks.id, needsYouItems.taskId))
      .leftJoin(gates, eq(gates.id, needsYouItems.gateId))
      .leftJoin(runs, eq(runs.id, needsYouItems.runId))
      .leftJoin(runners, eq(runners.id, runs.runnerId))
      .leftJoin(
        taskMembers,
        and(eq(taskMembers.taskId, tasks.id), eq(taskMembers.memberId, actor.memberId)),
      )
      .where(
        and(
          eq(projects.teamId, actor.teamId),
          isNull(needsYouItems.resolvedAt),
          or(
            eq(needsYouItems.kind, "permission_request"),
            eq(needsYouItems.memberId, actor.memberId),
            // 不指派給特定的人的 Gate（負責人不能核准自己的 Task），下面依授權過濾。
            and(eq(needsYouItems.kind, "gate"), isNull(needsYouItems.memberId)),
          ),
        ),
      )
      .orderBy(desc(needsYouItems.createdAt), desc(needsYouItems.id));
    const roles = await actorProjectRoles(db, actor);
    const items: NeedsYouListResponse = [];
    for (const r of rows) {
      // 看不到的 Task 不出現（Task 分享，ADR-0012）；能不能處理依 Task 上的 Role 判斷。
      const projectRole = roles(r.project.id);
      const access = taskAccess({
        role: projectRole,
        taskRole: r.shareRole,
        generalAccess: r.task.generalAccess,
      });
      if (access === null) continue;
      const role = roleOnTask(projectRole, access);
      if (r.item.kind === "permission_request") {
        if (!r.run) continue;
        const allowed = authorizePermissionResponse({
          memberId: actor.memberId,
          role,
          runnerKind: r.run.target,
          runnerOwnerMemberId: runnerOwnerOf(r.run, r.runnerMemberId),
          purpose: purposeOf(r.item.payload),
        });
        if (!allowed.ok) continue;
      } else if (r.item.kind === "gate") {
        const allowed = authorize("approve_gate", {
          memberId: actor.memberId,
          role,
          project: {
            allowMemberTeamRunnerDispatch: r.project.allowMemberTeamRunnerDispatch,
            forbidSelfApproval: r.project.forbidSelfApproval,
          },
          task: {
            assigneeMemberId: r.task.assigneeMemberId,
            gateAssigneeMemberId: r.gateAssignee,
          },
        });
        if (!allowed.ok) continue;
      }
      const item: NeedsYouItem = toNeedsYou(r.item, { taskKey: r.taskKey, gateKind: r.gateKind });
      // 權限請求不是指派給某個人，回應中填本人（契約的「要處理這個項目的 Member」）。
      items.push({ ...item, memberId: actor.memberId });
    }
    return c.json(items);
  });

  /**
   * 回覆權限請求（ARCHITECTURE §8）。Run 即時檢視與 Needs You 都呼叫這個端點。
   * 誰可以回覆見 authorizePermissionResponse()。
   */
  app.post(API_ROUTES.runPermissionResponse, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    const requestId = c.req.param("requestId") ?? "";
    const [item] = await db
      .select()
      .from(needsYouItems)
      .where(
        and(
          eq(needsYouItems.runId, scope.run.id),
          eq(needsYouItems.kind, "permission_request"),
          sql`${needsYouItems.payload}->>'permissionRequestId' = ${requestId}`,
        ),
      )
      .orderBy(desc(needsYouItems.createdAt))
      .limit(1);
    if (!item) throw notFound("權限請求");
    await requirePermissionResponder(db, actor, scope, purposeOf(item.payload));
    if (item.resolvedAt) throw conflict("這個權限請求已經處理過了");
    const input = await readJson(c, PermissionResponseInput);
    const payload = item.payload as PermissionRequestPayload;
    if (!payload.options.some((o) => o.optionId === input.optionId)) {
      throw new ApiError(422, "invalid_input", "選項不在這個權限請求的選項中");
    }

    await inTransaction(db, async (uow) => {
      const [resolved] = await uow.tx
        .update(needsYouItems)
        .set({
          resolvedAt: s.clock.now(),
          resolvedByMemberId: actor.memberId,
          resolution: { selectedOptionId: input.optionId },
        })
        .where(and(eq(needsYouItems.id, item.id), isNull(needsYouItems.resolvedAt)))
        .returning({ id: needsYouItems.id });
      if (!resolved) throw conflict("這個權限請求已經處理過了");
      await s.runControls.send(
        uow.tx,
        scope.run.id,
        {
          action: "permission_response",
          request_id: payload.permissionRequestId,
          option_id: input.optionId,
        },
        uow,
        actor.memberId,
      );
    });
    return c.body(null, 204);
  });

  app.get(API_ROUTES.taskGates, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(gates)
      .where(eq(gates.taskId, scope.task.id))
      .orderBy(asc(gates.createdAt), asc(gates.id));
    return c.json(await toGates(db, rows));
  });

  app.post(API_ROUTES.gateDecision, auth, async (c) => {
    const actor = c.get("actor");
    const gateId = readId(c, "gateId", "Gate");
    const [gate] = await db.select().from(gates).where(eq(gates.id, gateId));
    if (!gate) throw notFound("Gate");
    const scope = await loadTaskScope(db, actor, gate.taskId);
    const input = await readJson(c, GateDecisionInput);
    // 結束（沒有變更）等於核准這一版（Task 轉 Done），權限與核准相同。
    const approving = input.action === "approve" || input.action === "finish_without_changes";
    if (approving) {
      // 「不能核准自己的 Task」同時比對目前的與 Gate 建立時的指派對象，所有種類的 Gate 都適用。
      requireProjectCapability(actor, scope, "approve_gate", gate.assigneeMemberIdAtCreation);
    } else if (input.action === "reject") {
      requireProjectCapability(actor, { ...scope, task: undefined }, "approve_gate");
    } else requireProjectCapability(actor, scope, "edit_task");
    if (!gate.runId) throw conflict("這個 Gate 沒有對應的 Run");
    const runId = gate.runId;
    if (gate.kind === "plan" && input.action === "finish_without_changes") {
      throw new ApiError(422, "invalid_input", "只有 Review Gate 可以結束（沒有變更）");
    }
    if (gate.kind === "plan" && input.action === "reject") {
      if (input.reviewComments.length > 0 || input.previewComments.length > 0) {
        throw new ApiError(422, "invalid_input", "Plan Gate 退回時只接受整體說明");
      }
      if (input.comment === null) {
        throw new ApiError(422, "invalid_input", "Plan Gate 退回時要附上說明");
      }
    }

    const actedBy = { source: "api", actorMemberId: actor.memberId } as const;
    const updated = await inTransaction(db, async (uow) => {
      const { tx } = uow;
      const now = s.clock.now();
      if (gate.kind === "review" && approving) {
        // diff 為空時沒有東西可以 push：只能結束（沒有變更）；diff 不為空時只能核准（ARCHITECTURE §10）。
        const empty = await reviewDiffIsEmpty(tx, runId, gate.subject as GateSubject | null);
        if (empty && input.action === "approve") {
          throw conflict("diff 是空的，沒有變更可以 push；請改為結束（沒有變更）或退回");
        }
        if (!empty && input.action === "finish_without_changes") {
          throw conflict("diff 不是空的，不能結束（沒有變更）；請核准、退回或中止");
        }
        // 所有 manual 條件都打勾後才能核准 Review Gate（ARCHITECTURE §5.1）。
        const [unchecked] = await tx
          .select({ n: count() })
          .from(acceptanceCriteria)
          .where(
            and(
              eq(acceptanceCriteria.taskId, gate.taskId),
              eq(acceptanceCriteria.kind, "manual"),
              // 打勾必須是人在這個 Gate 建立之後做的：條件的類型被改成 manual、或沿用上一版的
              // 打勾都不算。
              or(
                isNull(acceptanceCriteria.passed),
                eq(acceptanceCriteria.passed, false),
                isNull(acceptanceCriteria.checkedByMemberId),
                isNull(acceptanceCriteria.checkedAt),
                lt(acceptanceCriteria.checkedAt, gate.createdAt),
              ),
            ),
          );
        if ((unchecked?.n ?? 0) > 0) {
          throw conflict("還有 manual 類型的 Acceptance Criterion 沒有打勾");
        }
      }
      const diffComments: ReviewCommentInput[] =
        input.action === "reject" ? input.reviewComments : [];
      const previewComments =
        input.action === "reject"
          ? await checkPreviewComments(tx, runId, input.previewComments, s.preview.domain)
          : [];
      const [decided] = await tx
        .update(gates)
        .set({
          decision: approving ? "approved" : "rejected",
          decidedAt: now,
          decidedByMemberId: actor.memberId,
          comment:
            input.action === "reject"
              ? input.comment
              : input.action === "abort"
                ? "中止 Run"
                : null,
          ...(input.action === "abort" && {
            subject: { ...((gate.subject ?? {}) as GateSubject), aborted: true },
          }),
          ...(input.action === "finish_without_changes" && {
            subject: { ...((gate.subject ?? {}) as GateSubject), noChanges: true },
          }),
        })
        .where(and(eq(gates.id, gate.id), isNull(gates.decision)))
        .returning();
      if (!decided) throw conflict("這個 Gate 已經有決定了");
      if (diffComments.length > 0 || previewComments.length > 0) {
        const inserted = await tx
          .insert(reviewComments)
          .values([
            ...diffComments.map((comment) => ({
              gateId: gate.id,
              kind: "diff" as const,
              path: comment.path,
              line: comment.line,
              side: comment.side,
              body: comment.body,
              authorMemberId: actor.memberId,
            })),
            ...previewComments.map(({ input: comment }) => ({
              gateId: gate.id,
              kind: "preview" as const,
              url: comment.url,
              selector: comment.selector,
              screenshotBlobId: comment.screenshotBlobId,
              body: comment.body,
              authorMemberId: actor.memberId,
            })),
          ])
          .returning();
        // 留言中的 @mention：@agent 讀這個 Run 的 Worktree，並附上檔案與行號。
        for (const comment of inserted) {
          await s.mentions.processText(
            uow,
            { kind: "review_comment", id: comment.id },
            {
              projectId: scope.project.id,
              task: scope.task,
              actorMemberId: actor.memberId,
              text: comment.body,
              consultOfRunId: runId,
              location:
                comment.path && comment.line ? { path: comment.path, line: comment.line } : null,
            },
          );
        }
      }
      await tx
        .update(needsYouItems)
        .set({
          resolvedAt: now,
          resolvedByMemberId: actor.memberId,
          resolution: { action: input.action },
        })
        .where(and(eq(needsYouItems.gateId, gate.id), isNull(needsYouItems.resolvedAt)));

      const send = (action: RunControlAction) =>
        s.runControls.send(tx, runId, action, uow, actor.memberId);
      if (input.action === "approve") {
        if (gate.kind === "plan") {
          await s.lifecycle.transition(uow, gate.taskId, "running", "gate", actedBy);
          await send({ action: "gate_result", gate: "plan", decision: "approved" });
        } else if (await isLocalRepoTask(tx, scope.task.repoId)) {
          // 本機 Repo（ADR-0013）：Runner 把分支合併到本機 checkout 的基準分支，合併完成（local_merged）時
          // Task 才轉 Done；這段期間 Task 留在 Review Gate（Gate 已核准）。
          await send({ action: "gate_result", gate: "review", decision: "approved" });
          await send(localMergeAction(scope.project));
        } else {
          await s.lifecycle.transition(uow, gate.taskId, "pr_open", "gate", actedBy);
          await send({ action: "gate_result", gate: "review", decision: "approved" });
          await send({ action: "push_branch" });
        }
      } else if (input.action === "finish_without_changes") {
        // Task 先轉 Done，Run 之後回報 canceled 時就不會把 Task 送回 Ready。Worktree 照常保留。
        await s.lifecycle.transition(uow, gate.taskId, "done", "gate", {
          ...actedBy,
          doneReason: "completed",
        });
        await send({ action: "cancel" });
      } else if (input.action === "reject") {
        const planGate = gate.kind === "plan";
        await s.lifecycle.transition(
          uow,
          gate.taskId,
          planGate ? "planning" : "running",
          "gate",
          actedBy,
        );
        await send({ action: "gate_result", gate: gate.kind, decision: "rejected" });
        await send({
          action: "prompt",
          prompt: rejectionPrompt(input.comment, diffComments, previewComments),
          source: planGate ? "plan_gate" : "review_gate",
        });
        await s.notify.notify(uow, {
          kind: "task_rejected",
          recipients: [scope.task.assigneeMemberId],
          taskId: gate.taskId,
          runId,
          gateId: gate.id,
          actorMemberId: actor.memberId,
          title: `${scope.task.key} 的${planGate ? " plan " : "修改"}被退回`,
          body: input.comment,
        });
      } else {
        await s.lifecycle.transition(uow, gate.taskId, "ready", "run_stopped", actedBy);
        await send({ action: "cancel" });
      }
      return decided;
    });
    const [gateView] = await toGates(db, [updated]);
    return c.json(gateView);
  });

  /**
   * 人回答 Child Run 以 `ask_parent` 提出、父 Run 的回合已經結束而加入 Needs You 的問題（ARCHITECTURE §9）。
   * 答案交給 Child Run 阻塞中的 `ask_parent`。需要能編輯 Task 的權限。
   */
  app.post(API_ROUTES.childQuestionAnswer, auth, async (c) => {
    const actor = c.get("actor");
    const questionId = readId(c, "questionId", "問題");
    const [question] = await db
      .select({ question: childQuestions, taskId: runs.taskId })
      .from(childQuestions)
      .innerJoin(runs, eq(runs.id, childQuestions.childRunId))
      .where(eq(childQuestions.id, questionId));
    if (!question) throw notFound("問題");
    const scope = await loadTaskScope(db, actor, question.taskId);
    requireProjectCapability(actor, scope, "edit_task");
    const input = await readJson(c, AnswerChildQuestionInput);
    const answered = await inTransaction(db, (uow) =>
      answerQuestion(
        uow,
        questionId,
        null,
        input.answer,
        { memberId: actor.memberId },
        s.clock.now(),
      ),
    );
    if (!answered) throw conflict("這個問題已經回答過了");
    s.watch.changed(questionKey(questionId));
    s.watch.changed(question.question.childRunId);
    return c.body(null, 204);
  });

  /** 在 Review Gate 為 manual 類型的條件打勾或取消（核准 Review Gate 前要全部打勾）。 */
  app.post(API_ROUTES.acceptanceCriterionCheck, auth, async (c) => {
    const actor = c.get("actor");
    const criterionId = readId(c, "criterionId", "Acceptance Criterion");
    const [criterion] = await db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.id, criterionId));
    if (!criterion) throw notFound("Acceptance Criterion");
    const scope = await loadTaskScope(db, actor, criterion.taskId);
    const [waiting] = await db
      .select()
      .from(gates)
      .where(
        and(eq(gates.taskId, criterion.taskId), eq(gates.kind, "review"), isNull(gates.decision)),
      )
      .orderBy(desc(gates.createdAt))
      .limit(1);
    // 打勾是核准的一部分，權限與核准 Review Gate 相同。
    requireProjectCapability(actor, scope, "approve_gate", waiting?.assigneeMemberIdAtCreation);
    if (criterion.kind !== "manual") {
      throw new ApiError(422, "invalid_input", "只有 manual 類型的條件可以打勾");
    }
    if (scope.task.status !== "review_gate" || !waiting) {
      throw conflict("Task 不在 Review Gate，不能打勾");
    }
    const input = await readJson(c, CheckAcceptanceCriterionInput);
    const [updated] = await db
      .update(acceptanceCriteria)
      .set({
        passed: input.checked ? true : null,
        // 用資料庫的時間，才能和 Gate 的建立時間（資料庫的預設值）比較。
        checkedAt: input.checked ? sql`now()` : null,
        checkedByMemberId: input.checked ? actor.memberId : null,
        checkedByRunId: null,
      })
      .where(eq(acceptanceCriteria.id, criterion.id))
      .returning();
    if (!updated) throw notFound("Acceptance Criterion");
    return c.json(toAcceptanceCriterion(updated));
  });

  /**
   * 本機合併被擋下（`local_merge_blocked`）後重試（ADR-0013）：權限同核准 Review Gate，以 Project 目前的
   * 設定重送 `merge_local`，原本的「停下來的 Run」標示為已處理。
   */
  app.post(API_ROUTES.runMergeLocal, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "approve_gate");
    if (isTerminalRunStatus(scope.run.status)) {
      throw new ApiError(409, "run_finished", "Run 已經結束");
    }
    const controlId = await inTransaction(db, async (uow) => {
      const now = s.clock.now();
      const [blocked] = await uow.tx
        .update(needsYouItems)
        .set({
          resolvedAt: now,
          resolvedByMemberId: actor.memberId,
          resolution: { action: "retry" },
        })
        .where(
          and(
            eq(needsYouItems.runId, scope.run.id),
            eq(needsYouItems.kind, "stopped_run"),
            isNull(needsYouItems.resolvedAt),
            sql`${needsYouItems.payload}->>'reasonCode' = 'local_merge_blocked'`,
          ),
        )
        .returning({ id: needsYouItems.id });
      if (!blocked) throw conflict("這個 Run 沒有被擋下、等待重試的本機合併");
      return s.runControls.send(
        uow.tx,
        scope.run.id,
        localMergeAction(scope.project),
        uow,
        actor.memberId,
      );
    });
    return c.json({ controlId } satisfies LocalMergeRetryRequested, 202);
  });

  return app;
}

/**
 * Review Gate 送審的那份 `run_diff`（Gate 建立時記下的 seq）是否沒有任何檔案變更。Runner 的 diff 是
 * base_commit 到 Worktree（含未 commit 的變更），已排除只在本機使用的檔案，和 push 的範圍相同。
 * Gate 沒有記下 diff 時視為不是空的（維持核准）。
 */
async function reviewDiffIsEmpty(
  tx: Executor,
  runId: string,
  subject: GateSubject | null,
): Promise<boolean> {
  const seq = subject?.reviewDiffSeq;
  if (seq === null || seq === undefined) return false;
  const [row] = await tx
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        eq(runEvents.seq, seq),
        eq(runEvents.kind, RUN_DIFF_EVENT_KIND),
      ),
    );
  if (!row) return false;
  return (row.payload as RunDiff).files.length === 0;
}

type PreviewCommentParsed = z.output<typeof PreviewCommentInput>;

/** Preview 留言連同截圖的 BlobRef（退回時以圖片附在 prompt 中）。 */
export interface CheckedPreviewComment {
  input: PreviewCommentParsed;
  screenshot: BlobRef | null;
}

/**
 * 檢查 Preview 留言：網址必須是這個 Run 的 Preview 網址（`<scheme>://<run-id>.<Preview 網域>/`，
 * ARCHITECTURE §13），截圖必須是這個 Run 的 blob。沒有設定 Preview 網域時不接受 Preview 留言。
 */
async function checkPreviewComments(
  tx: Executor,
  runId: string,
  comments: PreviewCommentParsed[],
  domain: PreviewDomain | null,
): Promise<CheckedPreviewComment[]> {
  const checked: CheckedPreviewComment[] = [];
  for (const comment of comments) {
    const url = new URL(comment.url);
    const sameRun =
      domain !== null &&
      url.protocol === `${domain.scheme}:` &&
      runIdFromHost(url.host, domain) === runId.toLowerCase();
    if (!sameRun) {
      throw new ApiError(422, "invalid_input", "Preview 留言的網址不是這個 Run 的 Preview");
    }
    let screenshot: BlobRef | null = null;
    if (comment.screenshotBlobId) {
      const [blob] = await tx
        .select()
        .from(blobs)
        .where(and(eq(blobs.id, comment.screenshotBlobId), eq(blobs.runId, runId)));
      if (!blob) throw new ApiError(422, "invalid_input", "截圖不是這個 Run 的檔案");
      screenshot = {
        blob_id: blob.id,
        sha256: blob.sha256,
        size: blob.size,
        media_type: blob.mediaType,
      };
    }
    checked.push({ input: comment, screenshot });
  }
  return checked;
}

/**
 * Gate 退回時送給 Agent 的 prompt：整體說明、依檔案排序的行內留言，以及 Preview 留言
 * （網址、selector；截圖以圖片附上，ARCHITECTURE §13）。
 */
export function rejectionPrompt(
  comment: string | null,
  reviewComments: ReviewCommentInput[],
  previewComments: CheckedPreviewComment[] = [],
): ContentBlock[] {
  const lines = ["Review 退回，請依照下列意見修改後再交回。"];
  if (comment && comment.trim() !== "") lines.push("", comment.trim());
  if (reviewComments.length > 0) {
    lines.push("", "行內留言：");
    const sorted = [...reviewComments].sort(
      (a, b) => a.path.localeCompare(b.path) || a.line - b.line,
    );
    for (const c of sorted) {
      const side = c.side === "old" ? "（修改前）" : "";
      lines.push(`- ${c.path}:${c.line}${side}：${c.body}`);
    }
  }
  let screenshotNumber = 0;
  if (previewComments.length > 0) {
    lines.push("", "在 Preview 上的留言：");
    for (const { input, screenshot } of previewComments) {
      const where = input.selector ? `${input.url}（${input.selector}）` : input.url;
      const image = screenshot ? `（截圖 ${++screenshotNumber}）` : "";
      lines.push(`- ${where}${image}：${input.body}`);
    }
  }
  const blocks: ContentBlock[] = [{ type: "text", text: lines.join("\n") }];
  for (const { screenshot } of previewComments) {
    if (screenshot) blocks.push({ type: "image", ...screenshot });
  }
  return blocks;
}

/** Task 的 Repo 是不是本機 Repo（核准後改走本機合併）。 */
export async function isLocalRepoTask(tx: Executor, repoId: string | null): Promise<boolean> {
  if (!repoId) return false;
  const [repo] = await tx.select({ kind: repos.kind }).from(repos).where(eq(repos.id, repoId));
  return repo?.kind === "local";
}

/** 依 Project 目前的設定組出 `merge_local`（合併方式、合併後是否 push 基準分支）。 */
export function localMergeAction(project: {
  localMergeStrategy: "squash" | "merge";
  localPushBase: boolean;
}): RunControlAction {
  return {
    action: "merge_local",
    strategy: project.localMergeStrategy,
    push_base: project.localPushBase,
  };
}
