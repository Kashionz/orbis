// Review Gate 的 diff 為空（#73）：不能核准（沒有東西可以 push），改為結束（沒有變更）或退回。
// 結束（沒有變更）：Task → Done（completed），Gate 記為 finishedWithoutChanges，只送 cancel 結束 Run，
// 不送 gate_result 與 push_branch。

import {
  API_ROUTES,
  apiPath,
  Gate,
  NeedsYouListResponse,
  ReviewDiff,
  type Run,
  Task,
} from "@orbis/api-contract";
import type { EventKind } from "@orbis/protocol";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { acceptanceCriteria, needsYouItems, runControls, runs, tasks } from "../src/db/schema";
import {
  client,
  expectContract,
  resetDatabase,
  type SeededTeam,
  seedMember,
  seedProject,
  seedReadyTask,
  seedTeam,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import { type Harness, startHarness, waitUntil } from "./helpers/runner-harness";

const RUNNING: EventKind = { kind: "status_changed", status: "running", gate: null, message: null };
const AWAITING_REVIEW: EventKind = {
  kind: "status_changed",
  status: "awaiting_gate",
  gate: "review",
  message: null,
};
/** 實機中 Codex 把模型錯誤當成一般回覆、以 end_turn 結束回合。 */
const MODEL_ERROR = "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.";
const EMPTY_DIFF: EventKind = { kind: "run_diff", base_commit: "c".repeat(40), files: [] };
const NON_EMPTY_DIFF: EventKind = {
  kind: "run_diff",
  base_commit: "c".repeat(40),
  files: [
    {
      path: "src/login.ts",
      old_path: null,
      change: "added",
      binary: false,
      old: null,
      new: { type: "inline", text: "export const login = 1;\n" },
    },
  ],
};
const finalMessage = (text: string): EventKind => ({
  kind: "final_message",
  text: { type: "inline", text },
});

describe.skipIf(dbSkipReason !== null)("Review Gate 的 diff 為空（#73）", () => {
  let database: TestDatabase;
  let h: Harness;
  let team: SeededTeam;
  let project: Awaited<ReturnType<typeof seedProject>>["project"];
  let repoId: string;

  const as = (role: keyof SeededTeam["members"]) => client(h.ctx.app, team.members[role].cookie);
  const decide = (gateId: string) => apiPath(API_ROUTES.gateDecision, { gateId });
  const FINISH = { action: "finish_without_changes" } as const;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    h = await startHarness(database.db);
    team = await seedTeam(database.db);
    const seeded = await seedProject(database.db, team.teamId);
    project = seeded.project;
    repoId = seeded.repo.id;
  });

  afterEach(async () => {
    await h.close();
  });

  /** 派工到 Member 的 Local Runner，Agent 回覆 `reply` 後送出 `diff`，Verification 通過後進入 Review Gate。 */
  async function reviewGate(
    diff: EventKind,
    reply: string | null = MODEL_ERROR,
    overrides: Partial<typeof tasks.$inferInsert> = {},
  ) {
    const mine = await h.pairRunner(team.members.member, "local");
    const task = await seedReadyTask(database.db, project, repoId, overrides);
    const created = await as("member").post<z.infer<typeof Run>>(
      apiPath(API_ROUTES.taskRuns, { taskId: task.id }),
      { agent: "claude-code", runnerKind: "local" },
    );
    expect(created.status).toBe(201);
    const run = created.body;
    await h.ctx.services.dispatcher.kick();
    const offer = await mine.next("dispatch_offer");
    mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
    await waitUntil(async () => (await runRow(run.id))?.status === "starting");
    const send = (kind: EventKind) => mine.eventAcked(offer.dispatch_id, run.id, kind);
    await send(RUNNING);
    if (reply !== null) await send(finalMessage(reply));
    await send(diff);
    await send(AWAITING_REVIEW);
    await mine.answerVerification(offer.dispatch_id, run.id);
    const list = await as("viewer").get(apiPath(API_ROUTES.taskGates, { taskId: task.id }));
    const gate = expectContract(z.array(Gate), list.body).find((g) => g.decision === null);
    if (!gate) throw new Error("沒有等待中的 Gate");
    return { mine, task, run, offer, send, gate };
  }

  async function runRow(runId: string) {
    const [row] = await database.db.select().from(runs).where(eq(runs.id, runId));
    return row;
  }

  async function taskRow(taskId: string) {
    const [row] = await database.db.select().from(tasks).where(eq(tasks.id, taskId));
    return row;
  }

  /** 送給這個 Run 的 RunControl（依建立順序）。 */
  async function controlActions(runId: string) {
    const rows = await database.db
      .select({ action: runControls.action })
      .from(runControls)
      .where(eq(runControls.runId, runId))
      .orderBy(runControls.createdAt);
    return rows.map((r) => r.action);
  }

  async function needsYou(role: keyof SeededTeam["members"]) {
    const res = await as(role).get(API_ROUTES.needsYou);
    expect(res.status).toBe(200);
    return expectContract(NeedsYouListResponse, res.body);
  }

  it("review diff 帶出 diff 之前 Agent 最後的回覆", async () => {
    const { run } = await reviewGate(EMPTY_DIFF);
    const res = await as("viewer").get(apiPath(API_ROUTES.runReviewDiff, { runId: run.id }));
    const diff = expectContract(ReviewDiff, res.body);
    expect(diff.files).toEqual([]);
    expect(diff.finalMessage).toEqual({ type: "inline", text: MODEL_ERROR });
  });

  it("review diff 只取這份 diff 之前的回覆；沒有回覆時為 null", async () => {
    const { run, send } = await reviewGate(EMPTY_DIFF, null);
    // diff 之後才有的回覆（例如下一個回合）不算。
    await send(finalMessage("之後的回覆"));
    const res = await as("viewer").get(apiPath(API_ROUTES.runReviewDiff, { runId: run.id }));
    expect(expectContract(ReviewDiff, res.body).finalMessage).toBeNull();
  });

  it("diff 為空時不能核准：回 409，Task 留在 Review Gate，不送任何 RunControl", async () => {
    const { task, run, gate } = await reviewGate(EMPTY_DIFF);
    const before = await controlActions(run.id);
    const res = await as("member").post(decide(gate.id), { action: "approve" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("diff 是空的");
    expect((await taskRow(task.id))?.status).toBe("review_gate");
    expect(await controlActions(run.id)).toEqual(before);
    expect(await needsYou("member")).toMatchObject([
      { kind: "gate", gateKind: "review", runId: run.id },
    ]);
  });

  it("結束（沒有變更）：Task 轉 Done（completed），只送 cancel，不 push、不開 PR", async () => {
    const { mine, task, run, send, gate } = await reviewGate(EMPTY_DIFF);
    const before = await controlActions(run.id);
    const res = await as("member").post(decide(gate.id), FINISH);
    expect(res.status).toBe(200);
    expect(expectContract(Gate, res.body)).toMatchObject({
      id: gate.id,
      decision: "approved",
      finishedWithoutChanges: true,
      decidedByMemberId: team.members.member.id,
      comment: null,
    });
    const row = await taskRow(task.id);
    expect(row).toMatchObject({ status: "done", doneReason: "completed" });
    expect(
      expectContract(
        Task,
        (await as("viewer").get(apiPath(API_ROUTES.task, { taskId: task.id }))).body,
      ),
    ).toMatchObject({ status: "done", doneReason: "completed" });
    expect((await controlActions(run.id)).slice(before.length)).toEqual(["cancel"]);
    const cancel = await mine.next("run_control", (f) => f.action === "cancel");
    expect(cancel.run_id).toBe(run.id);
    expect(await needsYou("member")).toHaveLength(0);
    const [item] = await database.db
      .select()
      .from(needsYouItems)
      .where(eq(needsYouItems.gateId, gate.id));
    expect(item?.resolution).toEqual({ action: "finish_without_changes" });

    // Runner 結束程序後回報 canceled：Run 結束，Task 仍是 Done（不會被送回 Ready）。
    await send({ kind: "status_changed", status: "canceled", gate: null, message: null });
    expect((await runRow(run.id))?.status).toBe("canceled");
    expect(await taskRow(task.id)).toMatchObject({ status: "done", doneReason: "completed" });
    expect(h.ctx.pullRequests.opened).toEqual([]);
    // 和中止相同，保留 Worktree：不送 push_branch，也不送 archive。
    expect(await controlActions(run.id)).not.toContain("push_branch");
    expect(await controlActions(run.id)).not.toContain("archive");

    // Gate 的歷程也標示為結束（沒有變更）。
    const listed = expectContract(
      z.array(Gate),
      (await as("viewer").get(apiPath(API_ROUTES.taskGates, { taskId: task.id }))).body,
    );
    expect(listed.find((g) => g.id === gate.id)?.finishedWithoutChanges).toBe(true);
  });

  it("diff 為空時仍可以退回：Task 回到 Running，同一個 session 繼續", async () => {
    const { task, run, gate } = await reviewGate(EMPTY_DIFF);
    const res = await as("member").post(decide(gate.id), {
      action: "reject",
      comment: "模型不支援，請改用預設的模型再試一次",
    });
    expect(res.status).toBe(200);
    expect(expectContract(Gate, res.body).finishedWithoutChanges).toBe(false);
    expect((await taskRow(task.id))?.status).toBe("running");
    expect(await controlActions(run.id)).toContain("prompt");
  });

  it("diff 不為空時不能結束（沒有變更）", async () => {
    const { task, gate } = await reviewGate(NON_EMPTY_DIFF, "完成");
    const res = await as("member").post(decide(gate.id), FINISH);
    expect(res.status).toBe(409);
    expect((await taskRow(task.id))?.status).toBe("review_gate");
    // 核准照常可以。
    expect((await as("member").post(decide(gate.id), { action: "approve" })).status).toBe(200);
    expect((await taskRow(task.id))?.status).toBe("pr_open");
  });

  it("manual 條件沒有全部打勾時不能結束（沒有變更），打勾後可以", async () => {
    const { task, gate } = await reviewGate(EMPTY_DIFF, "答案：登入頁已經存在，不需要修改。");
    const [criterion] = await database.db
      .insert(acceptanceCriteria)
      .values({ taskId: task.id, position: 1, kind: "manual", description: "答案正確" })
      .returning();
    if (!criterion) throw new Error("建立條件失敗");
    expect((await as("member").post(decide(gate.id), FINISH)).status).toBe(409);
    const checked = await as("member").post(
      apiPath(API_ROUTES.acceptanceCriterionCheck, { criterionId: criterion.id }),
      { checked: true },
    );
    expect(checked.status).toBe(200);
    expect((await as("member").post(decide(gate.id), FINISH)).status).toBe(200);
    expect((await taskRow(task.id))?.status).toBe("done");
  });

  it("權限與核准相同：Viewer 不行；Project 禁止核准自己的 Task 時，負責人不行、其他 Member 可以", async () => {
    await database.db.execute(
      sql`update projects set forbid_self_approval = true where id = ${project.id}`,
    );
    const { task, gate } = await reviewGate(EMPTY_DIFF, MODEL_ERROR, {
      assigneeMemberId: team.members.member.id,
    });
    expect((await as("viewer").post(decide(gate.id), FINISH)).status).toBe(403);
    expect((await as("member").post(decide(gate.id), FINISH)).status).toBe(403);
    const peer = await seedMember(database.db, team.teamId, "member");
    expect((await client(h.ctx.app, peer.cookie).post(decide(gate.id), FINISH)).status).toBe(200);
    expect((await taskRow(task.id))?.status).toBe("done");
  });

  it("Plan Gate 不能結束（沒有變更）", async () => {
    const mine = await h.pairRunner(team.members.member, "local");
    const task = await seedReadyTask(database.db, project, repoId, { planGateEnabled: true });
    const created = await as("member").post<z.infer<typeof Run>>(
      apiPath(API_ROUTES.taskRuns, { taskId: task.id }),
      { agent: "claude-code", runnerKind: "local" },
    );
    const run = created.body;
    await h.ctx.services.dispatcher.kick();
    const offer = await mine.next("dispatch_offer");
    mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
    await waitUntil(async () => (await runRow(run.id))?.status === "starting");
    const send = (kind: EventKind) => mine.eventAcked(offer.dispatch_id, run.id, kind);
    await send(RUNNING);
    await send({
      kind: "plan_proposed",
      body: { type: "inline", text: "1. 改登入頁" },
      source: "plan_mode",
    });
    await send({ kind: "status_changed", status: "awaiting_gate", gate: "plan", message: null });
    const list = await as("viewer").get(apiPath(API_ROUTES.taskGates, { taskId: task.id }));
    const gate = expectContract(z.array(Gate), list.body).find((g) => g.decision === null);
    expect(gate?.kind).toBe("plan");
    const res = await as("member").post(decide(gate?.id ?? ""), FINISH);
    expect(res.status).toBe(422);
    expect((await taskRow(task.id))?.status).toBe("plan_gate");
  });
});
