// Run：派工、派工對話框的選項、查詢、中止、Event 重播與 review diff（ARCHITECTURE §4、§6.1、§10、§14）。

import {
  API_ROUTES,
  CreateRunInput,
  type DispatchOptions,
  type ReviewDiff,
  type RunEvent,
  VerificationDecisionInput,
} from "@orbis/api-contract";
import type { RunDiff, TextBody } from "@orbis/protocol";
import { and, asc, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { authorize } from "../authz/capabilities";
import {
  loadProjectScope,
  loadRunScope,
  loadTaskScope,
  type ProjectScope,
  requireProjectCapability,
} from "../authz/scope";
import {
  agentAvailabilities,
  dispatches,
  needsYouItems,
  runners,
  runs,
  taskDependencies,
  tasks,
  verifications,
} from "../db/schema";
import { inTransaction } from "../db/tx";
import { isPrimaryRun, isTerminalRunStatus } from "../domain/run-status";
import { planGateEnabled } from "../domain/task-lifecycle";
import { isInFlight } from "../domain/task-state-machine";
import { toRun, toRunEvent, toVerifications } from "../http/dto";
import { ApiError, conflict, notFound, readId, readJson, readQuery } from "../http/errors";
import type { AppEnv } from "../http/session";
import { summarizeDispatchTarget } from "../runner/dispatch-options";
import { branchName, runSequence } from "../runner/dispatcher";
import { RUN_DIFF_EVENT_KIND } from "../runs/event-ingest";
import { FINAL_MESSAGE_EVENT_KIND } from "../runs/gates";
import type { Services } from "../services";

const ListEventsQuery = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export function createRunRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  app.get(API_ROUTES.taskRuns, auth, async (c) => {
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
  app.post(API_ROUTES.taskRuns, auth, async (c) => {
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

      const task = await s.lifecycle.startRun(uow, scope.task.id, {
        planGate: planGateEnabled(scope.task, scope.project),
      });
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

  app.get(API_ROUTES.run, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "view");
    return c.json(toRun(scope.run));
  });

  /** 中止 Run。還沒被 Runner 接受時直接結束；已在 Runner 上執行時送 cancel，結果以 Event 回報。 */
  app.post(API_ROUTES.runCancel, auth, async (c) => {
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
          await s.lifecycle.transition(uow, task.id, "ready", "run_stopped", {
            source: "api",
            actorMemberId: actor.memberId,
          });
        }
        return canceled ?? current;
      }
      await s.runControls.send(tx, current.id, { action: "cancel" }, uow, actor.memberId);
      return current;
    });
    return c.json(toRun(run), 202);
  });

  app.get(API_ROUTES.runEvents, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "view");
    const query = readQuery(c, ListEventsQuery);
    const rows = await s.eventStore.list(scope.run.id, query.afterSeq, query.limit);
    return c.json(rows.map(toRunEvent) satisfies RunEvent[]);
  });

  /** 最新一份 review diff（Runner 進入 Review Gate 前送出的 `run_diff` Event）。還沒有時回 404。 */
  /** 這個 Run 的每一輪 Verification 與每條條件的結果、證據（ARCHITECTURE §5.1）。 */
  app.get(API_ROUTES.runVerifications, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "view");
    const rows = await db
      .select()
      .from(verifications)
      .where(eq(verifications.runId, scope.run.id))
      .orderBy(asc(verifications.startedAt), asc(verifications.id));
    return c.json(await toVerifications(db, rows));
  });

  /**
   * Verification 超過重試上限、Task 停在 Verifying 時人的決定：附意見再試、略過失敗進入 Review Gate、
   * 中止。略過失敗等於核准這一版的修改，需要核准 Gate 的權限；其他需要編輯 Task 的權限。
   */
  app.post(API_ROUTES.runVerificationDecision, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    const input = await readJson(c, VerificationDecisionInput);
    requireProjectCapability(actor, scope, input.action === "skip" ? "approve_gate" : "edit_task");
    if (!isPrimaryRun(scope.run)) throw conflict("這個 Run 不經過 Verification");
    await inTransaction(db, (uow) => s.verification.decide(uow, scope.run, input, actor.memberId));
    const rows = await db
      .select()
      .from(verifications)
      .where(eq(verifications.runId, scope.run.id))
      .orderBy(asc(verifications.startedAt), asc(verifications.id));
    return c.json(await toVerifications(db, rows));
  });

  app.get(API_ROUTES.runReviewDiff, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "view");
    const row = await s.eventStore.latestOfKind(scope.run.id, RUN_DIFF_EVENT_KIND);
    if (!row) throw notFound("review diff");
    const diff = row.payload as RunDiff;
    // Agent 結束回合時先送 final_message 再送 run_diff：取這份 diff 之前最新的一則。
    const final = await s.eventStore.latestOfKind(scope.run.id, FINAL_MESSAGE_EVENT_KIND, row.seq);
    return c.json({
      runId: row.runId,
      seq: row.seq,
      baseCommit: diff.base_commit,
      files: diff.files.map((file) => ({
        path: file.path,
        oldPath: file.old_path,
        change: file.change,
        binary: file.binary,
        old: file.old,
        new: file.new,
      })),
      finalMessage: final ? (final.payload as { text: TextBody }).text : null,
    } satisfies ReviewDiff);
  });

  /**
   * 派工對話框的選項：依目前 Member 的 Role 與 Project 政策，列出「我的電腦」（本人的 Local Runner）
   * 與 Team Runner 目前能跑的 Agent，以及 Project 預設的 Permission Policy。
   */
  app.get(API_ROUTES.projectDispatchOptions, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await loadProjectScope(db, actor, readId(c, "projectId", "Project"));
    requireProjectCapability(actor, scope, "view");
    return c.json({
      local: await dispatchTarget(s, actor.memberId, scope, "local"),
      team: await dispatchTarget(s, actor.memberId, scope, "team"),
      defaultPermissionPolicy: scope.project.defaultPermissionPolicy,
    } satisfies DispatchOptions);
  });

  return app;
}

/**
 * 某一種 Runner 的派工選項。不能派工到這種 Runner（Role 或 Project 政策），
 * 或沒有任何這種 Runner（Local：本人還沒完成 Pairing）時為 null。
 */
async function dispatchTarget(
  s: Services,
  memberId: string,
  scope: ProjectScope,
  kind: "local" | "team",
): Promise<DispatchOptions["local"]> {
  const allowed = authorize(kind === "local" ? "dispatch_local" : "dispatch_team", {
    memberId,
    role: scope.role,
    project: {
      allowMemberTeamRunnerDispatch: scope.project.allowMemberTeamRunnerDispatch,
      forbidSelfApproval: scope.project.forbidSelfApproval,
    },
  });
  if (!allowed.ok) return null;
  const rows = await s.db
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        eq(runners.teamId, scope.project.teamId),
        eq(runners.kind, kind),
        isNull(runners.revokedAt),
        kind === "local" ? eq(runners.memberId, memberId) : undefined,
      ),
    )
    .orderBy(asc(runners.createdAt), asc(runners.id));
  if (rows.length === 0) return null;
  const availability = await s.db
    .select()
    .from(agentAvailabilities)
    .where(
      inArray(
        agentAvailabilities.runnerId,
        rows.map((r) => r.id),
      ),
    );
  return summarizeDispatchTarget(
    rows.map((runner) => ({
      dispatchable: s.hub.isOnline(runner.id) && s.hub.isAcceptingDispatches(runner.id),
      agents: availability.filter((a) => a.runnerId === runner.id),
    })),
  );
}
