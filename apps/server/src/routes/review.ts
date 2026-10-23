// Needs You 與 Gate（ARCHITECTURE §5、§8、§10）。
//
// - Needs You：權限請求依授權即時計算（本人有權回覆的才列出）；Gate 與停下來的 Run 依指派的 Member。
// - 權限請求：有權回覆的人送出選項後轉成 RunControl `permission_response` 送給 Runner。
// - Plan Gate：核准（Task → Running，送 gate_result，Runner 切換成執行模式）、退回（只收整體說明，
//   Task → Planning，意見以 prompt 送回）、中止。
// - Review Gate：核准（manual 條件要全部打勾；Task → PR Open，送 gate_result 與 push_branch；push 完成後
//   由 D 軌開 PR）、退回（行內留言與 Preview 留言存進 review_comments 並打包成同一個 prompt，Task →
//   Running，同一個 session 繼續）、中止（cancel，Task → Ready）。

import {
  API_ROUTES,
  CheckAcceptanceCriterionInput,
  GateDecisionInput,
  type NeedsYouItem,
  type NeedsYouListResponse,
  PermissionResponseInput,
  type PreviewCommentInput,
  type ReviewCommentInput,
} from "@orbis/api-contract";
import type { BlobRef, ContentBlock, PermissionPurpose, RunControlAction } from "@orbis/protocol";
import { and, asc, count, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { z } from "zod";
import { authorize, authorizePermissionResponse } from "../authz/capabilities";
import {
  actorProjectRoles,
  loadRunScope,
  loadTaskScope,
  type RunScope,
  requireProjectCapability,
} from "../authz/scope";
import {
  acceptanceCriteria,
  blobs,
  gates,
  needsYouItems,
  projects,
  reviewComments,
  runners,
  runs,
  tasks,
} from "../db/schema";
import { type Executor, inTransaction } from "../db/tx";
import { toAcceptanceCriterion, toGates, toNeedsYou } from "../http/dto";
import { ApiError, conflict, forbidden, notFound, readId, readJson } from "../http/errors";
import type { Actor, AppEnv } from "../http/session";
import type { Services } from "../services";

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
function runnerOwnerOf(
  run: { target: "local" | "team"; requestedByMemberId: string | null },
  runnerMemberId: string | null | undefined,
): string | null {
  if (run.target !== "local") return null;
  return runnerMemberId ?? run.requestedByMemberId;
}

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
      })
      .from(needsYouItems)
      .innerJoin(projects, eq(projects.id, needsYouItems.projectId))
      .innerJoin(tasks, eq(tasks.id, needsYouItems.taskId))
      .leftJoin(gates, eq(gates.id, needsYouItems.gateId))
      .leftJoin(runs, eq(runs.id, needsYouItems.runId))
      .leftJoin(runners, eq(runners.id, runs.runnerId))
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
      const role = roles(r.project.id);
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
    if (input.action === "approve") {
      // 「不能核准自己的 Task」同時比對目前的與 Gate 建立時的指派對象，所有種類的 Gate 都適用。
      requireProjectCapability(actor, scope, "approve_gate", gate.assigneeMemberIdAtCreation);
    } else if (input.action === "reject") {
      requireProjectCapability(actor, { ...scope, task: undefined }, "approve_gate");
    } else requireProjectCapability(actor, scope, "edit_task");
    if (!gate.runId) throw conflict("這個 Gate 沒有對應的 Run");
    const runId = gate.runId;
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
      if (gate.kind === "review" && input.action === "approve") {
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
          ? await checkPreviewComments(tx, runId, input.previewComments, s.previewDomain)
          : [];
      const [decided] = await tx
        .update(gates)
        .set({
          decision: input.action === "approve" ? "approved" : "rejected",
          decidedAt: now,
          decidedByMemberId: actor.memberId,
          comment:
            input.action === "reject"
              ? input.comment
              : input.action === "abort"
                ? "中止 Run"
                : null,
          ...(input.action === "abort" && {
            subject: { ...((gate.subject ?? {}) as Record<string, unknown>), aborted: true },
          }),
        })
        .where(and(eq(gates.id, gate.id), isNull(gates.decision)))
        .returning();
      if (!decided) throw conflict("這個 Gate 已經有決定了");
      if (diffComments.length > 0 || previewComments.length > 0) {
        await tx.insert(reviewComments).values([
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
        ]);
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
        } else {
          await s.lifecycle.transition(uow, gate.taskId, "pr_open", "gate", actedBy);
          await send({ action: "gate_result", gate: "review", decision: "approved" });
          await send({ action: "push_branch" });
        }
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

  return app;
}

type PreviewCommentParsed = z.output<typeof PreviewCommentInput>;

/** Preview 留言連同截圖的 BlobRef（退回時以圖片附在 prompt 中）。 */
export interface CheckedPreviewComment {
  input: PreviewCommentParsed;
  screenshot: BlobRef | null;
}

/**
 * 檢查 Preview 留言：網址必須是這個 Run 的 Preview（http(s)、host 是 `<run-id>.preview.<domain>`；
 * 有設定 Preview 的網域時整個 host 都要相同），截圖必須是這個 Run 的 blob。
 */
async function checkPreviewComments(
  tx: Executor,
  runId: string,
  comments: PreviewCommentParsed[],
  previewDomain: string | null,
): Promise<CheckedPreviewComment[]> {
  const checked: CheckedPreviewComment[] = [];
  const prefix = `${runId.toLowerCase()}.preview.`;
  for (const comment of comments) {
    const url = new URL(comment.url);
    const host = url.hostname.toLowerCase();
    const sameRun = previewDomain
      ? host === `${prefix}${previewDomain.toLowerCase()}`
      : host.startsWith(prefix) && host.length > prefix.length;
    if (!sameRun || (url.protocol !== "https:" && url.protocol !== "http:")) {
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

/** 確認 Actor 可以回覆這個 Run 的權限請求；不行時丟出 403。 */
async function requirePermissionResponder(
  db: Executor,
  actor: Actor,
  scope: RunScope,
  purpose: PermissionPurpose,
): Promise<void> {
  const [runner] = scope.run.runnerId
    ? await db
        .select({ memberId: runners.memberId })
        .from(runners)
        .where(eq(runners.id, scope.run.runnerId))
    : [];
  const result = authorizePermissionResponse({
    memberId: actor.memberId,
    role: scope.role,
    runnerKind: scope.run.target,
    runnerOwnerMemberId: runnerOwnerOf(scope.run, runner?.memberId),
    purpose,
  });
  if (!result.ok) throw forbidden(result.reason);
}
