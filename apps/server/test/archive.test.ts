// 封存 Worktree（RunControl `archive`，ARCHITECTURE §6.2）：Task 轉 Done 時對已 completed 的主 Run 送出，
// Runner 離線時重新連上補送；失敗或中止的 Run 不送；Task 刪除時直接送給在線上的 Runner。

import type { EventKind } from "@orbis/protocol";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runControls } from "../src/db/schema";
import { inTransaction } from "../src/db/tx";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_REVIEW,
  control,
  type Flow,
  openGate,
  RUN_DIFF,
  runRow,
  type StartedRun,
  startFlow,
  startRun,
  taskRow,
} from "./helpers/flow";
import { waitUntil } from "./helpers/runner-harness";

const COMPLETED: EventKind = {
  kind: "status_changed",
  status: "completed",
  gate: null,
  message: null,
};
const FAILED: EventKind = {
  kind: "status_changed",
  status: "failed",
  gate: null,
  message: "Agent 當掉",
};

describe.skipIf(dbSkipReason !== null)("封存 Worktree（archive）", () => {
  let database: TestDatabase;
  let flow: Flow;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    flow = await startFlow(database.db);
  });

  afterEach(async () => {
    await flow.close();
  });

  /** 走到 Review Gate 核准、push 完成、Run completed、Task PR Open（PR 由 FakePullRequestOpener 開）。 */
  async function prOpenWithCompletedRun(started: StartedRun) {
    await started.send(RUN_DIFF);
    await started.send(AWAITING_REVIEW);
    await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
    const gate = await openGate(flow, started.task.id);
    const decision = await flow.as("member").post(`/api/gates/${gate.id}/decision`, {
      action: "approve",
    });
    expect(decision.status).toBe(200);
    await control(started.mine, "gate_result");
    await control(started.mine, "push_branch", {
      outcome: "branch_pushed",
      branch: started.run.branch,
      commit_sha: "b".repeat(40),
    });
    await waitUntil(() => flow.h.ctx.pullRequests.opened.length > 0);
    await started.send(COMPLETED);
    expect((await runRow(database.db, started.run.id))?.status).toBe("completed");
    expect((await taskRow(database.db, started.task.id)).status).toBe("pr_open");
  }

  /** 模擬 PR merge 的 webhook：GitHub 整合以 `pull_request` 觸發把 Task 轉成 Done。 */
  async function mergePullRequest(taskId: string) {
    await inTransaction(database.db, (uow) =>
      flow.h.ctx.services.lifecycle.transition(uow, taskId, "done", "pull_request", {
        source: "github",
      }),
    );
    expect((await taskRow(database.db, taskId)).status).toBe("done");
  }

  async function archiveControls(runId: string) {
    return database.db
      .select()
      .from(runControls)
      .where(and(eq(runControls.runId, runId), eq(runControls.action, "archive")));
  }

  it("PR merge → Task Done：對已 completed 的 Run 送出 archive（最後的 Dispatch），結果記下 applied", async () => {
    const started = await startRun(flow);
    await prOpenWithCompletedRun(started);
    expect(await archiveControls(started.run.id)).toEqual([]);

    await mergePullRequest(started.task.id);
    const frame = await started.mine.next("run_control", (f) => f.action === "archive");
    expect(frame).toMatchObject({ run_id: started.run.id, dispatch_id: started.offer.dispatch_id });
    started.mine.send({
      type: "run_control_result",
      control_id: frame.control_id,
      run_id: frame.run_id,
      dispatch_id: frame.dispatch_id,
      outcome: "applied",
    });
    await waitUntil(async () => (await archiveControls(started.run.id))[0]?.outcome === "applied");
    expect(await archiveControls(started.run.id)).toMatchObject([
      { controlId: frame.control_id, outcome: "applied", requestedByMemberId: null },
    ]);
    expect(await flow.h.ctx.services.runControls.pendingControls()).toEqual([]);
  });

  it("Runner 離線時 archive 留著，重新連上後補送；再次轉 Done 不會重複送", async () => {
    const started = await startRun(flow);
    await prOpenWithCompletedRun(started);
    started.mine.close();
    await started.mine.closed;
    await waitUntil(() => !flow.h.ctx.services.hub.isOnline(started.mine.runnerId));

    await mergePullRequest(started.task.id);
    expect(await archiveControls(started.run.id)).toMatchObject([{ outcome: null, sentAt: null }]);

    // 還沒有結果的指令不重送：再送一次只回傳同一個 control_id。
    await flow.h.ctx.services.archive.archiveTask(started.task.id);
    expect(await archiveControls(started.run.id)).toHaveLength(1);

    const again = await flow.h.reconnect(started.mine);
    const frame = await again.next("run_control", (f) => f.action === "archive");
    expect(frame).toMatchObject({ run_id: started.run.id, dispatch_id: started.offer.dispatch_id });
    await waitUntil(async () => (await archiveControls(started.run.id))[0]?.sentAt !== null);
  });

  it("失敗的 Run 不封存：Task 之後因 Issue 關閉轉 Done 也不送 archive", async () => {
    const started = await startRun(flow);
    await started.send(FAILED);
    expect((await taskRow(database.db, started.task.id)).status).toBe("ready");
    await inTransaction(database.db, (uow) =>
      flow.h.ctx.services.lifecycle.transition(uow, started.task.id, "done", "issue", {
        doneReason: "not_planned",
        source: "github",
      }),
    );
    // 讓 domain event 的訂閱者跑完。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await archiveControls(started.run.id)).toEqual([]);
    expect(started.mine.pending("run_control").filter((f) => f.action === "archive")).toEqual([]);
  });

  it("Run 還沒結束時不能用 sendAfterRunEnded 封存", async () => {
    const started = await startRun(flow);
    await expect(
      flow.h.ctx.services.runControls.sendAfterRunEnded(database.db, started.run.id, {
        action: "archive",
      }),
    ).rejects.toThrow("無法封存");
  });

  it("Task 刪除：直接送 archive 給在線上的 Runner，Runner 的結果只記 log", async () => {
    const started = await startRun(flow);
    await prOpenWithCompletedRun(started);
    const deleted = await flow.as("member").delete(`/api/tasks/${started.task.id}`);
    expect(deleted.status).toBe(204);
    const frame = await started.mine.next("run_control", (f) => f.action === "archive");
    expect(frame).toMatchObject({ run_id: started.run.id, dispatch_id: started.offer.dispatch_id });
    // Run 已跟著刪除，run_controls 中沒有紀錄；Runner 回報的結果不會丟出錯誤。
    expect(await archiveControls(started.run.id)).toEqual([]);
    started.mine.send({
      type: "run_control_result",
      control_id: frame.control_id,
      run_id: frame.run_id,
      dispatch_id: frame.dispatch_id,
      outcome: "applied",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(flow.h.ctx.services.hub.isOnline(started.mine.runnerId)).toBe(true);
  });
});
