// Planning 與 Plan Gate（ARCHITECTURE §5）：依 Project 或 Task 的設定進入 plan 模式，plan 產出後等待核准，
// 核准後進入 Running，退回時意見送回 Agent 重新 plan。

import { Gate, NeedsYouListResponse } from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gates, needsYouItems } from "../src/db/schema";
import { expectContract, resetDatabase } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_PLAN,
  control,
  type Flow,
  openGate,
  PLAN_PROPOSED,
  RUNNING,
  type StartedRun,
  startFlow,
  startRun,
  taskRow,
} from "./helpers/flow";

describe.skipIf(dbSkipReason !== null)("Planning 與 Plan Gate", () => {
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

  /** Agent 送出 plan 並等待 Plan Gate，回傳等待中的 Gate。 */
  async function proposePlan(started: StartedRun, text = "1. 改登入頁\n2. 補測試") {
    await started.send(PLAN_PROPOSED(text));
    await started.send(AWAITING_PLAN);
    return openGate(flow, started.task.id);
  }

  describe("依設定進入 plan 模式", () => {
    it("Project 開啟 Plan Gate：Offer 的 plan_gate 為 true，Task 停在 Planning", async () => {
      const started = await startRun(flow);
      expect(started.offer.plan_gate).toBe(true);
      expect((await taskRow(database.db, started.task.id)).status).toBe("planning");
    });

    it("Task 的覆寫優先：Project 開啟但 Task 關閉時直接進入 Running", async () => {
      const started = await startRun(flow, { task: { planGateEnabled: false } });
      expect(started.offer.plan_gate).toBe(false);
      expect((await taskRow(database.db, started.task.id)).status).toBe("running");
    });

    it("Project 關閉、Task 開啟時進入 plan 模式", async () => {
      await flow.close();
      await resetDatabase(database.db);
      flow = await startFlow(database.db, { planGateEnabled: false });
      const off = await startRun(flow);
      expect(off.offer.plan_gate).toBe(false);
      const on = await startRun(flow, { task: { planGateEnabled: true }, runner: off.mine });
      expect(on.offer.plan_gate).toBe(true);
      expect((await taskRow(database.db, on.task.id)).status).toBe("planning");
    });

    it("Offer 帶結構化的 Acceptance Criterion（command 為 null 時沿用 verify）", async () => {
      const started = await startRun(flow, {
        criteria: [
          { kind: "command", description: "lint 通過", command: "pnpm lint" },
          { kind: "command", description: "照設定檔驗證", command: null },
          { kind: "manual", description: "畫面正確" },
        ],
      });
      expect(started.offer.acceptance_criteria).toEqual([
        {
          criterion_id: started.criteria[0]?.id,
          kind: "command",
          description: "lint 通過",
          command: "pnpm lint",
        },
        {
          criterion_id: started.criteria[1]?.id,
          kind: "command",
          description: "照設定檔驗證",
          command: null,
        },
        {
          criterion_id: started.criteria[2]?.id,
          kind: "manual",
          description: "畫面正確",
          command: null,
        },
      ]);
      expect(started.offer.origin).toBe("dispatch");
    });
  });

  describe("plan 產出", () => {
    it("Task 進入 Plan Gate，Gate 記下送審的 plan_proposed，出現在負責人的 Needs You", async () => {
      const started = await startRun(flow, {
        task: { assigneeMemberId: flow.team.members.admin.id },
      });
      const gate = await proposePlan(started);
      const [row] = await database.db.select().from(gates).where(eq(gates.id, gate.id));
      const view = expectContract(
        Gate,
        (await flow.as("viewer").get<unknown[]>(`/api/tasks/${started.task.id}/gates`)).body[0],
      );
      expect(view).toMatchObject({ kind: "plan", decision: null, reviewDiffSeq: null });
      // seq 1 是 running，2 是 plan_proposed。
      expect(view.planSeq).toBe(2);
      expect(row?.subject).toMatchObject({ planSeq: 2 });
      expect((await taskRow(database.db, started.task.id)).status).toBe("plan_gate");
      const items = expectContract(
        NeedsYouListResponse,
        (await flow.as("admin").get("/api/needs-you")).body,
      );
      expect(items).toMatchObject([{ kind: "gate", gateKind: "plan", taskKey: started.task.key }]);
    });

    it("Task 不在 Planning 時（Plan Gate 關閉）不建立 Plan Gate", async () => {
      const started = await startRun(flow, { task: { planGateEnabled: false } });
      await started.send(PLAN_PROPOSED("x"));
      await started.send(AWAITING_PLAN);
      expect(await database.db.select().from(gates)).toEqual([]);
      expect((await taskRow(database.db, started.task.id)).status).toBe("running");
    });
  });

  describe("決定", () => {
    it("核准：送 gate_result（plan、approved），Task 進入 Running", async () => {
      const started = await startRun(flow);
      const gate = await proposePlan(started);
      const res = await flow.as("member").post(`/api/gates/${gate.id}/decision`, {
        action: "approve",
      });
      expect(res.status).toBe(200);
      expect(expectContract(Gate, res.body)).toMatchObject({ decision: "approved" });
      expect(await control(started.mine, "gate_result")).toMatchObject({
        gate: "plan",
        decision: "approved",
      });
      expect((await taskRow(database.db, started.task.id)).status).toBe("running");
      const [item] = await database.db
        .select()
        .from(needsYouItems)
        .where(eq(needsYouItems.gateId, gate.id));
      expect(item?.resolvedAt).not.toBeNull();
    });

    it("退回：意見以 prompt（source = plan_gate）送回，Task 回到 Planning，再次產出 plan 時是新的 Gate", async () => {
      const started = await startRun(flow);
      const first = await proposePlan(started);
      const res = await flow.as("member").post(`/api/gates/${first.id}/decision`, {
        action: "reject",
        comment: "先改 API 再改畫面",
      });
      expect(res.status).toBe(200);
      expect(await control(started.mine, "gate_result")).toMatchObject({
        gate: "plan",
        decision: "rejected",
      });
      const prompt = await control(started.mine, "prompt");
      expect(prompt).toMatchObject({ source: "plan_gate" });
      expect(JSON.stringify(prompt)).toContain("先改 API 再改畫面");
      expect((await taskRow(database.db, started.task.id)).status).toBe("planning");

      await started.send(RUNNING);
      const second = await proposePlan(started, "1. 先改 API");
      expect(second.id).not.toBe(first.id);
      expect((await taskRow(database.db, started.task.id)).status).toBe("plan_gate");
    });

    it("退回只接受整體說明：帶行內留言或沒有說明時回 422", async () => {
      const started = await startRun(flow);
      const gate = await proposePlan(started);
      const withComments = await flow.as("member").post(`/api/gates/${gate.id}/decision`, {
        action: "reject",
        comment: "x",
        reviewComments: [{ path: "a.ts", line: 1, side: "new", body: "y" }],
      });
      expect(withComments.status).toBe(422);
      expect((await taskRow(database.db, started.task.id)).status).toBe("plan_gate");
    });

    it("中止：送 cancel，Task 回到 Ready", async () => {
      const started = await startRun(flow);
      const gate = await proposePlan(started);
      const res = await flow.as("member").post(`/api/gates/${gate.id}/decision`, {
        action: "abort",
      });
      expect(res.status).toBe(200);
      await control(started.mine, "cancel");
      expect((await taskRow(database.db, started.task.id)).status).toBe("ready");
    });

    it("Viewer 不能核准或退回", async () => {
      const started = await startRun(flow);
      const gate = await proposePlan(started);
      for (const body of [{ action: "approve" }, { action: "reject", comment: "x" }]) {
        const res = await flow.as("viewer").post(`/api/gates/${gate.id}/decision`, body);
        expect(res.status).toBe(403);
      }
    });
  });

  describe("Project 禁止核准自己的 Task", () => {
    beforeEach(async () => {
      await flow.close();
      await resetDatabase(database.db);
      flow = await startFlow(database.db, { planGateEnabled: true, forbidSelfApproval: true });
    });

    it("負責人是 Member 時不能核准自己的 plan；Needs You 不指派給特定的人，其他能核准的人都看得到", async () => {
      const { member } = flow.team.members;
      const started = await startRun(flow, { task: { assigneeMemberId: member.id } });
      const gate = await proposePlan(started);
      const [item] = await database.db
        .select()
        .from(needsYouItems)
        .where(eq(needsYouItems.gateId, gate.id));
      expect(item?.memberId).toBeNull();

      const list = async (role: "member" | "admin" | "owner" | "viewer") =>
        expectContract(NeedsYouListResponse, (await flow.as(role).get("/api/needs-you")).body)
          .filter((i) => i.kind === "gate")
          .map((i) => i.memberId);
      expect(await list("member")).toEqual([]);
      expect(await list("viewer")).toEqual([]);
      expect(await list("admin")).toEqual([flow.team.members.admin.id]);
      expect(await list("owner")).toEqual([flow.team.members.owner.id]);

      const denied = await flow.as("member").post(`/api/gates/${gate.id}/decision`, {
        action: "approve",
      });
      expect(denied.status).toBe(403);
      const approved = await flow.as("admin").post(`/api/gates/${gate.id}/decision`, {
        action: "approve",
      });
      expect(approved.status).toBe(200);
    });

    it("負責人是 Admin 時照常指派給本人（Admin 不受這項限制）", async () => {
      const started = await startRun(flow, {
        task: { assigneeMemberId: flow.team.members.admin.id },
      });
      const gate = await proposePlan(started);
      const [item] = await database.db
        .select()
        .from(needsYouItems)
        .where(eq(needsYouItems.gateId, gate.id));
      expect(item?.memberId).toBe(flow.team.members.admin.id);
    });
  });
});
