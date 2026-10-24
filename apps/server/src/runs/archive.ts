// 封存 Run 的 Worktree（RunControl `archive`，ARCHITECTURE §6.2）。
//
// 送出的時機：
// - Task 轉 Done（PR merge、Issue 關閉）時，對這個 Task 所有已 `completed` 的主 Run（人派工的 Run 與
//   Feedback Loop 接續的 Run，它們沿用同一個 Worktree）送 `archive`。Runner 離線時留在 run_controls，
//   重新連上後補送（RunControlService.resend）。
// - Task 刪除時：Run 會跟著 cascade 刪除，沒有地方保存指令，所以只對在線上的 Runner 直接送一次；
//   Runner 離線時記 log，Worktree 留著（之後可以手動清理）。
//
// 不送的情況：失敗或中止的 Run（含 Review Gate 結束（沒有變更）後以 cancel 結束的 Run）：Worktree 與分支
// 和中止一樣保留給人檢查，重新派工本來就用新的 Worktree（分支加 -r<序號>）。Runner 端的 `archive` 只認
// Run 最後的 Dispatch ID，所以這裡一律用 Run 最後一個 `completed` 的 Dispatch。

import type { RunControl, ServerToRunner } from "@orbis/protocol";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Database } from "../db/client";
import { dispatches, runs } from "../db/schema";
import type { Executor } from "../db/tx";
import type { DomainEvents } from "../domain/events";
import type { Logger } from "../logger";
import type { RunnerHub } from "../runner/hub";
import type { RunControlService } from "./run-control";

/** 要封存的 Run 與它最後的 Dispatch。 */
export interface ArchiveTarget {
  runId: string;
  dispatchId: string;
  runnerId: string;
}

export class ArchiveService {
  constructor(
    private readonly deps: {
      db: Database;
      hub: RunnerHub;
      logger: Logger;
      runControls: RunControlService;
      events: DomainEvents;
    },
  ) {
    deps.events.subscribe(async (event) => {
      if (event.type === "task.status_changed" && event.to === "done") {
        await this.archiveTask(event.taskId);
      }
    });
  }

  /**
   * 對 Task 所有已 completed 的主 Run 送出 `archive`（寫進 run_controls，Runner 離線時等重新連線補送）。
   * 已經送過、還沒有結果的不重送。
   */
  async archiveTask(taskId: string): Promise<void> {
    const targets = await this.targetsForTask(this.deps.db, taskId);
    for (const target of targets) {
      try {
        await this.deps.runControls.sendAfterRunEnded(this.deps.db, target.runId, {
          action: "archive",
        });
      } catch (error) {
        this.deps.logger.error({ err: error, runId: target.runId, taskId }, "送出 archive 失敗");
      }
    }
  }

  /** Task 中可以封存的 Run：已 completed 的主 Run，與它們最後一個 completed 的 Dispatch。 */
  async targetsForTask(executor: Executor, taskId: string): Promise<ArchiveTarget[]> {
    const rows = await executor
      .select({ runId: runs.id, dispatchId: dispatches.id, runnerId: dispatches.runnerId })
      .from(runs)
      .innerJoin(dispatches, eq(dispatches.runId, runs.id))
      .where(
        and(
          eq(runs.taskId, taskId),
          isNull(runs.parentRunId),
          inArray(runs.origin, ["dispatch", "feedback_loop"]),
          eq(runs.status, "completed"),
          eq(dispatches.status, "completed"),
        ),
      )
      .orderBy(runs.id, desc(dispatches.createdAt));
    // 每個 Run 只取最後一個 completed 的 Dispatch。
    const seen = new Set<string>();
    const targets: ArchiveTarget[] = [];
    for (const row of rows) {
      if (seen.has(row.runId)) continue;
      seen.add(row.runId);
      targets.push(row);
    }
    return targets;
  }

  /**
   * Task 刪除時用：對在線上的 Runner 直接送 `archive`，不寫 run_controls（Run 已被刪除）。
   * Runner 回報結果時 RunControlService 只記 log。
   */
  sendWithoutRecord(targets: ArchiveTarget[]): void {
    for (const target of targets) {
      const controlId = uuidv7();
      this.deps.runControls.expectUnrecordedResult(controlId);
      const frame: RunControl = {
        control_id: controlId,
        run_id: target.runId,
        dispatch_id: target.dispatchId,
        action: "archive",
      };
      const sent = this.deps.hub.send(target.runnerId, {
        type: "run_control",
        ...frame,
      } as ServerToRunner);
      if (!sent) {
        this.deps.logger.info(
          { runId: target.runId, runnerId: target.runnerId },
          "Task 已刪除但 Runner 不在線上，Worktree 沒有封存",
        );
      }
    }
  }
}
