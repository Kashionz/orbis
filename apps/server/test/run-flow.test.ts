// Event 儲存與投影、Needs You、Review Gate，以及 M1 的完整路徑（模擬 Runner）。

import { NAMES, NeedsYouItem, Run, Task } from "@orbis/api-contract";
import type { EventKind } from "@orbis/protocol";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
// TODO(contract): review diff 的 kind 進入協定後改用契約的 RunEvent。
import { Gate, PendingRunEvent as RunEvent } from "../src/contract-pending";
import { gates, needsYouItems, runEvents, runs, tasks } from "../src/db/schema";
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
import { type Harness, type MockRunner, startHarness, waitUntil } from "./helpers/runner-harness";

/** Runner 回報的 Worktree 路徑（Windows）。 */
const WORKTREE_PATH = `${NAMES.worktreeRootWindows}\\orbis\\ORB-1-1`;
const RUNNING: EventKind = { kind: "status_changed", status: "running", gate: null, message: null };
const AWAITING_REVIEW: EventKind = {
  kind: "status_changed",
  status: "awaiting_gate",
  gate: "review",
  message: null,
};
const PERMISSION_REQUEST: EventKind = {
  kind: "permission_request",
  request_id: "0192f3a0-0000-7000-8000-00000000aa01",
  tool_call_id: "tool-1",
  title: "執行 pnpm install",
  options: [
    { option_id: "allow", name: "允許", kind: "allow_once" },
    { option_id: "reject", name: "拒絕", kind: "reject_once" },
  ],
};
const REVIEW_DIFF = {
  kind: "review_diff",
  files: [
    {
      path: "src/login.ts",
      old_path: null,
      change: "added",
      old: null,
      new: { type: "inline", text: "export const login = 1;\n" },
    },
  ],
} as unknown as EventKind;

describe.skipIf(dbSkipReason !== null)("Run 的 Event、Needs You 與 Review Gate", () => {
  let database: TestDatabase;
  let h: Harness;
  let team: SeededTeam;
  let project: Awaited<ReturnType<typeof seedProject>>["project"];
  let repoId: string;

  const as = (role: keyof SeededTeam["members"]) => client(h.ctx.app, team.members[role].cookie);

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

  /** 建立 Ready 的 Task、派工到 Member 的 Local Runner，Runner 接受並回報 running。 */
  async function startedRun(
    overrides: Partial<typeof tasks.$inferInsert> = {},
    runnerKind: "local" | "team" = "local",
  ) {
    const mine =
      runnerKind === "local"
        ? await h.pairRunner(team.members.member, "local")
        : await h.pairRunner(team.members.admin, "team");
    const task = await seedReadyTask(database.db, project, repoId, overrides);
    const created = await as("member").post<z.infer<typeof Run>>(`/api/tasks/${task.id}/runs`, {
      agent: "claude-code",
      runnerKind,
    });
    expect(created.status).toBe(201);
    const run = created.body;
    await h.ctx.services.dispatcher.kick();
    const offer = await mine.next("dispatch_offer");
    mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
    await waitUntil(async () => (await runRow(run.id))?.status === "starting");
    await mine.eventAcked(offer.dispatch_id, run.id, RUNNING);
    const send = (kind: EventKind) => mine.eventAcked(offer.dispatch_id, run.id, kind);
    return { mine, task, run, offer, send };
  }

  async function runRow(runId: string) {
    const [row] = await database.db.select().from(runs).where(eq(runs.id, runId));
    return row;
  }

  async function taskStatus(taskId: string) {
    const [row] = await database.db.select().from(tasks).where(eq(tasks.id, taskId));
    return row?.status;
  }

  async function needsYou(role: keyof SeededTeam["members"]) {
    const res = await as(role).get("/api/needs-you");
    expect(res.status).toBe(200);
    return expectContract(z.array(NeedsYouItem), res.body);
  }

  async function openReviewGate(started: Awaited<ReturnType<typeof startedRun>>) {
    await started.send(REVIEW_DIFF);
    await started.send(AWAITING_REVIEW);
    const list = await as("viewer").get(`/api/tasks/${started.task.id}/gates`);
    const open = expectContract(z.array(Gate), list.body).find((g) => g.decision === null);
    if (!open) throw new Error("沒有等待中的 Gate");
    return open;
  }

  /** 讀出 Runner 收到的下一個 run_control，並回覆結果。 */
  async function control(mine: MockRunner, action: string, reply: Record<string, unknown> = {}) {
    const frame = await mine.next("run_control", (f) => f.action === action);
    mine.send({
      type: "run_control_result",
      control_id: frame.control_id,
      run_id: frame.run_id,
      dispatch_id: frame.dispatch_id,
      outcome: "applied",
      ...reply,
    });
    return frame;
  }

  describe("Event 儲存", () => {
    it("依 seq 去除重複，ack 只到連續保存的位置", async () => {
      const { mine, run, offer } = await startedRun();
      // seq 1 已是 running。送 3、2、2（重送）。
      mine.event(offer.dispatch_id, run.id, { kind: "thought_chunk", text: "c" }, 3);
      expect((await mine.next("event_ack")).seq).toBe(1);
      mine.event(offer.dispatch_id, run.id, { kind: "thought_chunk", text: "b" }, 2);
      expect((await mine.next("event_ack")).seq).toBe(3);
      mine.event(offer.dispatch_id, run.id, { kind: "thought_chunk", text: "重送" }, 2);
      expect((await mine.next("event_ack")).seq).toBe(3);

      const rows = await database.db.select().from(runEvents).where(eq(runEvents.runId, run.id));
      expect(rows).toHaveLength(3);
      const res = await as("viewer").get(`/api/runs/${run.id}/events`);
      const events = expectContract(z.array(RunEvent), res.body);
      expect(events.map((e) => [e.seq, e.event.kind])).toEqual([
        [1, "status_changed"],
        [2, "thought_chunk"],
        [3, "thought_chunk"],
      ]);
      expect(events[1]?.event).toEqual({ kind: "thought_chunk", text: "b" });
    });

    it("可以從任一個 seq 開始讀取", async () => {
      const { run, send } = await startedRun();
      for (let i = 0; i < 5; i++) await send({ kind: "thought_chunk", text: `${i}` });
      const res = await as("viewer").get(`/api/runs/${run.id}/events?afterSeq=3&limit=2`);
      expect(expectContract(z.array(RunEvent), res.body).map((e) => e.seq)).toEqual([4, 5]);
    });

    it("不屬於這台 Runner 或不是目前 Dispatch 的 Event 被拒絕", async () => {
      const { run, offer } = await startedRun();
      const intruder = await h.pairRunner(team.members.admin, "local");
      intruder.event(offer.dispatch_id, run.id, { kind: "thought_chunk", text: "冒充" }, 2);
      intruder.event(
        "0192f3a0-0000-7000-8000-000000000000",
        run.id,
        { kind: "thought_chunk", text: "x" },
        2,
      );
      intruder.heartbeat();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(intruder.pending("event_ack")).toHaveLength(0);
      const rows = await database.db.select().from(runEvents).where(eq(runEvents.runId, run.id));
      expect(rows).toHaveLength(1);
    });

    it("worktree_ready、usage、status_changed 更新 Run", async () => {
      const { run, send } = await startedRun();
      await send({
        kind: "worktree_ready",
        worktree_path: WORKTREE_PATH,
        branch: run.branch,
        base_commit: "a".repeat(40),
      });
      await send({
        kind: "usage",
        input_tokens: 100,
        output_tokens: 20,
        thought_tokens: null,
        cached_read_tokens: null,
        cached_write_tokens: null,
        context_used_tokens: 120,
        context_window_tokens: 200000,
        cost: { amount: 0.12, currency: "USD" },
      });
      const res = await as("viewer").get(`/api/runs/${run.id}`);
      const updated = expectContract(Run, res.body);
      expect(updated).toMatchObject({
        status: "running",
        worktreePath: WORKTREE_PATH,
        baseCommit: "a".repeat(40),
        usage: { inputTokens: 100, outputTokens: 20, cost: { amount: 0.12, currency: "USD" } },
      });
      expect(updated.startedAt).not.toBeNull();
    });

    it("最新的 review diff 可以單獨取得", async () => {
      const { run, send } = await startedRun();
      expect((await as("viewer").get(`/api/runs/${run.id}/review-diff`)).status).toBe(404);
      await send(REVIEW_DIFF);
      const res = await as("viewer").get<{ seq: number; event: { kind: string } }>(
        `/api/runs/${run.id}/review-diff`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ seq: 2, event: { kind: "review_diff" } });
    });

    it("其他 Team 的人讀不到 Run 與 Event", async () => {
      const { run } = await startedRun();
      const other = await seedTeam(database.db, "Other");
      const outsider = client(h.ctx.app, other.members.owner.cookie);
      expect((await outsider.get(`/api/runs/${run.id}`)).status).toBe(404);
      expect((await outsider.get(`/api/runs/${run.id}/events`)).status).toBe(404);
    });

    it("Run 失敗時 Task 回到 Ready，未處理的權限請求自動結束", async () => {
      const { run, task, send } = await startedRun();
      await send(PERMISSION_REQUEST);
      expect(await needsYou("member")).toHaveLength(1);
      await send({ kind: "error", code: "agent_crashed", message: "掛了", fatal: true });
      await send({ kind: "status_changed", status: "failed", gate: null, message: "掛了" });
      expect(await taskStatus(task.id)).toBe("ready");
      expect((await runRow(run.id))?.finishedAt).not.toBeNull();
      expect(await needsYou("member")).toHaveLength(0);
    });
  });

  describe("Needs You：權限請求", () => {
    it("權限請求出現在派工者的 Needs You，回覆後轉成 permission_response", async () => {
      const { mine, run, task, send } = await startedRun();
      await send(PERMISSION_REQUEST);
      const [item] = await needsYou("member");
      expect(item).toMatchObject({
        kind: "permission_request",
        memberId: team.members.member.id,
        taskId: task.id,
        taskKey: task.key,
        runId: run.id,
        title: "執行 pnpm install",
        options: [
          { optionId: "allow", name: "允許", kind: "allow_once" },
          { optionId: "reject", name: "拒絕", kind: "reject_once" },
        ],
      });
      expect(await needsYou("admin")).toHaveLength(0);

      // Local Runner 上的權限請求只有 Runner 的擁有者能回覆，Admin 也不行。
      const byAdmin = await as("admin").post(`/api/needs-you/${item?.id}/respond`, {
        optionId: "allow",
      });
      expect(byAdmin.status).toBe(403);
      const res = await as("member").post(`/api/needs-you/${item?.id}/respond`, {
        optionId: "allow",
      });
      expect(res.status).toBe(204);
      const frame = await control(mine, "permission_response");
      expect(frame).toMatchObject({
        run_id: run.id,
        action: "permission_response",
        request_id:
          PERMISSION_REQUEST.kind === "permission_request" ? PERMISSION_REQUEST.request_id : "",
        option_id: "allow",
      });
      expect(await needsYou("member")).toHaveLength(0);
    });

    it("Team Runner 上的權限請求，Project 中 Member 以上的人都能回覆", async () => {
      const { mine, send } = await startedRun({}, "team");
      await send(PERMISSION_REQUEST);
      const [item] = await needsYou("member");
      const path = `/api/needs-you/${item?.id}/respond`;
      expect((await as("viewer").post(path, { optionId: "allow" })).status).toBe(403);
      expect((await as("admin").post(path, { optionId: "allow" })).status).toBe(204);
      expect(await control(mine, "permission_response")).toMatchObject({ option_id: "allow" });
    });

    it("選項不存在回 422，重複回覆回 409，Viewer 不能回覆", async () => {
      const { send } = await startedRun();
      await send(PERMISSION_REQUEST);
      const [item] = await needsYou("member");
      const path = `/api/needs-you/${item?.id}/respond`;
      expect((await as("viewer").post(path, { optionId: "allow" })).status).toBe(403);
      expect((await as("member").post(path, { optionId: "nope" })).status).toBe(422);
      expect((await as("member").post(path, { optionId: "reject" })).status).toBe(204);
      expect((await as("member").post(path, { optionId: "allow" })).status).toBe(409);
    });

    it("permission_resolved Event 結束 Needs You 項目（例如 Agent 撤回請求）", async () => {
      const { send } = await startedRun();
      await send(PERMISSION_REQUEST);
      await send({
        kind: "permission_resolved",
        request_id:
          PERMISSION_REQUEST.kind === "permission_request" ? PERMISSION_REQUEST.request_id : "",
        selected_option_id: null,
      });
      expect(await needsYou("member")).toHaveLength(0);
    });

    it("Runner 離線時回覆先保留，重新連上後補送", async () => {
      const { mine, send } = await startedRun();
      await send(PERMISSION_REQUEST);
      const [item] = await needsYou("member");
      mine.close();
      await mine.closed;
      await waitUntil(() => !h.ctx.services.hub.isOnline(mine.runnerId));
      expect(
        (await as("member").post(`/api/needs-you/${item?.id}/respond`, { optionId: "allow" }))
          .status,
      ).toBe(204);
      const back = await h.reconnect(mine);
      expect(await back.next("run_control")).toMatchObject({
        action: "permission_response",
        option_id: "allow",
      });
    });
  });

  describe("Review Gate", () => {
    it("Agent 做完後 Task 經 Verifying 進入 Review Gate，並出現在負責人的 Needs You", async () => {
      const started = await startedRun({ assigneeMemberId: team.members.admin.id });
      const gate = await openReviewGate(started);
      expect(gate).toMatchObject({
        kind: "review",
        runId: started.run.id,
        taskId: started.task.id,
      });
      expect(await taskStatus(started.task.id)).toBe("review_gate");
      expect((await runRow(started.run.id))?.status).toBe("awaiting_gate");
      const [item] = await needsYou("admin");
      expect(item).toMatchObject({ kind: "gate", gateKind: "review", taskKey: started.task.key });
    });

    it("退回：行內留言打包成 prompt，Task 回到 Running", async () => {
      const started = await startedRun();
      const gate = await openReviewGate(started);
      const res = await as("member").post(`/api/gates/${gate.id}/decision`, {
        action: "reject",
        comment: "請補上測試",
        reviewComments: [
          { path: "src/login.ts", line: 3, side: "new", body: "這裡要處理錯誤" },
          { path: "src/a.ts", line: 1, side: "old", body: "不要刪掉" },
        ],
      });
      expect(res.status).toBe(200);
      expect(expectContract(Gate, res.body)).toMatchObject({
        decision: "rejected",
        comment: "請補上測試",
        decidedByMemberId: team.members.member.id,
      });
      expect(await control(started.mine, "gate_result")).toMatchObject({
        gate: "review",
        decision: "rejected",
      });
      const prompt = await control(started.mine, "prompt");
      expect(prompt).toMatchObject({ action: "prompt" });
      const text = prompt.action === "prompt" ? (prompt.prompt[0] as { text: string }).text : "";
      expect(text).toContain("請補上測試");
      expect(text.indexOf("src/a.ts:1（修改前）：不要刪掉")).toBeLessThan(
        text.indexOf("src/login.ts:3：這裡要處理錯誤"),
      );
      expect(await taskStatus(started.task.id)).toBe("running");
      expect(await needsYou("member")).toHaveLength(0);
    });

    it("退回時沒有任何意見回 400；已決定的 Gate 不能再決定", async () => {
      const started = await startedRun();
      const gate = await openReviewGate(started);
      const path = `/api/gates/${gate.id}/decision`;
      expect((await as("member").post(path, { action: "reject" })).status).toBe(400);
      expect((await as("member").post(path, { action: "approve" })).status).toBe(200);
      expect((await as("member").post(path, { action: "approve" })).status).toBe(409);
    });

    it("核准：Task 轉 PR Open，送出 gate_result 與 push_branch，push 完成後開 PR", async () => {
      const started = await startedRun();
      const gate = await openReviewGate(started);
      expect(
        (await as("member").post(`/api/gates/${gate.id}/decision`, { action: "approve" })).status,
      ).toBe(200);
      expect(await taskStatus(started.task.id)).toBe("pr_open");
      expect(await control(started.mine, "gate_result")).toMatchObject({ decision: "approved" });
      await control(started.mine, "push_branch", {
        outcome: "branch_pushed",
        branch: started.run.branch,
        commit_sha: "b".repeat(40),
      });
      await waitUntil(() => h.ctx.pullRequests.opened.length > 0);
      expect(h.ctx.pullRequests.opened).toEqual([
        {
          taskId: started.task.id,
          runId: started.run.id,
          branch: started.run.branch,
          commitSha: "b".repeat(40),
        },
      ]);
    });

    it("push 失敗時產生「停下來的 Run」的 Needs You", async () => {
      const started = await startedRun();
      const gate = await openReviewGate(started);
      await as("member").post(`/api/gates/${gate.id}/decision`, { action: "approve" });
      await control(started.mine, "gate_result");
      await control(started.mine, "push_branch", {
        outcome: "rejected",
        reason: "failed",
        message: "remote: Permission denied",
      });
      const item = await waitUntil(async () => (await needsYou("member"))[0]);
      expect(item).toMatchObject({ kind: "stopped_run", runId: started.run.id });
      expect(item.kind === "stopped_run" && item.reason).toContain("Permission denied");
    });

    it("中止：送出 cancel，Task 回到 Ready；Runner 回報 canceled 後 Run 結束", async () => {
      const started = await startedRun();
      const gate = await openReviewGate(started);
      expect(
        (await as("member").post(`/api/gates/${gate.id}/decision`, { action: "abort" })).status,
      ).toBe(200);
      await control(started.mine, "cancel");
      expect(await taskStatus(started.task.id)).toBe("ready");
      await started.send({ kind: "status_changed", status: "canceled", gate: null, message: null });
      expect((await runRow(started.run.id))?.status).toBe("canceled");
      expect(await taskStatus(started.task.id)).toBe("ready");
    });

    it("Viewer 不能核准、退回或中止", async () => {
      const started = await startedRun();
      const gate = await openReviewGate(started);
      for (const body of [
        { action: "approve" },
        { action: "reject", comment: "x" },
        { action: "abort" },
      ]) {
        expect((await as("viewer").post(`/api/gates/${gate.id}/decision`, body)).status).toBe(403);
      }
    });

    describe("Project 禁止核准自己的 Task", () => {
      beforeEach(async () => {
        await database.db.execute(
          sql`update projects set forbid_self_approval = true where id = ${project.id}`,
        );
      });

      it("負責人是自己的 Member 不能核准，但可以退回；其他 Member 可以核准", async () => {
        const started = await startedRun({ assigneeMemberId: team.members.member.id });
        const gate = await openReviewGate(started);
        const path = `/api/gates/${gate.id}/decision`;
        expect((await as("member").post(path, { action: "approve" })).status).toBe(403);
        const peer = await seedMember(database.db, team.teamId, "member");
        expect(
          (await client(h.ctx.app, peer.cookie).post(path, { action: "approve" })).status,
        ).toBe(200);
      });

      it("Gate 等待期間改派給別人後再核准，仍被拒絕", async () => {
        const started = await startedRun({ assigneeMemberId: team.members.member.id });
        const gate = await openReviewGate(started);
        const reassigned = await as("member").patch(`/api/tasks/${started.task.id}`, {
          assigneeMemberId: team.members.admin.id,
        });
        expect(reassigned.status).toBe(200);
        const res = await as("member").post(`/api/gates/${gate.id}/decision`, {
          action: "approve",
        });
        expect(res.status).toBe(403);
      });

      it("Admin 可以核准自己的 Task", async () => {
        const started = await startedRun({ assigneeMemberId: team.members.admin.id });
        const gate = await openReviewGate(started);
        expect(
          (await as("admin").post(`/api/gates/${gate.id}/decision`, { action: "approve" })).status,
        ).toBe(200);
      });
    });
  });

  describe("中止 Run", () => {
    it("還在佇列的 Run 直接結束，Task 回到 Ready", async () => {
      const task = await seedReadyTask(database.db, project, repoId);
      const run = (
        await as("member").post<{ id: string }>(`/api/tasks/${task.id}/runs`, {
          agent: "claude-code",
          runnerKind: "local",
        })
      ).body;
      const res = await as("member").post(`/api/runs/${run.id}/cancel`);
      expect(res.status).toBe(202);
      expect(expectContract(Run, res.body).status).toBe("canceled");
      expect(await taskStatus(task.id)).toBe("ready");
      expect((await as("member").post(`/api/runs/${run.id}/cancel`)).status).toBe(409);
    });

    it("執行中的 Run 送出 cancel，由 Runner 回報結果", async () => {
      const { mine, run, task, send } = await startedRun();
      expect((await as("viewer").post(`/api/runs/${run.id}/cancel`)).status).toBe(403);
      expect((await as("member").post(`/api/runs/${run.id}/cancel`)).status).toBe(202);
      await control(mine, "cancel");
      await send({ kind: "status_changed", status: "canceled", gate: null, message: null });
      expect(await taskStatus(task.id)).toBe("ready");
    });
  });

  describe("GitHub 觸發的轉換（給 D 軌的 domain service）", () => {
    it("PR merge → Done；PR 未 merge 就關閉 → Review Gate", async () => {
      const a = await seedReadyTask(database.db, project, repoId, { status: "pr_open" });
      const b = await seedReadyTask(database.db, project, repoId, { status: "pr_open" });
      const domain = h.ctx.services.githubDomain;
      expect((await domain.onPullRequestMerged(a.id)).ok).toBe(true);
      expect(await taskStatus(a.id)).toBe("done");
      expect((await domain.onPullRequestClosedUnmerged(b.id)).ok).toBe(true);
      expect(await taskStatus(b.id)).toBe("review_gate");
      expect(await domain.onPullRequestMerged(b.id)).toMatchObject({
        ok: false,
        reason: "invalid_transition",
        status: "review_gate",
      });
    });

    it("Issue 關閉 → Done（有進行中的 Run 時拒絕）；Issue 重開 → Backlog", async () => {
      const domain = h.ctx.services.githubDomain;
      const idle = await seedReadyTask(database.db, project, repoId);
      expect((await domain.onIssueClosed(idle.id, "completed")).ok).toBe(true);
      expect(await taskStatus(idle.id)).toBe("done");
      expect((await domain.onIssueReopened(idle.id)).ok).toBe(true);
      expect(await taskStatus(idle.id)).toBe("backlog");

      const { task } = await startedRun();
      expect(await domain.onIssueClosed(task.id, "not_planned")).toMatchObject({
        ok: false,
        reason: "active_run",
        status: "running",
      });
    });

    it("Issue 同步寫入 Task 欄位，domain event 標示來源為 github", async () => {
      const seen: unknown[] = [];
      h.ctx.services.events.subscribe((e) => {
        seen.push(e);
      });
      const task = await seedReadyTask(database.db, project, repoId);
      const updated = await h.ctx.services.githubDomain.applyIssueFields(task.id, {
        title: "從 Issue 改的標題",
        labels: ["bug"],
      });
      expect(updated).toMatchObject({ title: "從 Issue 改的標題", labels: ["bug"] });
      expect(seen).toContainEqual(
        expect.objectContaining({ type: "task.updated", taskId: task.id, source: "github" }),
      );
    });
  });

  it("M1 路徑：建立 Task → 派工 → Event → 權限請求 → 回覆 → Review Gate 退回 → 核准 → PR Open", async () => {
    const statuses: string[] = [];
    h.ctx.services.events.subscribe((e) => {
      if (e.type === "task.status_changed") statuses.push(e.to);
    });
    const mine = await h.pairRunner(team.members.member, "local");

    // 建立 Task（API）並補齊 Acceptance Criterion 後轉到 Ready。
    const created = await as("member").post(`/api/projects/${project.id}/tasks`, {
      repoId,
      title: "Add login page",
      description: "用 GitHub OAuth 登入",
      assigneeMemberId: team.members.member.id,
    });
    const task = expectContract(Task, created.body);
    await as("member").post(`/api/tasks/${task.id}/acceptance-criteria`, {
      kind: "command",
      description: "測試通過",
      command: "pnpm test",
    });
    expect(
      (await as("member").post(`/api/tasks/${task.id}/transition`, { status: "ready" })).status,
    ).toBe(200);

    // 派工 → Offer → 接受。
    const run = expectContract(
      Run,
      (
        await as("member").post(`/api/tasks/${task.id}/runs`, {
          agent: "claude-code",
          runnerKind: "local",
        })
      ).body,
    );
    await h.ctx.services.dispatcher.kick();
    const offer = await mine.next("dispatch_offer");
    mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
    const send = (kind: EventKind) => mine.eventAcked(offer.dispatch_id, run.id, kind);
    await send({ kind: "status_changed", status: "starting", gate: null, message: null });
    await send({
      kind: "worktree_ready",
      worktree_path: WORKTREE_PATH,
      branch: offer.branch,
      base_commit: "c".repeat(40),
    });
    await send(RUNNING);
    await send({ kind: "message_chunk", content: { type: "text", text: "開始修改" } });

    // 權限請求 → 回覆。
    await send({
      kind: "status_changed",
      status: "awaiting_permission",
      gate: null,
      message: null,
    });
    await send(PERMISSION_REQUEST);
    const [permission] = await needsYou("member");
    await as("member").post(`/api/needs-you/${permission?.id}/respond`, { optionId: "allow" });
    await control(mine, "permission_response");
    await send({
      kind: "permission_resolved",
      request_id:
        PERMISSION_REQUEST.kind === "permission_request" ? PERMISSION_REQUEST.request_id : "",
      selected_option_id: "allow",
    });
    await send(RUNNING);

    // 第一次交回 → 退回。
    await send(REVIEW_DIFF);
    await send(AWAITING_REVIEW);
    const [firstGateItem] = await needsYou("member");
    expect(firstGateItem).toMatchObject({ kind: "gate", gateKind: "review" });
    const firstGate = (
      await as("member").get<{ id: string; decision: null }[]>(`/api/tasks/${task.id}/gates`)
    ).body[0];
    await as("member").post(`/api/gates/${firstGate?.id}/decision`, {
      action: "reject",
      reviewComments: [{ path: "src/login.ts", line: 1, side: "new", body: "改名" }],
    });
    await control(mine, "gate_result");
    await control(mine, "prompt");
    await send(RUNNING);

    // 第二次交回 → 核准 → push → 開 PR。
    await send(REVIEW_DIFF);
    await send(AWAITING_REVIEW);
    const gateList = expectContract(
      z.array(Gate),
      (await as("member").get(`/api/tasks/${task.id}/gates`)).body,
    );
    const secondGate = gateList.find((g) => g.decision === null);
    expect(
      (await as("member").post(`/api/gates/${secondGate?.id}/decision`, { action: "approve" }))
        .status,
    ).toBe(200);
    await control(mine, "gate_result");
    await control(mine, "push_branch", {
      outcome: "branch_pushed",
      branch: offer.branch,
      commit_sha: "d".repeat(40),
    });
    await waitUntil(() => h.ctx.pullRequests.opened.length === 1);
    await send({ kind: "status_changed", status: "completed", gate: null, message: null });

    const finalTask = expectContract(Task, (await as("viewer").get(`/api/tasks/${task.id}`)).body);
    expect(finalTask.status).toBe("pr_open");
    expect(statuses).toEqual([
      "ready",
      "planning",
      "running",
      "verifying",
      "review_gate",
      "running",
      "verifying",
      "review_gate",
      "pr_open",
    ]);
    const finalRun = expectContract(Run, (await as("viewer").get(`/api/runs/${run.id}`)).body);
    expect(finalRun).toMatchObject({ status: "completed", worktreePath: WORKTREE_PATH });
    const events = expectContract(
      z.array(RunEvent),
      (await as("viewer").get(`/api/runs/${run.id}/events`)).body,
    );
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(await needsYou("member")).toHaveLength(0);
    const open = await database.db
      .select()
      .from(needsYouItems)
      .where(and(eq(needsYouItems.runId, run.id), isNull(needsYouItems.resolvedAt)));
    expect(open).toHaveLength(0);
    expect(await database.db.select().from(gates).where(eq(gates.taskId, task.id))).toHaveLength(2);
    const history = await as("viewer").get(`/api/tasks/${task.id}/runs`);
    expect(expectContract(z.array(Run), history.body).map((r) => r.id)).toEqual([run.id]);
  });
});
