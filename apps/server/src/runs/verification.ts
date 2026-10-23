// Verifying（ARCHITECTURE §5.1）：由 Server 發起，Runner 執行，結果以 Event 回報。
//
// 1. 主 Run 的 Agent 結束回合（`awaiting_gate(review)`）→ Task Running → Verifying，建立一輪 Verification，
//    送 RunControl `verify`，列出 `command`／`agent`／`browser` 類型的條件。沒有這些條件時直接進 Review Gate。
// 2. 每條條件的 `verification_result` 存進 verification_results，最新的結果寫回 acceptance_criteria。
// 3. `verification_completed`：
//    - 全部通過 → Review Gate。
//    - 有失敗、還沒到 Project 的重試上限（預設 3）→ Task 回到 Running，把失敗原因當 prompt 送回原 Run
//      （同一個 session）；Agent 再次結束回合時開始下一輪。
//    - 到了上限 → Task 停在 Verifying，加入 Needs You（停下來的 Run）並通知，等人決定：附意見再試
//      （次數重算）、略過失敗進入 Review Gate、或中止。
//
// Runner 在 `verification_completed` 之後會再送一次 `awaiting_gate(review)`；那時 Task 已不在 Running，
// 所以不會再開始一輪。

import type { VerificationDecisionInput } from "@orbis/api-contract";
import type { ContentBlock, VerificationCriterion, VerificationOutcome } from "@orbis/protocol";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Clock } from "../clock";
import {
  acceptanceCriteria,
  needsYouItems,
  projects,
  type runs,
  tasks,
  verificationResults,
  verifications,
} from "../db/schema";
import type { Executor, UnitOfWork } from "../db/tx";
import type { TaskLifecycleService } from "../domain/task-lifecycle";
import { conflict } from "../http/errors";
import type { Logger } from "../logger";
import type { Notify } from "../notifications/types";
import { buildPrompt } from "../runner/dispatcher";
import { gateRecipients, openGate } from "./gates";
import type { RunControlService } from "./run-control";

type RunRow = typeof runs.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type VerificationRow = typeof verifications.$inferSelect;

export interface VerificationResultBody {
  verification_id: string;
  attempt: number;
  criterion_id: string;
  outcome: VerificationOutcome;
  summary: string;
  evidence: unknown[];
  judged_by_run_id: string | null;
}

export interface VerificationCompletedBody {
  verification_id: string;
  attempt: number;
  outcome: VerificationOutcome;
}

export class VerificationService {
  constructor(
    private readonly deps: {
      lifecycle: TaskLifecycleService;
      runControls: RunControlService;
      notify: Notify;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  /**
   * 主 Run 回報 `awaiting_gate(review)`。只有 Agent 真的結束了一個回合（Run 之前在執行中）、
   * 而且 Task 在 Running 時才開始一輪 Verification。Verification 結束後 Runner 會再送一次
   * `awaiting_gate(review)`（Run 之前是 verifying），那時不算新的回合。
   */
  async onTurnEnded(
    uow: UnitOfWork,
    run: RunRow,
    task: TaskRow,
    previousStatus: RunRow["status"],
  ): Promise<void> {
    if (previousStatus === "verifying" || previousStatus === "awaiting_gate") return;
    if (task.status !== "running") return;
    const verifying = await this.deps.lifecycle.transition(uow, task.id, "verifying", "run");
    await this.start(uow, run, verifying);
  }

  /** 開始一輪 Verification；沒有要自動檢查的條件時直接進 Review Gate。 */
  private async start(uow: UnitOfWork, run: RunRow, task: TaskRow): Promise<void> {
    const { tx } = uow;
    const criteria = await tx
      .select()
      .from(acceptanceCriteria)
      .where(and(eq(acceptanceCriteria.taskId, task.id), ne(acceptanceCriteria.kind, "manual")))
      .orderBy(asc(acceptanceCriteria.position));
    if (criteria.length === 0) {
      await this.passToReviewGate(uow, run, task);
      return;
    }
    const attempt = nextAttempt(await latestVerification(tx, run.id));
    const [verification] = await tx
      .insert(verifications)
      .values({ runId: run.id, taskId: task.id, attempt, startedAt: this.deps.clock.now() })
      .returning();
    if (!verification) throw new Error("建立 Verification 失敗");
    const context: ContentBlock[] = await buildPrompt(tx, task);
    await this.deps.runControls.send(
      tx,
      run.id,
      {
        action: "verify",
        verification_id: verification.id,
        attempt,
        criteria: criteria.map(
          (c): VerificationCriterion => ({
            criterion_id: c.id,
            kind: c.kind as VerificationCriterion["kind"],
            description: c.description,
            command: c.kind === "command" ? c.command : null,
          }),
        ),
        judge: null,
        context,
      },
      uow,
    );
  }

  /** 一條條件的結果。 */
  async onResult(uow: UnitOfWork, run: RunRow, body: VerificationResultBody): Promise<void> {
    const { tx } = uow;
    const [verification] = await tx
      .select()
      .from(verifications)
      .where(and(eq(verifications.id, body.verification_id), eq(verifications.runId, run.id)));
    // 只接受進行中的這一輪；結束後才到的結果不改變已經做出的決定。
    if (verification?.status !== "running") {
      this.deps.logger.warn(
        { runId: run.id, body },
        "verification_result 對應不到這個 Run 進行中的 Verification",
      );
      return;
    }
    // Runner 只能回報 Server 要求檢查的類型；manual 條件只能由人在 Review Gate 打勾。
    const [criterion] = await tx
      .select({ id: acceptanceCriteria.id })
      .from(acceptanceCriteria)
      .where(
        and(
          eq(acceptanceCriteria.id, body.criterion_id),
          eq(acceptanceCriteria.taskId, verification.taskId),
          ne(acceptanceCriteria.kind, "manual"),
        ),
      );
    if (!criterion) return;
    const values = {
      outcome: body.outcome,
      summary: body.summary,
      evidence: body.evidence,
      judgedByRunId: body.judged_by_run_id,
    };
    await tx
      .insert(verificationResults)
      .values({ verificationId: verification.id, criterionId: criterion.id, ...values })
      .onConflictDoUpdate({
        target: [verificationResults.verificationId, verificationResults.criterionId],
        set: values,
      });
    await tx
      .update(acceptanceCriteria)
      .set({
        passed: body.outcome === "passed",
        resultSummary: body.summary,
        evidence: body.evidence,
        checkedAt: this.deps.clock.now(),
        checkedByRunId: body.judged_by_run_id,
        checkedByMemberId: null,
      })
      .where(eq(acceptanceCriteria.id, criterion.id));
  }

  /** 一輪 Verification 結束。 */
  async onCompleted(
    uow: UnitOfWork,
    run: RunRow,
    task: TaskRow,
    body: VerificationCompletedBody,
  ): Promise<void> {
    const { tx } = uow;
    const now = this.deps.clock.now();
    const [verification] = await tx
      .update(verifications)
      .set({ status: body.outcome, completedAt: now })
      .where(
        and(
          eq(verifications.id, body.verification_id),
          eq(verifications.runId, run.id),
          eq(verifications.status, "running"),
        ),
      )
      .returning();
    if (!verification || task.status !== "verifying") return;
    if (body.outcome === "passed") {
      await this.passToReviewGate(uow, run, task);
      return;
    }
    const [project] = await tx
      .select({ maxRetries: projects.verificationMaxRetries })
      .from(projects)
      .where(eq(projects.id, task.projectId));
    if (verification.attempt < (project?.maxRetries ?? 3)) {
      await this.retry(uow, run, task, verification, null);
      return;
    }
    await this.stop(uow, run, task, verification);
  }

  /** 超過上限後人的決定（`POST` runVerificationDecision）。 */
  async decide(
    uow: UnitOfWork,
    run: RunRow,
    input: VerificationDecisionInput,
    actorMemberId: string,
  ): Promise<void> {
    const { tx } = uow;
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, run.taskId)).for("update");
    const verification = await latestVerification(tx, run.id);
    const stopped = await tx
      .select({ id: needsYouItems.id })
      .from(needsYouItems)
      .where(
        and(
          eq(needsYouItems.runId, run.id),
          eq(needsYouItems.kind, "stopped_run"),
          isNull(needsYouItems.resolvedAt),
        ),
      );
    if (
      !task ||
      task.status !== "verifying" ||
      !verification ||
      verification.status === "running" ||
      verification.status === "passed" ||
      verification.resolution !== null ||
      stopped.length === 0
    ) {
      throw conflict("這個 Run 沒有等待決定的 Verification");
    }
    const now = this.deps.clock.now();
    await tx
      .update(verifications)
      .set({
        resolution: input.action,
        resolvedByMemberId: actorMemberId,
        comment: input.action === "retry" ? (input.comment ?? null) : null,
      })
      .where(eq(verifications.id, verification.id));
    await tx
      .update(needsYouItems)
      .set({
        resolvedAt: now,
        resolvedByMemberId: actorMemberId,
        resolution: { action: input.action },
      })
      .where(
        inArray(
          needsYouItems.id,
          stopped.map((s) => s.id),
        ),
      );
    const actedBy = { source: "api", actorMemberId } as const;
    if (input.action === "retry") {
      await this.retry(uow, run, task, verification, input.comment ?? null, actedBy);
    } else if (input.action === "skip") {
      await this.passToReviewGate(uow, run, task, actedBy);
    } else {
      await this.deps.lifecycle.transition(uow, task.id, "ready", "run_stopped", actedBy);
      await this.deps.runControls.send(tx, run.id, { action: "cancel" }, uow, actorMemberId);
    }
  }

  private async passToReviewGate(
    uow: UnitOfWork,
    run: RunRow,
    task: TaskRow,
    actedBy?: { source: "api"; actorMemberId: string },
  ): Promise<void> {
    const updated = await this.deps.lifecycle.transition(
      uow,
      task.id,
      "review_gate",
      "verification",
      actedBy ?? {},
    );
    const gate = await openGate(uow, "review", run, updated);
    await this.deps.notify.notify(uow, {
      kind: "gate_pending",
      recipients: await gateRecipients(uow.tx, gate),
      taskId: task.id,
      runId: run.id,
      gateId: gate.id,
      actorMemberId: actedBy?.actorMemberId ?? null,
      title: `${task.key} 等待 Review`,
      body: task.title,
    });
  }

  /** 把失敗原因送回原 Run 重試。 */
  private async retry(
    uow: UnitOfWork,
    run: RunRow,
    task: TaskRow,
    verification: VerificationRow,
    comment: string | null,
    actedBy?: { source: "api"; actorMemberId: string },
  ): Promise<void> {
    const { tx } = uow;
    await this.deps.lifecycle.transition(uow, task.id, "running", "verification", actedBy ?? {});
    const failures = await tx
      .select({
        description: acceptanceCriteria.description,
        outcome: verificationResults.outcome,
        summary: verificationResults.summary,
      })
      .from(verificationResults)
      .innerJoin(acceptanceCriteria, eq(acceptanceCriteria.id, verificationResults.criterionId))
      .where(
        and(
          eq(verificationResults.verificationId, verification.id),
          ne(verificationResults.outcome, "passed"),
        ),
      )
      .orderBy(asc(acceptanceCriteria.position));
    await this.deps.runControls.send(
      tx,
      run.id,
      {
        action: "prompt",
        prompt: [{ type: "text", text: retryPrompt(failures, comment) }],
        source: "verification_retry",
      },
      uow,
      actedBy?.actorMemberId,
    );
  }

  /** 到了重試上限：停下來等人決定。 */
  private async stop(
    uow: UnitOfWork,
    run: RunRow,
    task: TaskRow,
    verification: VerificationRow,
  ): Promise<void> {
    const memberId = task.assigneeMemberId ?? run.requestedByMemberId;
    const reason = `Verification 連續失敗 ${verification.attempt} 次`;
    await uow.tx.insert(needsYouItems).values({
      projectId: task.projectId,
      memberId,
      kind: "stopped_run",
      taskId: task.id,
      runId: run.id,
      payload: { reason, verificationId: verification.id },
    });
    await this.deps.notify.notify(uow, {
      kind: "verification_failed",
      recipients: [memberId],
      taskId: task.id,
      runId: run.id,
      title: `${task.key} ${reason}`,
      body: task.title,
    });
  }
}

async function latestVerification(tx: Executor, runId: string): Promise<VerificationRow | null> {
  const [row] = await tx
    .select()
    .from(verifications)
    .where(eq(verifications.runId, runId))
    .orderBy(desc(verifications.startedAt), desc(verifications.id))
    .limit(1);
  return row ?? null;
}

/** 下一輪的序號：人選擇「附意見再試」之後重新從 1 算。 */
function nextAttempt(previous: VerificationRow | null): number {
  if (!previous || previous.resolution === "retry") return 1;
  return previous.attempt + 1;
}

/** 送回 Agent 重試的 prompt：每條沒通過的條件與原因，加上人的意見。 */
export function retryPrompt(
  failures: { description: string; outcome: VerificationOutcome; summary: string }[],
  comment: string | null,
): string {
  const lines = ["Verification 沒有通過，請依照下列原因修改後再交回。", ""];
  for (const f of failures) {
    const label = f.outcome === "error" ? "無法判定" : "失敗";
    lines.push(`- [${label}] ${f.description}：${f.summary}`);
  }
  if (comment && comment.trim() !== "") lines.push("", "補充意見：", comment.trim());
  return lines.join("\n").trimEnd();
}
