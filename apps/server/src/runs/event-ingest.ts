// 處理 Runner 送來的 `event` frame（ARCHITECTURE §6.1、§14）。
//
// 1. 確認 dispatch_id 是這台 Runner 上、這個 Run 目前已接受的 Dispatch；否則拒絕（不 ack）。
// 2. 以 (run_id, seq) 去除重複後寫入 run_events。
// 3. 只對第一次寫入的 Event 套用副作用（投影）：Run 欄位、Run 狀態、Task 狀態、Gate、Needs You。
// 4. commit 後回 event_ack（連續保存的最大 seq），並通知 Web 推送。

import type { EventAck, RunStatus } from "@orbis/protocol";
import { RUN_STATUSES } from "@orbis/protocol";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "../clock";
import { REVIEW_DIFF_EVENT_KIND } from "../contract-pending";
import type { Database } from "../db/client";
import { dispatches, gates, needsYouItems, runEvents, runs, tasks } from "../db/schema";
import { inTransaction, type UnitOfWork } from "../db/tx";
import { isTerminalRunStatus } from "../domain/run-status";
import type { TaskLifecycleService } from "../domain/task-lifecycle";
import { isInFlight } from "../domain/task-state-machine";
import type { Logger } from "../logger";
import type { EventStore } from "./event-store";

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
        kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
      }),
    )
    .min(1),
});

const PermissionResolvedBody = z.object({
  request_id: z.string().min(1),
  selected_option_id: z.string().nullable(),
});

const StatusChangedBody = z.object({
  status: z.enum(RUN_STATUSES),
  gate: z.enum(["plan", "review"]).nullable(),
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

export type IngestResult =
  | { ok: true; ack: EventAck; inserted: boolean }
  | { ok: false; reason: "invalid_frame" | "stale_dispatch" };

type RunRow = typeof runs.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export class EventIngest {
  constructor(
    private readonly db: Database,
    private readonly store: EventStore,
    private readonly lifecycle: TaskLifecycleService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

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
    if (inserted) this.store.notifyAppended(run_id);
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
            options: body.options.map((o) => ({
              optionId: o.option_id,
              name: o.name,
              kind: o.kind,
            })),
          },
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

    const topLevel = run.parentRunId === null;

    if (status === "awaiting_gate" && gate === "review" && topLevel) {
      await this.openReviewGate(uow, run, task);
      return;
    }
    if (status === "awaiting_gate" && gate === "plan") {
      // TODO(B2)：Planning 與 Plan Gate。
      this.logger.warn({ runId }, "B1 尚未支援 Plan Gate，忽略");
      return;
    }
    if (!terminal) return;

    await tx
      .update(dispatches)
      .set({ status: "completed" })
      .where(and(eq(dispatches.runId, runId), eq(dispatches.status, "accepted")));
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
    if (status !== "completed" && topLevel && isInFlight(task.status)) {
      await this.lifecycle.transition(uow, task.id, "ready", "run_stopped");
    }
  }

  /** Agent 做完：Task 經 Verifying（直接通過）進入 Review Gate，建立 Gate 與 Needs You。 */
  private async openReviewGate(uow: UnitOfWork, run: RunRow, task: TaskRow): Promise<void> {
    const { tx } = uow;
    if (task.status !== "running") {
      this.logger.warn(
        { runId: run.id, taskStatus: task.status },
        "Task 不在 Running，略過進入 Review Gate",
      );
      return;
    }
    const updated = await this.lifecycle.agentFinished(uow, task.id);
    if (updated.status !== "review_gate") return;

    const [diff] = await tx
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.kind, REVIEW_DIFF_EVENT_KIND)))
      .orderBy(desc(runEvents.seq))
      .limit(1);
    const [created] = await tx
      .insert(gates)
      .values({
        taskId: task.id,
        runId: run.id,
        kind: "review",
        // TODO(contract)：送審內容的格式隨 contract/db 定案；行內留言改存 review_comments。
        subject: {
          reviewDiffSeq: diff?.seq ?? null,
          assigneeMemberId: updated.assigneeMemberId,
        },
      })
      .returning();
    if (!created) throw new Error("建立 Gate 失敗");
    await tx.insert(needsYouItems).values({
      projectId: task.projectId,
      memberId: updated.assigneeMemberId ?? run.requestedByMemberId,
      kind: "gate",
      taskId: task.id,
      runId: run.id,
      gateId: created.id,
    });
  }
}
