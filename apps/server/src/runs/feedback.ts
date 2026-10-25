// Feedback Loop 的修正 Run（ARCHITECTURE §5.2），由 GitHub 整合（packages/github 的 FeedbackRunPort）呼叫。
//
// - 開一個新的主 Run（origin = feedback_loop，resumes_run_id 指向前一個 Run）：同一台 Runner、同一個分支與
//   Worktree，Runner 以前一個 Run 回報的 session id 接續原本的 session，修正 prompt 是第一個 prompt。
// - Task PR Open → Running。修正照常經過 Verifying；通過後直接 push（不經過 Review Gate），Task 回到 PR Open，
//   push 完成後照常以 onBranchPushed 交給 GitHub 整合（runs/run-control.ts）。
// - Run 沒有 push 就結束時，Task 回到 PR Open，並通知 GitHub 整合（onFeedbackRunEnded）。

import type { FeedbackFixRequest, FeedbackFixResult, FeedbackRunPort } from "@orbis/github";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { runs, tasks } from "../db/schema";
import { inTransaction } from "../db/tx";
import type { TaskLifecycleService } from "../domain/task-lifecycle";
import { ApiError } from "../http/errors";
import type { Dispatcher } from "../runner/dispatcher";
import type { RunnerHub } from "../runner/hub";
import { currentPermissionPolicy } from "./run-settings";

export class FeedbackRunService implements FeedbackRunPort {
  constructor(
    private readonly deps: {
      db: Database;
      lifecycle: TaskLifecycleService;
      hub: RunnerHub;
      dispatcher: Dispatcher;
    },
  ) {}

  async requestFix(request: FeedbackFixRequest): Promise<FeedbackFixResult> {
    const { db } = this.deps;
    const [previous] = await db.select().from(runs).where(eq(runs.id, request.previousRunId));
    if (!previous || previous.taskId !== request.taskId) {
      return { ok: false, reason: "run_not_found", message: "要接續的 Run 不存在" };
    }
    // 修正要沿用前一個 Run 的 Worktree，只能派給它所在、而且在線上的 Runner。
    if (!previous.runnerId || !previous.baseCommit || !this.deps.hub.isOnline(previous.runnerId)) {
      return {
        ok: false,
        reason: "run_not_resumable",
        message: "前一個 Run 的 Runner 不在線上，或沒有可以接續的 Worktree",
      };
    }
    try {
      const runId = await inTransaction(db, async (uow) => {
        const [task] = await uow.tx.select().from(tasks).where(eq(tasks.id, request.taskId));
        if (task?.status !== "pr_open") {
          throw new ApiError(409, "invalid_transition", "Task 不在 PR Open");
        }
        await this.deps.lifecycle.transition(uow, task.id, "running", "feedback_loop");
        const [run] = await uow.tx
          .insert(runs)
          .values({
            taskId: task.id,
            agent: previous.agent,
            model: previous.model,
            permissionPolicy: await currentPermissionPolicy(uow.tx, previous),
            effort: previous.effort,
            target: previous.target,
            requestedByMemberId: previous.requestedByMemberId,
            origin: "feedback_loop",
            resumesRunId: previous.id,
            branch: previous.branch,
            prompt: [{ type: "text", text: request.prompt }],
            promptSource: request.source === "ci" ? "feedback_ci" : "feedback_review",
          })
          .returning({ id: runs.id });
        if (!run) throw new Error("建立 Run 失敗");
        uow.afterCommit(() => void this.deps.dispatcher.kick());
        return run.id;
      });
      return { ok: true, runId };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        return { ok: false, reason: "invalid_state", message: error.message };
      }
      throw error;
    }
  }
}
