// Run：派工、查詢、中止、Event 重播與 review diff（ARCHITECTURE §4、§6.1、§10、§14）。

import type { RunEvent } from "@orbis/api-contract";
import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { loadRunScope, loadTaskScope, requireProjectCapability } from "../authz/scope";
import { CreateRunInput, REVIEW_DIFF_EVENT_KIND } from "../contract-pending";
import { dispatches, needsYouItems, runs, taskDependencies, tasks } from "../db/schema";
import { inTransaction } from "../db/tx";
import { isTerminalRunStatus } from "../domain/run-status";
import { isInFlight } from "../domain/task-state-machine";
import { toRun, toRunEvent } from "../http/dto";
import { ApiError, conflict, notFound, readId, readJson, readQuery } from "../http/errors";
import type { AppEnv } from "../http/session";
import { branchName, runSequence } from "../runner/dispatcher";
import type { Services } from "../services";

const ListEventsQuery = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export function createRunRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  app.get("/tasks/:taskId/runs", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, scope.task.id))
      .orderBy(asc(runs.createdAt), asc(runs.id));
    return c.json(rows.map(toRun));
  });

  /**
   * 派工：建立 Run 並放進佇列。Task 必須在 Ready、相依的 Task 都已 Done。
   * Permission Policy 未指定時用 Project 的預設；`yolo` 只能用在「我的電腦」（Local Runner）。
   */
  app.post("/tasks/:taskId/runs", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadTaskScope(db, actor, readId(c, "taskId", "Task"));
    const input = await readJson(c, CreateRunInput);
    requireProjectCapability(
      actor,
      scope,
      input.runnerKind === "local" ? "dispatch_local" : "dispatch_team",
    );
    const permissionPolicy = input.permissionPolicy ?? scope.project.defaultPermissionPolicy;
    if (permissionPolicy === "yolo" && input.runnerKind === "team") {
      throw new ApiError(422, "invalid_input", "Team Runner 不接受 yolo 的 Permission Policy");
    }

    const run = await inTransaction(db, async (uow) => {
      const { tx } = uow;
      const [blocking] = await tx
        .select({ n: count() })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
        .where(and(eq(taskDependencies.taskId, scope.task.id), ne(tasks.status, "done")));
      if ((blocking?.n ?? 0) > 0) throw conflict("相依的 Task 還沒完成，不能派工");

      const task = await s.lifecycle.startRun(uow, scope.task.id);
      const [created] = await tx
        .insert(runs)
        .values({
          taskId: task.id,
          agent: input.agent,
          model: input.model,
          permissionPolicy,
          target: input.runnerKind,
          requestedByMemberId: actor.memberId,
        })
        .returning();
      if (!created) throw new Error("建立 Run 失敗");
      const seq = await runSequence(tx, created);
      const [withBranch] = await tx
        .update(runs)
        .set({ branch: branchName(task.key, task.title, seq) })
        .where(eq(runs.id, created.id))
        .returning();
      uow.afterCommit(() => void s.dispatcher.kick());
      return withBranch ?? created;
    });
    return c.json(toRun(run), 201);
  });

  app.get("/runs/:runId", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "view");
    return c.json(toRun(scope.run));
  });

  /** 中止 Run。還沒被 Runner 接受時直接結束；已在 Runner 上執行時送 cancel，結果以 Event 回報。 */
  app.post("/runs/:runId/cancel", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "edit_task");
    if (isTerminalRunStatus(scope.run.status)) throw conflict("Run 已經結束");

    const run = await inTransaction(db, async (uow) => {
      const { tx } = uow;
      const [current] = await tx.select().from(runs).where(eq(runs.id, scope.run.id)).for("update");
      if (!current || isTerminalRunStatus(current.status)) throw conflict("Run 已經結束");
      if (current.status === "queued" || current.status === "dispatched") {
        const now = s.clock.now();
        await tx
          .update(dispatches)
          .set({ status: "expired" })
          .where(and(eq(dispatches.runId, current.id), eq(dispatches.status, "offered")));
        await tx
          .update(needsYouItems)
          .set({ resolvedAt: now, resolution: { reason: "run_canceled" } })
          .where(and(eq(needsYouItems.runId, current.id), isNull(needsYouItems.resolvedAt)));
        const [canceled] = await tx
          .update(runs)
          .set({ status: "canceled", finishedAt: now })
          .where(eq(runs.id, current.id))
          .returning();
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, current.taskId));
        if (task && current.parentRunId === null && isInFlight(task.status)) {
          await s.lifecycle.transition(uow, task.id, "ready", "run_stopped");
        }
        return canceled ?? current;
      }
      await s.runControls.send(tx, current.id, { action: "cancel" }, uow);
      return current;
    });
    return c.json(toRun(run), 202);
  });

  app.get("/runs/:runId/events", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "view");
    const query = readQuery(c, ListEventsQuery);
    const rows = await s.eventStore.list(scope.run.id, query.afterSeq, query.limit);
    return c.json(rows.map(toRunEvent) satisfies RunEvent[]);
  });

  /** 最新一份 review diff（Runner 進入 Review Gate 前送出）。還沒有時回 404。 */
  app.get("/runs/:runId/review-diff", auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "view");
    const row = await s.eventStore.latestOfKind(scope.run.id, REVIEW_DIFF_EVENT_KIND);
    if (!row) throw notFound("review diff");
    return c.json(toRunEvent(row));
  });

  return app;
}
