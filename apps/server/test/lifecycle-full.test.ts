// 完整的 Task 生命週期（ARCHITECTURE §5）：以模擬 Runner 走 Planning → Plan Gate → Running →
// Verifying 失敗 → 重試 → 通過 → Review Gate → PR Open（push 完成後開 PR）。

import { Task, type TaskStatus } from "@orbis/api-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectContract, resetDatabase } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_PLAN,
  AWAITING_REVIEW,
  control,
  type Flow,
  openGate,
  PLAN_PROPOSED,
  RUN_DIFF,
  RUNNING,
  startFlow,
  startRun,
  taskRow,
} from "./helpers/flow";
import { waitUntil } from "./helpers/runner-harness";

describe.skipIf(dbSkipReason !== null)("完整的 Task 生命週期", () => {
  let database: TestDatabase;
  let flow: Flow;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    flow = await startFlow(database.db, { planGateEnabled: true });
  });

  afterEach(async () => {
    await flow.close();
  });

  it("Planning → Plan Gate → Running → Verifying 失敗 → 重試 → 通過 → Review Gate → PR Open", async () => {
    const seen: TaskStatus[] = [];
    flow.h.ctx.services.events.subscribe((event) => {
      if (event.type === "task.status_changed") seen.push(event.to);
    });
    const status = async (taskId: string) => (await taskRow(database.db, taskId)).status;

    // 派工：Plan Gate 開啟，Task 停在 Planning。
    const started = await startRun(flow, {
      task: { assigneeMemberId: flow.team.members.member.id },
      criteria: [
        { kind: "command", description: "測試通過", command: "pnpm test" },
        { kind: "manual", description: "畫面看起來正確" },
      ],
    });
    const { mine, task, run, offer, send } = started;
    expect(offer.plan_gate).toBe(true);
    expect(await status(task.id)).toBe("planning");

    // Agent 產出 plan → Plan Gate → 核准 → Running。
    await send(PLAN_PROPOSED("1. 新增登入頁\n2. 補測試"));
    await send(AWAITING_PLAN);
    expect(await status(task.id)).toBe("plan_gate");
    const planGate = await openGate(flow, task.id);
    expect(planGate.kind).toBe("plan");
    expect(
      (await flow.as("admin").post(`/api/gates/${planGate.id}/decision`, { action: "approve" }))
        .status,
    ).toBe(200);
    expect(await control(mine, "gate_result")).toMatchObject({
      gate: "plan",
      decision: "approved",
    });
    expect(await status(task.id)).toBe("running");

    // 第一回合結束 → Verifying → 測試失敗 → 送回原 Run 重試。
    await send(RUNNING);
    await send(RUN_DIFF);
    await send(AWAITING_REVIEW);
    expect(await status(task.id)).toBe("verifying");
    const first = await mine.answerVerification(offer.dispatch_id, run.id, {
      [started.criteria[0]?.id ?? ""]: "failed",
    });
    expect(first.attempt).toBe(1);
    const retry = await control(mine, "prompt");
    expect(retry).toMatchObject({ source: "verification_retry" });
    expect(await status(task.id)).toBe("running");

    // 第二回合結束 → Verifying → 通過 → Review Gate。
    await send(RUNNING);
    await send(RUN_DIFF);
    await send(AWAITING_REVIEW);
    const second = await mine.answerVerification(offer.dispatch_id, run.id);
    expect(second.attempt).toBe(2);
    expect(await status(task.id)).toBe("review_gate");
    const reviewGate = await openGate(flow, task.id);
    expect(reviewGate.kind).toBe("review");

    // manual 條件打勾後核准 → PR Open → push → 開 PR → Run 完成。
    const manualId = started.criteria[1]?.id ?? "";
    expect(
      (await flow.as("admin").post(`/api/acceptance-criteria/${manualId}/check`, { checked: true }))
        .status,
    ).toBe(200);
    expect(
      (await flow.as("admin").post(`/api/gates/${reviewGate.id}/decision`, { action: "approve" }))
        .status,
    ).toBe(200);
    expect(await control(mine, "gate_result")).toMatchObject({
      gate: "review",
      decision: "approved",
    });
    await control(mine, "push_branch", {
      outcome: "branch_pushed",
      branch: offer.branch,
      commit_sha: "d".repeat(40),
    });
    await waitUntil(() => flow.h.ctx.pullRequests.opened.length === 1, 5000, "開 PR");
    await send({ kind: "status_changed", status: "completed", gate: null, message: null });

    const finalTask = expectContract(
      Task,
      (await flow.as("viewer").get(`/api/tasks/${task.id}`)).body,
    );
    expect(finalTask.status).toBe("pr_open");
    expect(seen).toEqual([
      "planning",
      "plan_gate",
      "running",
      "verifying",
      "running",
      "verifying",
      "review_gate",
      "pr_open",
    ]);
  });
});
