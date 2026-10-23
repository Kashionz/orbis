// Needs You 與 Gate（ARCHITECTURE §5、§8、§10）。
//
// - Needs You：權限請求依授權即時計算（本人有權回覆的才列出）；Gate 與停下來的 Run 依指派的 Member。
// - 權限請求：有權回覆的人送出選項後轉成 RunControl `permission_response` 送給 Runner。
// - Review Gate：核准（Task → PR Open，送 gate_result 與 push_branch；push 完成後由 D 軌開 PR）、
//   退回（行內留言存進 review_comments 並打包成 prompt，Task → Running，同一個 session 繼續）、
//   中止（cancel，Task → Ready）。

import {
  API_ROUTES,
  GateDecisionInput,
  type NeedsYouItem,
  type NeedsYouListResponse,
  PermissionResponseInput,
  type ReviewCommentInput,
} from "@orbis/api-contract";
import type { PermissionPurpose } from "@orbis/protocol";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { authorize, authorizePermissionResponse } from "../authz/capabilities";
import {
  actorProjectRoles,
  loadRunScope,
  loadTaskScope,
  type RunScope,
  requireProjectCapability,
} from "../authz/scope";
import { gates, needsYouItems, projects, reviewComments, runners, runs, tasks } from "../db/schema";
import { type Executor, inTransaction } from "../db/tx";
import { toGates, toNeedsYou } from "../http/dto";
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
      // 「不能核准自己的 Task」同時比對目前的與 Gate 建立時的指派對象。
      requireProjectCapability(actor, scope, "approve_gate", gate.assigneeMemberIdAtCreation);
    } else if (input.action === "reject") {
      requireProjectCapability(actor, { ...scope, task: undefined }, "approve_gate");
    } else requireProjectCapability(actor, scope, "edit_task");
    if (gate.kind !== "review") {
      // TODO(B2)：Plan Gate 的核准與退回。
      throw conflict("B1 只支援 Review Gate");
    }
    if (!gate.runId) throw conflict("這個 Gate 沒有對應的 Run");
    const runId = gate.runId;

    const actedBy = { source: "api", actorMemberId: actor.memberId } as const;
    const updated = await inTransaction(db, async (uow) => {
      const { tx } = uow;
      const now = s.clock.now();
      const comments: ReviewCommentInput[] = input.action === "reject" ? input.reviewComments : [];
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
      if (comments.length > 0) {
        await tx.insert(reviewComments).values(
          comments.map((comment) => ({
            gateId: gate.id,
            path: comment.path,
            line: comment.line,
            side: comment.side,
            body: comment.body,
            authorMemberId: actor.memberId,
          })),
        );
      }
      await tx
        .update(needsYouItems)
        .set({
          resolvedAt: now,
          resolvedByMemberId: actor.memberId,
          resolution: { action: input.action },
        })
        .where(and(eq(needsYouItems.gateId, gate.id), isNull(needsYouItems.resolvedAt)));

      if (input.action === "approve") {
        await s.lifecycle.transition(uow, gate.taskId, "pr_open", "gate", actedBy);
        await s.runControls.send(
          tx,
          runId,
          { action: "gate_result", gate: "review", decision: "approved" },
          uow,
          actor.memberId,
        );
        await s.runControls.send(tx, runId, { action: "push_branch" }, uow, actor.memberId);
      } else if (input.action === "reject") {
        await s.lifecycle.transition(uow, gate.taskId, "running", "gate", actedBy);
        await s.runControls.send(
          tx,
          runId,
          { action: "gate_result", gate: "review", decision: "rejected" },
          uow,
          actor.memberId,
        );
        await s.runControls.send(
          tx,
          runId,
          {
            action: "prompt",
            prompt: [{ type: "text", text: rejectionPrompt(input.comment, comments) }],
          },
          uow,
          actor.memberId,
        );
      } else {
        await s.lifecycle.transition(uow, gate.taskId, "ready", "run_stopped", actedBy);
        await s.runControls.send(tx, runId, { action: "cancel" }, uow, actor.memberId);
      }
      return decided;
    });
    const [gateView] = await toGates(db, [updated]);
    return c.json(gateView);
  });

  return app;
}

/** Review Gate 退回時送給 Agent 的 prompt：整體說明加上依檔案排序的行內留言。 */
export function rejectionPrompt(
  comment: string | null,
  reviewComments: ReviewCommentInput[],
): string {
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
  return lines.join("\n");
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
