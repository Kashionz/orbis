// Needs You 與 Gate（ARCHITECTURE §5、§8、§10）。
//
// - 權限請求：Member 回覆後轉成 RunControl `permission_response` 送給 Runner。
// - Review Gate：核准（Task → PR Open，送 gate_result 與 push_branch；push 完成後由 D 軌開 PR）、
//   退回（行內留言打包成 prompt，Task → Running，同一個 session 繼續）、中止（cancel，Task → Ready）。

import type { NeedsYouItem } from "@orbis/api-contract";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { loadRunScope, loadTaskScope, requireProjectCapability } from "../authz/scope";
import { GateDecisionInput, RespondNeedsYouInput, type ReviewComment } from "../contract-pending";
import { gates, needsYouItems, projects, tasks } from "../db/schema";
import { inTransaction } from "../db/tx";
import { toGate, toNeedsYou } from "../http/dto";
import { ApiError, conflict, notFound, readId, readJson } from "../http/errors";
import type { AppEnv } from "../http/session";
import type { Services } from "../services";

export function createReviewRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  /** 等待我處理的項目（Web 與 Desktop 定期輪詢）。 */
  app.get("/needs-you", auth, async (c) => {
    const actor = c.get("actor");
    const rows = await db
      .select({ item: needsYouItems, taskKey: tasks.key, gateKind: gates.kind })
      .from(needsYouItems)
      .innerJoin(projects, eq(projects.id, needsYouItems.projectId))
      .innerJoin(tasks, eq(tasks.id, needsYouItems.taskId))
      .leftJoin(gates, eq(gates.id, needsYouItems.gateId))
      .where(
        and(
          eq(projects.teamId, actor.teamId),
          eq(needsYouItems.memberId, actor.memberId),
          isNull(needsYouItems.resolvedAt),
        ),
      )
      .orderBy(asc(needsYouItems.createdAt), asc(needsYouItems.id));
    return c.json(
      rows.map(
        (r): NeedsYouItem => toNeedsYou(r.item, { taskKey: r.taskKey, gateKind: r.gateKind }),
      ),
    );
  });

  /** 回覆權限請求。Project 中有效 Role 為 Member 以上的人都可以回覆。 */
  app.post("/needs-you/:itemId/respond", auth, async (c) => {
    const actor = c.get("actor");
    const itemId = readId(c, "itemId", "Needs You 項目");
    const [item] = await db.select().from(needsYouItems).where(eq(needsYouItems.id, itemId));
    if (!item?.runId) throw notFound("Needs You 項目");
    const scope = await loadRunScope(db, actor, item.runId);
    requireProjectCapability(actor, scope, "edit_task");
    if (item.kind !== "permission_request") {
      throw conflict("這個項目不是權限請求；Gate 請用 Gate 的 API 處理");
    }
    const input = await readJson(c, RespondNeedsYouInput);
    const payload = item.payload as {
      permissionRequestId: string;
      options: { optionId: string }[];
    };
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
        item.runId as string,
        {
          action: "permission_response",
          request_id: payload.permissionRequestId,
          option_id: input.optionId,
        },
        uow,
      );
    });
    return c.body(null, 204);
  });

  app.get("/tasks/:taskId/gates", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(gates)
      .where(eq(gates.taskId, scope.task.id))
      .orderBy(asc(gates.createdAt), asc(gates.id));
    return c.json(rows.map(toGate));
  });

  app.post("/gates/:gateId/decision", auth, async (c) => {
    const actor = c.get("actor");
    const gateId = readId(c, "gateId", "Gate");
    const [gate] = await db.select().from(gates).where(eq(gates.id, gateId));
    if (!gate) throw notFound("Gate");
    const scope = await loadTaskScope(db, actor, gate.taskId);
    const input = await readJson(c, GateDecisionInput);
    if (input.action === "approve") {
      // TODO(contract)：Gate 建立時的指派對象改存正式欄位（contract/db）。
      const atCreation = (gate.subject as { assigneeMemberId?: string | null } | null)
        ?.assigneeMemberId;
      requireProjectCapability(actor, scope, "approve_gate", atCreation ?? null);
    } else if (input.action === "reject") {
      requireProjectCapability(actor, { ...scope, task: undefined }, "approve_gate");
    } else requireProjectCapability(actor, scope, "edit_task");
    if (gate.kind !== "review") {
      // TODO(B2)：Plan Gate 的核准與退回。
      throw conflict("B1 只支援 Review Gate");
    }
    if (!gate.runId) throw conflict("這個 Gate 沒有對應的 Run");
    const runId = gate.runId;

    const updated = await inTransaction(db, async (uow) => {
      const { tx } = uow;
      const now = s.clock.now();
      const reviewComments: ReviewComment[] = input.action === "reject" ? input.reviewComments : [];
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
          // TODO(contract)：行內留言改存 gates.review_comments（contract/db）。
          subject: {
            ...((gate.subject ?? {}) as Record<string, unknown>),
            reviewComments,
            ...(input.action === "abort" && { aborted: true }),
          },
        })
        .where(and(eq(gates.id, gate.id), isNull(gates.decision)))
        .returning();
      if (!decided) throw conflict("這個 Gate 已經有決定了");
      await tx
        .update(needsYouItems)
        .set({
          resolvedAt: now,
          resolvedByMemberId: actor.memberId,
          resolution: { action: input.action },
        })
        .where(and(eq(needsYouItems.gateId, gate.id), isNull(needsYouItems.resolvedAt)));

      if (input.action === "approve") {
        await s.lifecycle.transition(uow, gate.taskId, "pr_open", "gate");
        await s.runControls.send(
          tx,
          runId,
          { action: "gate_result", gate: "review", decision: "approved" },
          uow,
        );
        await s.runControls.send(tx, runId, { action: "push_branch" }, uow);
      } else if (input.action === "reject") {
        await s.lifecycle.transition(uow, gate.taskId, "running", "gate");
        await s.runControls.send(
          tx,
          runId,
          { action: "gate_result", gate: "review", decision: "rejected" },
          uow,
        );
        await s.runControls.send(
          tx,
          runId,
          {
            action: "prompt",
            prompt: [{ type: "text", text: rejectionPrompt(input.comment, reviewComments) }],
          },
          uow,
        );
      } else {
        await s.lifecycle.transition(uow, gate.taskId, "ready", "run_stopped");
        await s.runControls.send(tx, runId, { action: "cancel" }, uow);
      }
      return decided;
    });
    return c.json(toGate(updated));
  });

  return app;
}

/** Review Gate 退回時送給 Agent 的 prompt：整體說明加上依檔案排序的行內留言。 */
export function rejectionPrompt(comment: string | null, reviewComments: ReviewComment[]): string {
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
