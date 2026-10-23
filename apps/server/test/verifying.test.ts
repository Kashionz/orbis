// Verifying（ARCHITECTURE §5.1）：Server 在主 Run 回合結束後要求 Verification，彙整結果，
// 失敗自動送回 Agent 重試（預設最多 3 次），超過就加入 Needs You 等人決定；manual 條件在 Review Gate 打勾。

import {
  AcceptanceCriterion,
  NeedsYouListResponse,
  VerificationListResponse,
} from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acceptanceCriteria, gates, verifications } from "../src/db/schema";
import { expectContract, resetDatabase } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_REVIEW,
  control,
  type Flow,
  openGate,
  RUN_DIFF,
  RUNNING,
  type StartedRun,
  startFlow,
  startRun,
  taskRow,
} from "./helpers/flow";

describe.skipIf(dbSkipReason !== null)("Verifying", () => {
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
    flow = await startFlow(database.db);
  });

  afterEach(async () => {
    await flow.close();
  });

  const CRITERIA = [
    { kind: "command", description: "測試通過", command: "pnpm test" },
    { kind: "agent", description: "錯誤訊息是中文" },
    { kind: "manual", description: "畫面看起來正確" },
  ] as const;

  /** Agent 結束回合。 */
  async function finishTurn(started: StartedRun) {
    await started.send(RUN_DIFF);
    await started.send(AWAITING_REVIEW);
  }

  const verificationsOf = async (runId: string) =>
    expectContract(
      VerificationListResponse,
      (await flow.as("viewer").get(`/api/runs/${runId}/verifications`)).body,
    );

  it("Agent 結束回合：Task 進入 Verifying，verify 只列出 command／agent／browser 條件", async () => {
    const started = await startRun(flow, { criteria: [...CRITERIA] });
    await finishTurn(started);
    const verify = await started.mine.next("run_control", (f) => f.action === "verify");
    if (verify.action !== "verify") throw new Error("unreachable");
    expect(verify.attempt).toBe(1);
    expect(verify.criteria).toEqual([
      {
        criterion_id: started.criteria[0]?.id,
        kind: "command",
        description: "測試通過",
        command: "pnpm test",
      },
      {
        criterion_id: started.criteria[1]?.id,
        kind: "agent",
        description: "錯誤訊息是中文",
        command: null,
      },
    ]);
    expect(JSON.stringify(verify.context)).toContain(started.task.title);
    expect((await taskRow(database.db, started.task.id)).status).toBe("verifying");
    expect(await verificationsOf(started.run.id)).toMatchObject([
      { attempt: 1, status: "running", results: [] },
    ]);
  });

  it("沒有要自動檢查的條件時直接進入 Review Gate", async () => {
    const started = await startRun(flow, {
      criteria: [{ kind: "manual", description: "看過畫面" }],
    });
    await finishTurn(started);
    await openGate(flow, started.task.id);
    expect((await taskRow(database.db, started.task.id)).status).toBe("review_gate");
    expect(started.mine.pending("run_control").filter((f) => f.action === "verify")).toEqual([]);
  });

  it("全部通過：保存結果與證據、寫回 Acceptance Criterion，進入 Review Gate", async () => {
    const started = await startRun(flow, { criteria: [...CRITERIA] });
    await finishTurn(started);
    await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
    const gate = await openGate(flow, started.task.id);
    expect(gate.kind).toBe("review");
    expect((await taskRow(database.db, started.task.id)).status).toBe("review_gate");

    const [verification] = await verificationsOf(started.run.id);
    expect(verification).toMatchObject({ attempt: 1, status: "passed" });
    expect(verification?.results.map((r) => r.criterionId)).toEqual([
      started.criteria[0]?.id,
      started.criteria[1]?.id,
    ]);
    expect(verification?.results[0]?.evidence[0]).toMatchObject({
      type: "command_output",
      exit_code: 0,
    });
    const criteria = expectContract(
      AcceptanceCriterion.array(),
      (await flow.as("viewer").get(`/api/tasks/${started.task.id}/acceptance-criteria`)).body,
    );
    expect(criteria.map((c) => c.result)).toEqual(["passed", "passed", "pending"]);
    expect(criteria[0]?.resultSummary).toBe("通過");
  });

  it("失敗：失敗原因以 prompt（verification_retry）送回原 Run，Task 回到 Running；下一次回合結束是第 2 輪", async () => {
    const started = await startRun(flow, { criteria: [...CRITERIA] });
    await finishTurn(started);
    const commandId = started.criteria[0]?.id ?? "";
    await started.mine.answerVerification(started.offer.dispatch_id, started.run.id, {
      [commandId]: "failed",
    });
    const prompt = await control(started.mine, "prompt");
    expect(prompt).toMatchObject({ source: "verification_retry" });
    expect(JSON.stringify(prompt)).toContain("測試通過 沒有通過");
    expect(JSON.stringify(prompt)).not.toContain("錯誤訊息是中文");
    expect((await taskRow(database.db, started.task.id)).status).toBe("running");
    const criteria = await database.db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.id, commandId));
    expect(criteria[0]?.passed).toBe(false);

    await started.send(RUNNING);
    await finishTurn(started);
    const second = await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
    expect(second.attempt).toBe(2);
    expect((await taskRow(database.db, started.task.id)).status).toBe("review_gate");
  });

  /** 連續失敗到 Project 的上限（第一輪之後重試 3 次，共 4 輪）。 */
  async function failUntilStopped(started: StartedRun, times = 4) {
    const commandId = started.criteria[0]?.id ?? "";
    for (let attempt = 1; attempt <= times; attempt++) {
      if (attempt > 1) await started.send(RUNNING);
      await finishTurn(started);
      await started.mine.answerVerification(started.offer.dispatch_id, started.run.id, {
        [commandId]: "failed",
      });
      if (attempt < times) await control(started.mine, "prompt");
    }
  }

  it("第一輪之後重試 3 次仍失敗：Task 停在 Verifying，加入負責人的 Needs You（停下來的 Run），不再送回 Agent", async () => {
    const started = await startRun(flow, {
      criteria: [...CRITERIA],
      task: { assigneeMemberId: flow.team.members.admin.id },
    });
    await failUntilStopped(started);
    expect((await taskRow(database.db, started.task.id)).status).toBe("verifying");
    expect(started.mine.pending("run_control").filter((f) => f.action === "prompt")).toEqual([]);
    const items = expectContract(
      NeedsYouListResponse,
      (await flow.as("admin").get("/api/needs-you")).body,
    );
    expect(items).toMatchObject([
      { kind: "stopped_run", runId: started.run.id, reason: "Verification 連續失敗 4 次" },
    ]);
    const list = await verificationsOf(started.run.id);
    expect(list.map((v) => v.status)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(list.map((v) => v.awaitingDecision)).toEqual([false, false, false, true]);
  });

  it("Project 可以調整重試上限", async () => {
    await flow.close();
    await resetDatabase(database.db);
    flow = await startFlow(database.db, { verificationMaxRetries: 1 });
    const started = await startRun(flow, { criteria: [...CRITERIA] });
    await failUntilStopped(started, 2);
    expect((await taskRow(database.db, started.task.id)).status).toBe("verifying");
  });

  it("error（無法判定）視為失敗", async () => {
    const started = await startRun(flow, { criteria: [...CRITERIA] });
    await finishTurn(started);
    await started.mine.answerVerification(started.offer.dispatch_id, started.run.id, {
      [started.criteria[1]?.id ?? ""]: "error",
    });
    const prompt = await control(started.mine, "prompt");
    expect(JSON.stringify(prompt)).toContain("無法判定");
  });

  describe("超過上限後人的決定", () => {
    const decide = (
      runId: string,
      body: Record<string, unknown>,
      role: "member" | "viewer" = "member",
    ) => flow.as(role).post(`/api/runs/${runId}/verification-decision`, body);

    it("附意見再試：意見與失敗原因送回 Agent，次數重新從 1 算", async () => {
      const started = await startRun(flow, { criteria: [...CRITERIA] });
      await failUntilStopped(started);
      const res = await decide(started.run.id, { action: "retry", comment: "改用 vitest" });
      expect(res.status).toBe(200);
      const prompt = await control(started.mine, "prompt");
      expect(JSON.stringify(prompt)).toContain("改用 vitest");
      expect((await taskRow(database.db, started.task.id)).status).toBe("running");
      await started.send(RUNNING);
      await finishTurn(started);
      const next = await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
      expect(next.attempt).toBe(1);
      const list = await verificationsOf(started.run.id);
      expect(list[3]).toMatchObject({
        resolution: "retry",
        comment: "改用 vitest",
        awaitingDecision: false,
      });
      expect(
        expectContract(
          NeedsYouListResponse,
          (await flow.as("member").get("/api/needs-you")).body,
        ).filter((i) => i.kind === "stopped_run"),
      ).toEqual([]);
    });

    it("略過失敗：進入 Review Gate（Review 時看得到失敗的結果）", async () => {
      const started = await startRun(flow, { criteria: [...CRITERIA] });
      await failUntilStopped(started);
      expect((await decide(started.run.id, { action: "skip" })).status).toBe(200);
      expect((await taskRow(database.db, started.task.id)).status).toBe("review_gate");
      expect((await database.db.select().from(gates).where(eq(gates.kind, "review"))).length).toBe(
        1,
      );
    });

    it("中止：送 cancel，Task 回到 Ready", async () => {
      const started = await startRun(flow, { criteria: [...CRITERIA] });
      await failUntilStopped(started);
      expect((await decide(started.run.id, { action: "abort" })).status).toBe(200);
      await control(started.mine, "cancel");
      expect((await taskRow(database.db, started.task.id)).status).toBe("ready");
    });

    it("沒有等待決定時回 409；Viewer 不能決定", async () => {
      const started = await startRun(flow, { criteria: [...CRITERIA] });
      await finishTurn(started);
      expect((await decide(started.run.id, { action: "skip" })).status).toBe(409);
      await started.mine.answerVerification(started.offer.dispatch_id, started.run.id, {
        [started.criteria[0]?.id ?? ""]: "failed",
      });
      await control(started.mine, "prompt");
      expect((await decide(started.run.id, { action: "skip" })).status).toBe(409);
      const stopped = await startRun(flow, { criteria: [...CRITERIA], runner: started.mine });
      await failUntilStopped(stopped);
      expect((await decide(stopped.run.id, { action: "skip" }, "viewer")).status).toBe(403);
    });
  });

  describe("Runner 回報的結果", () => {
    it("不接受 manual 條件、別的 Task 的條件，以及已結束那一輪的結果", async () => {
      const started = await startRun(flow, { criteria: [...CRITERIA] });
      await finishTurn(started);
      const verify = await started.mine.next("run_control", (f) => f.action === "verify");
      if (verify.action !== "verify") throw new Error("unreachable");
      const manualId = started.criteria[2]?.id ?? "";
      await started.send({
        kind: "verification_result",
        verification_id: verify.verification_id,
        attempt: 1,
        criterion_id: manualId,
        outcome: "passed",
        summary: "偽造",
        evidence: [],
        judged_by_run_id: null,
      });
      const [manual] = await database.db
        .select()
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.id, manualId));
      expect(manual?.passed).toBeNull();

      await started.send({
        kind: "verification_completed",
        verification_id: verify.verification_id,
        attempt: 1,
        outcome: "passed",
      });
      await started.send({
        kind: "verification_result",
        verification_id: verify.verification_id,
        attempt: 1,
        criterion_id: started.criteria[0]?.id ?? "",
        outcome: "failed",
        summary: "太晚了",
        evidence: [],
        judged_by_run_id: null,
      });
      const [row] = await database.db
        .select()
        .from(verifications)
        .where(eq(verifications.id, verify.verification_id));
      expect(row?.status).toBe("passed");
      const [command] = await database.db
        .select()
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.id, started.criteria[0]?.id ?? ""));
      expect(command?.passed).toBeNull();
    });
  });

  describe("manual 條件在 Review Gate 打勾", () => {
    async function atReviewGate() {
      const started = await startRun(flow, { criteria: [...CRITERIA] });
      await finishTurn(started);
      await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
      const gate = await openGate(flow, started.task.id);
      return { started, gate };
    }
    const check = (criterionId: string, checked: boolean, role: "member" | "viewer" = "member") =>
      flow.as(role).post(`/api/acceptance-criteria/${criterionId}/check`, { checked });

    it("全部打勾後才能核准；取消打勾又不能核准", async () => {
      const { started, gate } = await atReviewGate();
      const manualId = started.criteria[2]?.id ?? "";
      const approve = () =>
        flow.as("admin").post(`/api/gates/${gate.id}/decision`, { action: "approve" });
      expect((await approve()).status).toBe(409);
      const checked = await check(manualId, true);
      expect(checked.status).toBe(200);
      expect(expectContract(AcceptanceCriterion, checked.body)).toMatchObject({
        result: "passed",
        checkedByMemberId: flow.team.members.member.id,
      });
      expect((await check(manualId, false)).status).toBe(200);
      expect((await approve()).status).toBe(409);
      await check(manualId, true);
      expect((await approve()).status).toBe(200);
    });

    it("非 manual 條件回 422；Task 不在 Review Gate 時回 409；Viewer 不能打勾", async () => {
      const { started } = await atReviewGate();
      expect((await check(started.criteria[0]?.id ?? "", true)).status).toBe(422);
      expect((await check(started.criteria[2]?.id ?? "", true, "viewer")).status).toBe(403);
      const other = await startRun(flow, { criteria: [...CRITERIA], runner: started.mine });
      expect((await check(other.criteria[2]?.id ?? "", true)).status).toBe(409);
    });

    it("上一個 Review Gate 的打勾不算：退回後再進入 Review Gate 要重新打勾", async () => {
      const { started, gate } = await atReviewGate();
      const manualId = started.criteria[2]?.id ?? "";
      await check(manualId, true);
      await flow.as("admin").post(`/api/gates/${gate.id}/decision`, {
        action: "reject",
        comment: "再改一下",
      });
      await control(started.mine, "gate_result");
      await control(started.mine, "prompt");
      await started.send(RUNNING);
      await finishTurn(started);
      await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
      const second = await openGate(flow, started.task.id);
      const approve = await flow.as("admin").post(`/api/gates/${second.id}/decision`, {
        action: "approve",
      });
      expect(approve.status).toBe(409);
    });
  });
});
