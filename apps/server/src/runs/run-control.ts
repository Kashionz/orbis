// 對進行中的 Run 下指令（RunControl）並處理 Runner 回報的結果（ARCHITECTURE §6.1）。
//
// 指令只能送給 Run 目前已接受的 Dispatch。Runner 不在線上時指令先保留，Runner 重新連上後補送
// （若期間改派，改用新的 Dispatch ID）。
//
// TODO(contract): 送出的指令與結果改存 run_controls 表（contract/db），Server 重新啟動後也能補送；
// 目前只保存在記憶體。

import type { RunControl, RunControlAction, RunControlResult } from "@orbis/protocol";
import { and, desc, eq, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { dispatches, needsYouItems, runs, tasks } from "../db/schema";
import type { Executor, UnitOfWork } from "../db/tx";
import type { PullRequestOpener } from "../github/integration";
import { conflict } from "../http/errors";
import type { Logger } from "../logger";
import type { RunnerHub } from "../runner/hub";

interface PendingControl {
  controlId: string;
  runId: string;
  action: RunControlAction;
  sentAt: Date;
}

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
  private readonly pending = new Map<string, PendingControl>();

  constructor(
    private readonly db: Database,
    private readonly hub: RunnerHub,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly pullRequestOpener: PullRequestOpener,
  ) {
    hub.onConnect((runnerId) => void this.resend(runnerId));
  }

  /**
   * 對 Run 下指令。Run 沒有已接受的 Dispatch 時丟出 409。
   * 傳入 uow 時在 commit 之後才送出。回傳 control_id。
   */
  async send(
    executor: Executor,
    runId: string,
    action: RunControlAction,
    uow?: UnitOfWork,
  ): Promise<string> {
    const dispatch = await currentDispatch(executor, runId);
    if (dispatch?.status !== "accepted") {
      throw conflict("Run 目前沒有在 Runner 上執行，無法送出指令");
    }
    const control: PendingControl = {
      controlId: uuidv7(),
      runId,
      action,
      sentAt: this.clock.now(),
    };
    const deliver = () => {
      this.pending.set(control.controlId, control);
      this.deliver(control, dispatch.runnerId, dispatch.id);
    };
    if (uow) uow.afterCommit(deliver);
    else deliver();
    return control.controlId;
  }

  /** 還沒收到結果的指令（測試與除錯用）。 */
  pendingControls(): PendingControl[] {
    return [...this.pending.values()];
  }

  private deliver(control: PendingControl, runnerId: string, dispatchId: string): void {
    const frame: RunControl = {
      control_id: control.controlId,
      run_id: control.runId,
      dispatch_id: dispatchId,
      ...control.action,
    };
    const sent = this.hub.send(runnerId, { type: "run_control", ...frame });
    if (!sent) {
      this.logger.info(
        { controlId: control.controlId, runId: control.runId, runnerId },
        "Runner 不在線上，RunControl 等重新連線後補送",
      );
    }
  }

  /** Runner 重新連上後，補送它目前負責的 Run 還沒收到結果的指令。 */
  private async resend(runnerId: string): Promise<void> {
    for (const control of this.pending.values()) {
      const dispatch = await currentDispatch(this.db, control.runId);
      if (dispatch?.status === "accepted" && dispatch.runnerId === runnerId) {
        this.deliver(control, runnerId, dispatch.id);
      }
    }
  }

  /** 處理 Runner 回報的 run_control_result。 */
  async onResult(runnerId: string, result: RunControlResult): Promise<void> {
    const control = this.pending.get(result.control_id);
    if (!control || control.runId !== result.run_id) {
      this.logger.warn(
        { runnerId, controlId: result.control_id },
        "收到不明的 RunControl 結果，忽略",
      );
      return;
    }
    this.pending.delete(result.control_id);
    const log = { runnerId, runId: control.runId, action: control.action.action };

    if (control.action.action !== "push_branch") {
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
      try {
        await this.pullRequestOpener.openPullRequest({
          taskId: run.taskId,
          runId: run.id,
          branch: result.branch,
          commitSha: result.commit_sha,
        });
      } catch (error) {
        this.logger.error({ err: error, ...log }, "開 PR 失敗");
        await this.stopRun(control.runId, `開 PR 失敗：${(error as Error).message}`);
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
    await this.db.insert(needsYouItems).values({
      projectId: row.task.projectId,
      memberId: row.task.assigneeMemberId ?? row.run.requestedByMemberId,
      kind: "stopped_run",
      taskId: row.task.id,
      runId,
      payload: { reason },
    });
  }
}
