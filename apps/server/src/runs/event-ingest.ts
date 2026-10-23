// 處理 Runner 送來的 `event` frame（ARCHITECTURE §6.1、§14）。
//
// 1. 確認 dispatch_id 是這台 Runner 上、這個 Run 目前已接受的 Dispatch；否則拒絕（不 ack）。
// 2. 以 (run_id, seq) 去除重複後寫入 run_events。
// 3. 只對第一次寫入的 Event 套用副作用（投影）：Run 欄位、Run 狀態、Task 狀態、Gate、Verification、
//    Needs You。只有主 Run（domain/run-status.ts 的 isPrimaryRun）會推動 Task 的狀態。
// 4. commit 後回 event_ack（連續保存的最大 seq），並通知 Web 推送。

import type { EventAck, RunStatus } from "@orbis/protocol";
import {
  GATE_KINDS,
  PERMISSION_OPTION_KINDS,
  PERMISSION_PURPOSES,
  RUN_STATUSES,
  VERIFICATION_OUTCOMES,
} from "@orbis/protocol";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import {
  childQuestions,
  dispatches,
  needsYouItems,
  runControls,
  runEvents,
  runs,
  taskComments,
  tasks,
} from "../db/schema";
import { inTransaction, type UnitOfWork } from "../db/tx";
import { isPrimaryRun, isTerminalRunStatus } from "../domain/run-status";
import type { TaskLifecycleService } from "../domain/task-lifecycle";
import { isInFlight } from "../domain/task-state-machine";
import type { Logger } from "../logger";
import { permissionRequestRecipients } from "../notifications/recipients";
import type { Notify } from "../notifications/types";
import { addQuestionToNeedsYou } from "../tools/delegation-tools";
import type { RunWatch } from "../tools/run-watch";
import { cancelChildren } from "./children";
import type { EventStore } from "./event-store";
import { gateRecipients, openGate } from "./gates";
import type { RunControlService } from "./run-control";
import type { VerificationService } from "./verification";

/** event frame 的外層；各 kind 的內容只在套用副作用時才驗證。 */
const EventFrameEnvelope = z.looseObject({
  type: z.literal("event"),
  dispatch_id: z.uuid(),
  run_id: z.uuid(),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ts: z.iso.datetime({ offset: true }),
  kind: z.string().min(1),
});

const PermissionRequestBody = z.object({
  request_id: z.string().min(1),
  tool_call_id: z.string().nullable(),
  title: z.string(),
  options: z
    .array(
      z.object({
        option_id: z.string().min(1),
        name: z.string(),
        kind: z.enum(PERMISSION_OPTION_KINDS),
      }),
    )
    .min(1),
  purpose: z.enum(PERMISSION_PURPOSES),
});

const PermissionResolvedBody = z.object({
  request_id: z.string().min(1),
  selected_option_id: z.string().nullable(),
});

const StatusChangedBody = z.object({
  status: z.enum(RUN_STATUSES),
  gate: z.enum(GATE_KINDS).nullable(),
  message: z.string().nullable(),
});

const WorktreeReadyBody = z.object({
  worktree_path: z.string().min(1),
  branch: z.string().min(1).nullable(),
  base_commit: z.string().min(1),
});

const TokenCount = z.number().int().nonnegative().nullable();
const UsageBody = z.object({
  input_tokens: TokenCount,
  output_tokens: TokenCount,
  thought_tokens: TokenCount,
  cached_read_tokens: TokenCount,
  cached_write_tokens: TokenCount,
  context_used_tokens: TokenCount,
  context_window_tokens: TokenCount,
  cost: z.object({ amount: z.number(), currency: z.string() }).nullable(),
});

export { RUN_DIFF_EVENT_KIND } from "./gates";

const VerificationOutcomeSchema = z.enum(VERIFICATION_OUTCOMES);

const VerificationResultBody = z.object({
  verification_id: z.uuid(),
  attempt: z.number().int().positive(),
  criterion_id: z.uuid(),
  outcome: VerificationOutcomeSchema,
  summary: z.string(),
  evidence: z.array(z.looseObject({ type: z.string() })),
  judged_by_run_id: z.uuid().nullable(),
});

const VerificationCompletedBody = z.object({
  verification_id: z.uuid(),
  attempt: z.number().int().positive(),
  outcome: VerificationOutcomeSchema,
});

const AgentSessionBody = z.object({ session_id: z.string().min(1) });

export type IngestResult =
  | { ok: true; ack: EventAck; inserted: boolean }
  | { ok: false; reason: "invalid_frame" | "stale_dispatch" };

type RunRow = typeof runs.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export interface EventIngestDeps {
  db: Database;
  store: EventStore;
  lifecycle: TaskLifecycleService;
  verification: VerificationService;
  runControls: RunControlService;
  watch: RunWatch;
  /** Feedback Loop 的修正 Run 沒有 push 就結束（GitHub 整合的 onFeedbackRunEnded）。 */
  onFeedbackRunEnded?: (runId: string) => void | Promise<void>;
  notify: Notify;
  clock: Clock;
  logger: Logger;
}

export class EventIngest {
  private readonly db: Database;
  private readonly store: EventStore;
  private readonly lifecycle: TaskLifecycleService;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(private readonly deps: EventIngestDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.lifecycle = deps.lifecycle;
    this.clock = deps.clock;
    this.logger = deps.logger;
  }

  async ingest(runnerId: string, frame: unknown): Promise<IngestResult> {
    const parsed = EventFrameEnvelope.safeParse(frame);
    if (!parsed.success) {
      this.logger.warn({ runnerId, issues: parsed.error.issues }, "event frame 格式不正確，忽略");
      return { ok: false, reason: "invalid_frame" };
    }
    const { type: _type, dispatch_id, run_id, seq, ts, ...body } = parsed.data;
    const payload = body as Record<string, unknown> & { kind: string };

    const inserted = await inTransaction(this.db, async (uow) => {
      const { tx } = uow;
      const [dispatch] = await tx
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(
          and(
            eq(dispatches.id, dispatch_id),
            eq(dispatches.runId, run_id),
            eq(dispatches.runnerId, runnerId),
            inArray(dispatches.status, ["accepted", "completed"]),
          ),
        )
        .for("share");
      if (!dispatch) return null;

      const fresh = await this.store.insert(tx, {
        runId: run_id,
        seq,
        ts: new Date(ts),
        kind: payload.kind,
        payload,
      });
      if (fresh) await this.project(uow, run_id, seq, payload);
      return fresh;
    });

    if (inserted === null) {
      this.logger.warn(
        { runnerId, runId: run_id, dispatchId: dispatch_id, seq },
        "拒絕不屬於目前 Dispatch 的 Event",
      );
      return { ok: false, reason: "stale_dispatch" };
    }
    if (inserted) {
      this.store.notifyAppended(run_id);
      // 喚醒等待這個 Run 的工具呼叫（父 Run 的 wait_run）。
      this.deps.watch.changed(run_id);
    }
    const last = await this.store.lastContiguousSeq(run_id);
    return { ok: true, inserted, ack: { run_id, seq: last } };
  }

  /** 依 Event 的種類更新 Run、Task、Gate 與 Needs You。內容格式不符時只記 log。 */
  private async project(
    uow: UnitOfWork,
    runId: string,
    seq: number,
    payload: Record<string, unknown> & { kind: string },
  ): Promise<void> {
    const { tx } = uow;
    const parse = <S extends z.ZodType>(schema: S): z.output<S> | null => {
      const result = schema.safeParse(payload);
      if (result.success) return result.data;
      this.logger.warn({ runId, seq, kind: payload.kind }, "Event 內容格式不正確，略過副作用");
      return null;
    };

    switch (payload.kind) {
      case "worktree_ready": {
        const body = parse(WorktreeReadyBody);
        if (!body) return;
        await tx
          .update(runs)
          .set({
            worktreePath: body.worktree_path,
            baseCommit: body.base_commit,
            ...(body.branch !== null && { branch: body.branch }),
          })
          .where(eq(runs.id, runId));
        return;
      }
      case "usage": {
        const body = parse(UsageBody);
        if (!body) return;
        await tx
          .update(runs)
          .set({
            usage: {
              inputTokens: body.input_tokens,
              outputTokens: body.output_tokens,
              thoughtTokens: body.thought_tokens,
              cachedReadTokens: body.cached_read_tokens,
              cachedWriteTokens: body.cached_write_tokens,
              contextUsedTokens: body.context_used_tokens,
              contextWindowTokens: body.context_window_tokens,
              cost: body.cost,
            },
          })
          .where(eq(runs.id, runId));
        return;
      }
      case "permission_request": {
        const body = parse(PermissionRequestBody);
        if (!body) return;
        const context = await this.runContext(uow, runId);
        if (!context) return;
        await tx.insert(needsYouItems).values({
          projectId: context.task.projectId,
          memberId: context.run.requestedByMemberId ?? context.task.assigneeMemberId,
          kind: "permission_request",
          taskId: context.task.id,
          runId,
          payload: {
            permissionRequestId: body.request_id,
            toolCallId: body.tool_call_id,
            title: body.title,
            purpose: body.purpose,
            options: body.options.map((o) => ({
              optionId: o.option_id,
              name: o.name,
              kind: o.kind,
            })),
          },
        });
        await this.deps.notify.notify(uow, {
          kind: "permission_request",
          recipients: await permissionRequestRecipients(
            tx,
            context.run,
            context.task,
            body.purpose,
          ),
          taskId: context.task.id,
          runId,
          title: `${context.task.key} 的 Agent 在等待權限`,
          body: body.title,
        });
        return;
      }
      case "permission_resolved": {
        const body = parse(PermissionResolvedBody);
        if (!body) return;
        await tx
          .update(needsYouItems)
          .set({
            resolvedAt: this.clock.now(),
            resolution: { selectedOptionId: body.selected_option_id },
          })
          .where(
            and(
              eq(needsYouItems.runId, runId),
              eq(needsYouItems.kind, "permission_request"),
              isNull(needsYouItems.resolvedAt),
              sql`${needsYouItems.payload}->>'permissionRequestId' = ${body.request_id}`,
            ),
          );
        return;
      }
      case "status_changed": {
        const body = parse(StatusChangedBody);
        if (!body) return;
        await this.onStatusChanged(uow, runId, body.status, body.gate, body.message);
        return;
      }
      case "agent_session": {
        const body = parse(AgentSessionBody);
        if (!body) return;
        await tx.update(runs).set({ agentSessionId: body.session_id }).where(eq(runs.id, runId));
        return;
      }
      case "verification_result": {
        const body = parse(VerificationResultBody);
        if (!body) return;
        const context = await this.runContext(uow, runId);
        if (context) await this.deps.verification.onResult(uow, context.run, body);
        return;
      }
      case "verification_completed": {
        const body = parse(VerificationCompletedBody);
        if (!body) return;
        const context = await this.runContext(uow, runId);
        if (context && isPrimaryRun(context.run)) {
          await this.deps.verification.onCompleted(uow, context.run, context.task, body);
        }
        return;
      }
      default:
        return;
    }
  }

  private async runContext(
    uow: UnitOfWork,
    runId: string,
  ): Promise<{ run: RunRow; task: TaskRow } | null> {
    const [row] = await uow.tx
      .select({ run: runs, task: tasks })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, runId))
      .for("update");
    return row ?? null;
  }

  private async onStatusChanged(
    uow: UnitOfWork,
    runId: string,
    status: RunStatus,
    gate: "plan" | "review" | null,
    message: string | null,
  ): Promise<void> {
    const { tx } = uow;
    const context = await this.runContext(uow, runId);
    if (!context) return;
    const { run, task } = context;
    if (isTerminalRunStatus(run.status)) {
      this.logger.warn({ runId, status }, "Run 已結束，忽略之後的狀態變更");
      return;
    }
    const now = this.clock.now();
    const terminal = isTerminalRunStatus(status);
    await tx
      .update(runs)
      .set({
        status,
        ...(status === "running" && run.startedAt === null && { startedAt: now }),
        ...(terminal && { finishedAt: now }),
      })
      .where(eq(runs.id, runId));
    uow.afterCommit(() =>
      this.lifecycle.emit({
        type: "task.run_changed",
        taskId: task.id,
        projectId: task.projectId,
        runId,
        source: "system",
      }),
    );

    const primary = isPrimaryRun(run);

    if (status === "awaiting_gate") {
      // 回合結束：還沒回答的 Child Run 問題改由人在 Needs You 回答。
      await this.moveOpenQuestionsToNeedsYou(uow, run, task);
    }

    if (status === "awaiting_gate" && gate === "review" && primary) {
      // Agent 結束回合：開始 Verification（Verification 結束後 Runner 再送一次，那時不做事）。
      await this.deps.verification.onTurnEnded(uow, run, task, run.status);
      return;
    }
    if (status === "awaiting_gate" && gate === "plan" && primary) {
      await this.openPlanGate(uow, run, task);
      return;
    }
    if (!terminal) return;

    await tx
      .update(dispatches)
      .set({ status: "completed" })
      .where(and(eq(dispatches.runId, runId), eq(dispatches.status, "accepted")));
    // 父 Run 結束時連同 Child Run 一起結束。
    const canceled = await cancelChildren(uow, runId, this.deps.runControls, now);
    uow.afterCommit(() => {
      for (const id of canceled) this.deps.watch.changed(id);
    });
    if (run.origin === "mention") await this.postMentionReply(uow, run, status, message);
    // Run 結束後，還沒回覆的權限請求與等待中的 Gate 都不必再處理。
    await tx
      .update(needsYouItems)
      .set({ resolvedAt: now, resolution: { reason: "run_ended", status, message } })
      .where(
        and(
          eq(needsYouItems.runId, runId),
          inArray(needsYouItems.kind, ["permission_request", "gate"]),
          isNull(needsYouItems.resolvedAt),
        ),
      );
    if (run.origin === "feedback_loop") {
      // Feedback Loop 的修正 Run：PR 還開著，Task 回到 PR Open；沒有 push 就結束時通知 GitHub 整合。
      if (task.status === "running" || task.status === "verifying") {
        await this.lifecycle.transition(uow, task.id, "pr_open", "feedback_loop");
      }
      const pushed = await uow.tx
        .select({ id: runControls.controlId })
        .from(runControls)
        .where(and(eq(runControls.runId, runId), eq(runControls.outcome, "branch_pushed")));
      if (pushed.length === 0) uow.afterCommit(() => this.deps.onFeedbackRunEnded?.(runId));
      return;
    }
    if (status !== "completed" && primary && isInFlight(task.status)) {
      await this.lifecycle.transition(uow, task.id, "ready", "run_stopped");
    }
  }

  /** @agent 的 consult Run 結束：把 Agent 最後的回覆貼回成 Task 留言（作者是這個 Run）。 */
  private async postMentionReply(
    uow: UnitOfWork,
    run: RunRow,
    status: RunStatus,
    message: string | null,
  ): Promise<void> {
    const [last] = await uow.tx
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.kind, "final_message")))
      .orderBy(desc(runEvents.seq))
      .limit(1);
    const text = (last?.payload as { text?: { type: string; text?: string } } | undefined)?.text;
    const reply =
      text?.type === "inline" && text.text
        ? text.text
        : status === "completed"
          ? "（Agent 沒有留下回覆）"
          : `（Run 沒有完成：${message ?? status}）`;
    await uow.tx
      .insert(taskComments)
      .values({ taskId: run.taskId, authorRunId: run.id, body: reply });
  }

  private async moveOpenQuestionsToNeedsYou(
    uow: UnitOfWork,
    run: RunRow,
    task: TaskRow,
  ): Promise<void> {
    const open = await uow.tx
      .select()
      .from(childQuestions)
      .where(and(eq(childQuestions.parentRunId, run.id), isNull(childQuestions.answeredAt)));
    for (const question of open) {
      await addQuestionToNeedsYou(
        uow,
        { task },
        run,
        question.id,
        question.question,
        this.deps.notify,
      );
    }
  }

  /** plan 產出：Task Planning → Plan Gate，建立 Gate、Needs You 與通知。 */
  private async openPlanGate(uow: UnitOfWork, run: RunRow, task: TaskRow): Promise<void> {
    if (task.status !== "planning") {
      this.logger.warn(
        { runId: run.id, taskStatus: task.status },
        "Task 不在 Planning，略過進入 Plan Gate",
      );
      return;
    }
    const updated = await this.lifecycle.transition(uow, task.id, "plan_gate", "run");
    const gate = await openGate(uow, "plan", run, updated);
    await this.deps.notify.notify(uow, {
      kind: "gate_pending",
      recipients: await gateRecipients(uow.tx, gate),
      taskId: task.id,
      runId: run.id,
      gateId: gate.id,
      title: `${task.key} 的 plan 等待核准`,
      body: task.title,
    });
  }
}
