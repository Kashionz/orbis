// Child Run（ARCHITECTURE §9）：深度與數量限制、Permission Policy 只能收緊、Project 的 Delegation 設定。

import { randomUUID } from "node:crypto";
import { NeedsYouListResponse } from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { projects, runs } from "../src/db/schema";
import {
  checkDelegation,
  type DelegationCheckInput,
  isPolicyAtMostAsPermissive,
  MAX_ACTIVE_CHILD_RUNS,
  MAX_DELEGATION_DEPTH,
} from "../src/runs/delegation-rules";
import { expectContract, resetDatabase } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_REVIEW,
  type Flow,
  RUNNING,
  runRow,
  type StartedRun,
  startFlow,
  startRun,
  taskRow,
} from "./helpers/flow";
import { waitUntil } from "./helpers/runner-harness";

const base: DelegationCheckInput = {
  project: { delegationEnabled: true, delegationAllowedAgents: null },
  parent: { depth: 0, activeChildren: 0, permissionPolicy: "auto", running: true },
  agent: "codex",
  agentAvailableOnParentRunner: true,
  permissionPolicy: null,
};

const reason = (input: Partial<DelegationCheckInput>) => {
  const result = checkDelegation({ ...base, ...input });
  return result.ok ? "ok" : result.reason;
};

describe("Delegation 的防護規則", () => {
  it("沿用父 Run 的 Permission Policy", () => {
    expect(checkDelegation(base)).toEqual({ ok: true, permissionPolicy: "auto" });
  });

  it(`深度最多 ${MAX_DELEGATION_DEPTH} 層`, () => {
    expect(reason({ parent: { ...base.parent, depth: 1 } })).toBe("ok");
    expect(reason({ parent: { ...base.parent, depth: 2 } })).toBe("depth_limit");
  });

  it(`每個 Run 同時最多 ${MAX_ACTIVE_CHILD_RUNS} 個 Child Run`, () => {
    expect(reason({ parent: { ...base.parent, activeChildren: 4 } })).toBe("ok");
    expect(reason({ parent: { ...base.parent, activeChildren: 5 } })).toBe("child_limit");
  });

  it("Project 關閉 Delegation、或 Agent 不在允許清單時拒絕", () => {
    expect(reason({ project: { delegationEnabled: false, delegationAllowedAgents: null } })).toBe(
      "delegation_disabled",
    );
    expect(
      reason({ project: { delegationEnabled: true, delegationAllowedAgents: ["claude-code"] } }),
    ).toBe("agent_not_allowed");
    expect(
      reason({ project: { delegationEnabled: true, delegationAllowedAgents: ["codex"] } }),
    ).toBe("ok");
  });

  it("父 Run 的 Runner 沒有這個 Agent、或父 Run 已結束時拒絕", () => {
    expect(reason({ agentAvailableOnParentRunner: false })).toBe("agent_unavailable");
    expect(reason({ parent: { ...base.parent, running: false } })).toBe("parent_not_running");
  });

  it("Permission Policy 只能等於或嚴於父 Run", () => {
    expect(reason({ permissionPolicy: "manual" })).toBe("ok");
    expect(reason({ permissionPolicy: "yolo" })).toBe("policy_not_allowed");
    expect(isPolicyAtMostAsPermissive("auto", "yolo")).toBe(true);
    expect(isPolicyAtMostAsPermissive("auto", "manual")).toBe(false);
  });
});

describe.skipIf(dbSkipReason !== null)("Child Run（MCP 工具）", () => {
  let database: TestDatabase;
  let flow: Flow;
  let parent: StartedRun;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    flow = await startFlow(database.db);
    const runner = await flow.h.pairRunner(flow.team.members.member, "local", [
      { id: "claude-code" },
      { id: "codex" },
    ]);
    parent = await startRun(flow, { runner });
  });

  afterEach(async () => {
    await flow.close();
  });

  interface As {
    dispatchId: string;
    runId: string;
  }

  /** 以某個 Run（預設父 Run）的身分呼叫工具。 */
  const tool = (call: Record<string, unknown>, as?: As, callId?: string) =>
    parent.mine.toolCall(
      as?.dispatchId ?? parent.offer.dispatch_id,
      as?.runId ?? parent.run.id,
      call,
      callId,
    );

  const DELEGATE = {
    tool: "delegate",
    agent: "codex",
    model: null,
    mode: "consult",
    prompt: "幫我看這段",
    permission_policy: null,
    purpose: "tool",
    verification_id: null,
  };

  const delegate = (extra: Record<string, unknown> = {}, as?: As) =>
    tool({ ...DELEGATE, ...extra }, as);

  /** 讓 Runner 接受 Child Run 的 Offer 並回報 running。 */
  async function acceptChild(childRunId: string) {
    await flow.h.ctx.services.dispatcher.kick();
    const offer = await parent.mine.next("dispatch_offer", (o) => o.run_id === childRunId);
    parent.mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
    await waitUntil(async () => (await runRow(database.db, childRunId))?.status === "starting");
    await parent.mine.eventAcked(offer.dispatch_id, childRunId, RUNNING);
    return { offer, as: { dispatchId: offer.dispatch_id, runId: childRunId } };
  }

  const childId = (result: unknown) => {
    const r = result as { outcome: string; output?: { child_run_id?: string } };
    if (r.outcome !== "ok" || !r.output?.child_run_id) throw new Error(JSON.stringify(result));
    return r.output.child_run_id;
  };

  const status = (as: As, value: "completed" | "failed" | "canceled") =>
    parent.mine.eventAcked(as.dispatchId, as.runId, {
      kind: "status_changed",
      status: value,
      gate: null,
      message: null,
    });

  describe("delegate", () => {
    it("consult：建立 Child Run，派給父 Run 的 Runner，Offer 帶 Delegation 資訊與 delegate 的 prompt", async () => {
      const { result } = await delegate();
      const id = childId(result);
      expect(result).toMatchObject({ output: { tool: "delegate", branch: null } });
      const child = await runRow(database.db, id);
      expect(child).toMatchObject({
        parentRunId: parent.run.id,
        delegationMode: "consult",
        origin: "delegation",
        agent: "codex",
        permissionPolicy: parent.run.permissionPolicy,
        target: "local",
        branch: null,
      });
      const { offer } = await acceptChild(id);
      expect(offer).toMatchObject({
        delegation: { parent_run_id: parent.run.id, mode: "consult", depth: 1, child_seq: 1 },
        plan_gate: false,
        origin: "delegation",
        prompt: [{ type: "text", text: "幫我看這段" }],
      });
    });

    it("branch：分支是父分支加上 --c<n>", async () => {
      const first = childId((await delegate({ mode: "branch" })).result);
      const second = childId((await delegate({ mode: "branch" })).result);
      expect((await runRow(database.db, first))?.branch).toBe(`${parent.run.branch}--c1`);
      expect((await runRow(database.db, second))?.branch).toBe(`${parent.run.branch}--c2`);
    });

    it("同一個 call_id 重送時不會建出兩個 Child Run", async () => {
      const first = await delegate();
      const again = await tool(DELEGATE, undefined, first.callId);
      expect(again.result).toEqual(first.result);
      const children = await database.db
        .select()
        .from(runs)
        .where(eq(runs.parentRunId, parent.run.id));
      expect(children).toHaveLength(1);
    });

    it("父 Run 的 Runner 沒有這個 Agent、Project 不允許這個 Agent 或關閉 Delegation 時拒絕", async () => {
      expect((await delegate({ agent: "gemini" })).result).toMatchObject({
        code: "agent_unavailable",
      });
      await database.db
        .update(projects)
        .set({ delegationAllowedAgents: ["claude-code"] })
        .where(eq(projects.id, flow.project.id));
      expect((await delegate()).result).toMatchObject({ code: "agent_not_allowed" });
      await database.db
        .update(projects)
        .set({ delegationEnabled: false })
        .where(eq(projects.id, flow.project.id));
      expect((await delegate()).result).toMatchObject({ code: "delegation_disabled" });
    });

    it("深度最多 2 層：Child Run 的 Child Run 不能再分派", async () => {
      const child = await acceptChild(childId((await delegate()).result));
      const grandchild = await acceptChild(childId((await delegate({}, child.as)).result));
      expect(grandchild.offer.delegation).toMatchObject({ depth: 2 });
      expect((await delegate({}, grandchild.as)).result).toMatchObject({
        code: "depth_exceeded",
      });
    });

    it("每個 Run 同時最多 5 個還沒結束的 Child Run", async () => {
      for (let i = 0; i < 5; i++) childId((await delegate()).result);
      expect((await delegate()).result).toMatchObject({ code: "child_limit_exceeded" });
    });

    it("Permission Policy 只能等於或嚴於父 Run", async () => {
      expect((await delegate({ permission_policy: "yolo" })).result).toMatchObject({
        code: "permission_not_narrower",
      });
      const id = childId((await delegate({ permission_policy: "manual" })).result);
      expect((await runRow(database.db, id))?.permissionPolicy).toBe("manual");
    });

    it("判定 Verification 的 consult 不受 Project 的 Delegation 設定限制，但必須屬於進行中的那一輪", async () => {
      await database.db
        .update(projects)
        .set({ delegationEnabled: false })
        .where(eq(projects.id, flow.project.id));
      const stale = await delegate({ purpose: "verification", verification_id: randomUUID() });
      expect(stale.result).toMatchObject({ code: "invalid_state" });
      await parent.send(AWAITING_REVIEW);
      const verify = await parent.mine.next("run_control", (f) => f.action === "verify");
      if (verify.action !== "verify") throw new Error("unreachable");
      const id = childId(
        (await delegate({ purpose: "verification", verification_id: verify.verification_id }))
          .result,
      );
      expect((await runRow(database.db, id))?.origin).toBe("verification");
    });
  });

  describe("查詢與等待", () => {
    it("get_run 與 list_runs 回傳 Child Run 的狀態；不是自己的 Child Run 時回 not_child", async () => {
      const id = childId((await delegate()).result);
      expect((await tool({ tool: "get_run", run_id: id })).result).toMatchObject({
        outcome: "ok",
        output: { tool: "get_run", run_id: id, agent: "codex", mode: "consult", branch: null },
      });
      const list = (await tool({ tool: "list_runs" })).result as { output: { runs: unknown[] } };
      expect(list.output.runs).toHaveLength(1);
      expect((await tool({ tool: "get_run", run_id: parent.run.id })).result).toMatchObject({
        code: "not_child",
      });
    });

    it("wait_run 阻塞到 Child Run 結束，回傳最後的回覆", async () => {
      const child = await acceptChild(childId((await delegate()).result));
      // 全部測試平行時比較慢：wait_run 等 20 秒，測試等 30 秒。
      const waiting = parent.mine.toolCall(
        parent.offer.dispatch_id,
        parent.run.id,
        { tool: "wait_run", run_id: child.as.runId, timeout_ms: 20_000 },
        undefined,
        30_000,
      );
      await parent.mine.eventAcked(child.as.dispatchId, child.as.runId, {
        kind: "final_message",
        text: { type: "inline", text: "看過了，沒問題" },
      });
      await status(child.as, "completed");
      expect((await waiting).result).toMatchObject({
        outcome: "ok",
        output: { tool: "wait_run", status: "completed", final_message: "看過了，沒問題" },
      });
    });

    it("wait_run 逾時時回傳當下的狀態", async () => {
      const id = childId((await delegate()).result);
      const { result } = await tool({ tool: "wait_run", run_id: id, timeout_ms: 50 });
      const output = (result as { output: { tool: string; status: string } }).output;
      expect(output.tool).toBe("wait_run");
      expect(["queued", "dispatched"]).toContain(output.status);
    });
  });

  describe("ask_parent 與 answer_child", () => {
    it("父 Agent 在 wait_run 看到問題，以 answer_child 回答", async () => {
      const child = await acceptChild(childId((await delegate()).result));
      const asking = tool({ tool: "ask_parent", question: "要用哪個版本？" }, child.as);
      const waited = (await tool({ tool: "wait_run", run_id: child.as.runId, timeout_ms: 5000 }))
        .result as { output: { pending_question: { question_id: string; question: string } } };
      expect(waited.output.pending_question.question).toBe("要用哪個版本？");
      const answered = await tool({
        tool: "answer_child",
        run_id: child.as.runId,
        question_id: waited.output.pending_question.question_id,
        answer: "v2",
      });
      expect(answered.result).toMatchObject({ outcome: "ok", output: { tool: "answer_child" } });
      expect((await asking).result).toMatchObject({ output: { tool: "ask_parent", answer: "v2" } });
    });

    it("父 Run 的回合已經結束時，問題加入 Needs You，由人回答", async () => {
      const child = await acceptChild(childId((await delegate()).result));
      await parent.send(AWAITING_REVIEW);
      const asking = tool({ tool: "ask_parent", question: "可以刪掉舊的 API 嗎？" }, child.as);
      const item = await waitUntil(async () => {
        const list = expectContract(
          NeedsYouListResponse,
          (await flow.as("member").get("/api/needs-you")).body,
        );
        return list.find((i) => i.kind === "child_question");
      });
      expect(item).toMatchObject({
        kind: "child_question",
        runId: parent.run.id,
        childRunId: child.as.runId,
        question: "可以刪掉舊的 API 嗎？",
      });
      if (item.kind !== "child_question") throw new Error("unreachable");
      const answerPath = `/api/child-questions/${item.questionId}/answer`;
      expect((await flow.as("viewer").post(answerPath, { answer: "x" })).status).toBe(403);
      expect((await flow.as("member").post(answerPath, { answer: "可以" })).status).toBe(204);
      expect((await asking).result).toMatchObject({ output: { answer: "可以" } });
      const after = expectContract(
        NeedsYouListResponse,
        (await flow.as("member").get("/api/needs-you")).body,
      );
      expect(after.filter((i) => i.kind === "child_question")).toEqual([]);
      expect((await flow.as("member").post(answerPath, { answer: "again" })).status).toBe(409);
    });
  });

  describe("父 Run 結束與 Task 狀態", () => {
    it("父 Run 結束時，還在佇列的 Child Run 直接取消，在 Runner 上的送 cancel", async () => {
      const queued = childId((await delegate()).result);
      const running = await acceptChild(childId((await delegate()).result));
      await status({ dispatchId: parent.offer.dispatch_id, runId: parent.run.id }, "canceled");
      expect((await runRow(database.db, queued))?.status).toBe("canceled");
      const cancel = await parent.mine.next(
        "run_control",
        (f) => f.run_id === running.as.runId && f.action === "cancel",
      );
      expect(cancel).toBeTruthy();
    });

    it("Child Run 的狀態不會改變 Task 的狀態", async () => {
      const child = await acceptChild(childId((await delegate()).result));
      const before = (await taskRow(database.db, parent.task.id)).status;
      await parent.mine.eventAcked(child.as.dispatchId, child.as.runId, AWAITING_REVIEW);
      await status(child.as, "failed");
      expect((await taskRow(database.db, parent.task.id)).status).toBe(before);
      expect(parent.mine.pending("run_control").filter((f) => f.action === "verify")).toEqual([]);
    });
  });

  describe("merge_child", () => {
    it("只有已完成的 branch 模式 Child Run 可以 merge；回傳子分支（HEAD 由 Runner 讀取）", async () => {
      const consult = childId((await delegate()).result);
      expect((await tool({ tool: "merge_child", run_id: consult })).result).toMatchObject({
        code: "invalid_state",
      });
      const branch = await acceptChild(childId((await delegate({ mode: "branch" })).result));
      expect((await tool({ tool: "merge_child", run_id: branch.as.runId })).result).toMatchObject({
        code: "invalid_state",
      });
      await status(branch.as, "completed");
      expect((await tool({ tool: "merge_child", run_id: branch.as.runId })).result).toMatchObject({
        outcome: "ok",
        output: { tool: "merge_child", branch: `${parent.run.branch}--c2`, head_commit: null },
      });
    });
  });
});
