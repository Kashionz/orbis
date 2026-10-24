// 對進行中的 Run 下指令（RunControl）並處理 Runner 回報的結果（ARCHITECTURE §6.1）。
//
// - 指令只能送給 Run 目前已接受的 Dispatch。每個指令在同一個 transaction 中寫進 run_controls，
//   commit 後才送出；Runner 回報 run_control_result 時記下 outcome。
// - outcome 還是 null 的指令，在 Runner 重新連上時補送（Server 重新啟動後也一樣）。期間改派時，
//   改用新的 Dispatch ID 送出並更新紀錄。
// - `archive` 是例外（§6.2）：在 Run 結束後才送，對象是 Run 最後一個 completed 的 Dispatch 與它的 Runner，
//   不會改派；Runner 離線時同樣留著等重新連線補送。

import type {
  RunControl,
  RunControlAction,
  RunControlResult,
  ServerToRunner,
} from "@orbis/protocol";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { dispatches, needsYouItems, runControls, runs, tasks } from "../db/schema";
import type { Executor, UnitOfWork } from "../db/tx";
import type { PullRequestOpener } from "../github/integration";
import { conflict } from "../http/errors";
import type { Logger } from "../logger";
import { NO_NOTIFY, type Notify } from "../notifications/types";
import type { RunnerHub } from "../runner/hub";

type RunControlRow = typeof runControls.$inferSelect;

/** Run 目前已接受（或已完成）的 Dispatch。 */
export async function currentDispatch(db: Executor, runId: string) {
  const [dispatch] = await db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.runId, runId), inArray(dispatches.status, ["accepted", "completed"])))
    .orderBy(desc(dispatches.createdAt))
    .limit(1);
  return dispatch ?? null;
}

export class RunControlService {
  constructor(
    private readonly db: Database,
    private readonly hub: RunnerHub,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly pullRequestOpener: PullRequestOpener,
    private readonly notify: Notify = NO_NOTIFY,
  ) {
    hub.onConnect((runnerId) => {
      this.resend(runnerId).catch((error: unknown) =>
        this.logger.error({ err: error, runnerId }, "補送 RunControl 失敗"),
      );
    });
  }

  /**
   * 對 Run 下指令。Run 沒有已接受的 Dispatch 時丟出 409。
   * 指令寫進 run_controls；傳入 uow 時在 commit 之後才送出。回傳 control_id。
   */
  async send(
    executor: Executor,
    runId: string,
    action: RunControlAction,
    uow?: UnitOfWork,
    /** 送出指令的 Member；系統觸發時省略。 */
    requestedByMemberId?: string,
  ): Promise<string> {
    const dispatch = await currentDispatch(executor, runId);
    if (dispatch?.status !== "accepted") {
      throw conflict("Run 目前沒有在 Runner 上執行，無法送出指令");
    }
    const [control] = await executor
      .insert(runControls)
      .values({
        controlId: uuidv7(),
        runId,
        dispatchId: dispatch.id,
        action: action.action,
        payload: action,
        requestedByMemberId: requestedByMemberId ?? null,
        createdAt: this.clock.now(),
      })
      .returning();
    if (!control) throw new Error("建立 RunControl 失敗");
    const deliver = () => void this.deliver(control, dispatch.runnerId);
    if (uow) uow.afterCommit(deliver);
    else deliver();
    return control.controlId;
  }

  /**
   * Run 結束後對它最後的 Dispatch 下指令（目前只有 `archive`，§6.2）。Run 還在執行、或從來沒有被
   * Runner 執行過時丟出 409。同一個 Run 已有同樣的指令還沒有結果時不重送，回傳原本的 control_id。
   */
  async sendAfterRunEnded(
    executor: Executor,
    runId: string,
    action: Extract<RunControlAction, { action: "archive" }>,
  ): Promise<string> {
    const dispatch = await currentDispatch(executor, runId);
    if (dispatch?.status !== "completed") {
      throw conflict("Run 還沒有結束，或沒有執行過，無法封存");
    }
    const [pending] = await executor
      .select({ controlId: runControls.controlId })
      .from(runControls)
      .where(
        and(
          eq(runControls.runId, runId),
          eq(runControls.dispatchId, dispatch.id),
          eq(runControls.action, action.action),
          isNull(runControls.resolvedAt),
        ),
      );
    if (pending) return pending.controlId;
    const [control] = await executor
      .insert(runControls)
      .values({
        controlId: uuidv7(),
        runId,
        dispatchId: dispatch.id,
        action: action.action,
        payload: action,
        requestedByMemberId: null,
        createdAt: this.clock.now(),
      })
      .returning();
    if (!control) throw new Error("建立 RunControl 失敗");
    await this.deliver(control, dispatch.runnerId);
    return control.controlId;
  }

  /** Task 刪除時直接送出、沒有寫進 run_controls 的指令（ArchiveService）：收到結果時只記 log。 */
  expectUnrecordedResult(controlId: string): void {
    this.unrecorded.add(controlId);
  }

  private readonly unrecorded = new Set<string>();

  /** 還沒收到結果的指令（測試與除錯用）。 */
  pendingControls(): Promise<RunControlRow[]> {
    return this.db
      .select()
      .from(runControls)
      .where(isNull(runControls.resolvedAt))
      .orderBy(asc(runControls.createdAt), asc(runControls.controlId));
  }

  private async deliver(control: RunControlRow, runnerId: string): Promise<void> {
    const frame: RunControl = {
      control_id: control.controlId,
      run_id: control.runId,
      dispatch_id: control.dispatchId,
      ...(control.payload as RunControlAction),
    };
    const sent = this.hub.send(runnerId, { type: "run_control", ...frame } as ServerToRunner);
    if (!sent) {
      this.logger.info(
        { controlId: control.controlId, runId: control.runId, runnerId },
        "Runner 不在線上，RunControl 等重新連線後補送",
      );
      return;
    }
    try {
      await this.db
        .update(runControls)
        .set({ sentAt: this.clock.now() })
        .where(eq(runControls.controlId, control.controlId));
    } catch (error) {
      this.logger.warn(
        { err: error, controlId: control.controlId },
        "記錄 RunControl 送出時間失敗",
      );
    }
  }

  /**
   * Runner 重新連上後，補送它目前負責的 Run 還沒有結果的指令（依建立順序）。
   * 指令記錄的 Dispatch 已被取代時，改成目前的 Dispatch。
   * `onlyRunId`：Runner 剛接受改派的 Dispatch 時，只補送這個 Run 中屬於舊 Dispatch 的指令
   * （連線沒有中斷，已用目前 Dispatch 送出的指令不必重送）。
   * Run 結束後的 `archive` 也在這裡補送：它掛在已 completed 的 Dispatch 上，不改派。
   */
  async resend(runnerId: string, onlyRunId?: string): Promise<void> {
    const pending = await this.db
      .select({ control: runControls, dispatchId: dispatches.id })
      .from(runControls)
      .innerJoin(dispatches, eq(dispatches.runId, runControls.runId))
      .where(
        and(
          isNull(runControls.resolvedAt),
          eq(dispatches.runnerId, runnerId),
          or(
            eq(dispatches.status, "accepted"),
            and(
              eq(dispatches.status, "completed"),
              eq(runControls.action, "archive"),
              eq(runControls.dispatchId, dispatches.id),
            ),
          ),
          onlyRunId ? eq(runControls.runId, onlyRunId) : undefined,
        ),
      )
      .orderBy(asc(runControls.createdAt), asc(runControls.controlId));
    for (const { control, dispatchId } of pending) {
      if (onlyRunId && control.dispatchId === dispatchId) continue;
      let current = control;
      if (control.dispatchId !== dispatchId) {
        const [updated] = await this.db
          .update(runControls)
          .set({ dispatchId })
          .where(eq(runControls.controlId, control.controlId))
          .returning();
        current = updated ?? { ...control, dispatchId };
      }
      await this.deliver(current, runnerId);
    }
  }

  /**
   * 處理 Runner 回報的 run_control_result。只接受指令目前所屬的 Dispatch、而且由持有它的
   * Runner 回報的結果；其他（別台 Runner、過期的 Dispatch）一律忽略，避免偽造 push 結果觸發開 PR。
   */
  async onResult(runnerId: string, result: RunControlResult): Promise<void> {
    const { control_id: _controlId, run_id: _runId, dispatch_id: _dispatchId, ...outcome } = result;
    const ownDispatch = this.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.id, result.dispatch_id),
          eq(dispatches.runId, result.run_id),
          eq(dispatches.runnerId, runnerId),
          inArray(dispatches.status, ["accepted", "completed"]),
        ),
      );
    const [control] = await this.db
      .update(runControls)
      .set({ outcome: result.outcome, outcomePayload: outcome, resolvedAt: this.clock.now() })
      .where(
        and(
          eq(runControls.controlId, result.control_id),
          eq(runControls.runId, result.run_id),
          eq(runControls.dispatchId, result.dispatch_id),
          inArray(runControls.dispatchId, ownDispatch),
          isNull(runControls.resolvedAt),
        ),
      )
      .returning();
    if (!control) {
      if (this.unrecorded.delete(result.control_id)) {
        this.logger.info(
          { runnerId, runId: result.run_id, outcome: result.outcome },
          "已刪除的 Task 的 Worktree 封存結果",
        );
        return;
      }
      this.logger.warn(
        { runnerId, controlId: result.control_id },
        "收到不明、已處理過，或不屬於這台 Runner 目前 Dispatch 的 RunControl 結果，忽略",
      );
      return;
    }
    const log = { runnerId, runId: control.runId, action: control.action };

    if (control.action !== "push_branch") {
      if (result.outcome === "rejected") {
        this.logger.warn(
          { ...log, reason: result.reason, message: result.message },
          "Runner 拒絕 RunControl",
        );
      }
      return;
    }

    if (result.outcome === "branch_pushed") {
      const [run] = await this.db.select().from(runs).where(eq(runs.id, control.runId));
      if (!run) return;
      this.logger.info(
        { ...log, branch: result.branch, commitSha: result.commit_sha },
        "分支已 push，開 PR",
      );
      let failure: string | null = null;
      try {
        const opened = await this.pullRequestOpener.openPullRequest({
          taskId: run.taskId,
          runId: run.id,
          branch: result.branch,
          commitSha: result.commit_sha,
        });
        if (!opened.ok) failure = opened.message;
      } catch (error) {
        failure = (error as Error).message;
      }
      if (failure !== null) {
        this.logger.error({ ...log, failure }, "開 PR 失敗");
        await this.stopRun(control.runId, `開 PR 失敗：${failure}`);
      }
      return;
    }

    const message =
      result.outcome === "rejected" ? `push 分支失敗：${result.message}` : "push 分支失敗";
    this.logger.warn({ ...log, result }, message);
    await this.stopRun(control.runId, message);
  }

  /** 產生「停下來的 Run」的 Needs You 項目，指派給 Task 負責人（沒有時給派工者）。 */
  private async stopRun(runId: string, reason: string): Promise<void> {
    const [row] = await this.db
      .select({ run: runs, task: tasks })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, runId));
    if (!row) return;
    const memberId = row.task.assigneeMemberId ?? row.run.requestedByMemberId;
    await this.db.insert(needsYouItems).values({
      projectId: row.task.projectId,
      memberId,
      kind: "stopped_run",
      taskId: row.task.id,
      runId,
      payload: { reason },
    });
    await this.notify.notify(null, {
      kind: "run_stopped",
      recipients: [memberId],
      taskId: row.task.id,
      runId,
      title: `${row.task.key} 停下來了`,
      body: reason,
    });
  }
}
