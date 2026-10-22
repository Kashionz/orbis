// Runner 登錄（Pairing token、撤銷、AgentAvailability）與 Dispatch 佇列（派工規則、逾時、改派）。
// 以模擬 Runner 直接送協定 frame，時間用 ManualClock 推進。

import { NAMES, Run } from "@orbis/api-contract";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PairingTokenCreated, Runner } from "../src/contract-pending";
import { dispatches, runners, runs, tasks } from "../src/db/schema";
import { CLOSE_REVOKED } from "../src/runner/hub";
import {
  client,
  expectContract,
  resetDatabase,
  type SeededTeam,
  seedProject,
  seedReadyTask,
  seedTeam,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  type Harness,
  HEARTBEAT_INTERVAL_MS,
  OFFER_TIMEOUT_MS,
  startHarness,
  waitUntil,
} from "./helpers/runner-harness";

describe.skipIf(dbSkipReason !== null)("Runner 登錄與 Dispatch 佇列", () => {
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

  async function readyTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
    return seedReadyTask(database.db, project, repoId, overrides);
  }

  async function dispatch(
    taskId: string,
    body: Record<string, unknown> = { agent: "claude-code", runnerKind: "local" },
    role: keyof SeededTeam["members"] = "member",
  ) {
    return as(role).post<z.infer<typeof Run>>(`/api/tasks/${taskId}/runs`, body);
  }

  async function runRow(runId: string) {
    const [row] = await database.db.select().from(runs).where(eq(runs.id, runId));
    return row;
  }

  describe("Pairing", () => {
    it("Local Runner 的 Pairing token 綁定建立它的 Member，而且只能用一次", async () => {
      const res = await as("member").post("/api/runner-pairing-tokens", { kind: "local" });
      expect(res.status).toBe(201);
      const created = expectContract(PairingTokenCreated, res.body);
      expect(new Date(created.expiresAt).getTime() - h.ctx.clock.now().getTime()).toBe(
        10 * 60 * 1000,
      );

      const runner = await h.connect();
      runner.hello({ kind: "pairing_token", token: created.token });
      const ack = await runner.next("hello_ack");
      const [row] = await database.db.select().from(runners).where(eq(runners.id, ack.runner_id));
      expect(row).toMatchObject({ kind: "local", memberId: team.members.member.id });

      const again = await h.connect();
      again.hello({ kind: "pairing_token", token: created.token });
      expect(await again.next("hello_rejected")).toMatchObject({ reason: "invalid_pairing_token" });
    });

    it("過期的 Pairing token 被拒絕", async () => {
      const res = await as("member").post<{ token: string }>("/api/runner-pairing-tokens", {
        kind: "local",
      });
      h.ctx.clock.advance(10 * 60 * 1000 + 1);
      const runner = await h.connect();
      runner.hello({ kind: "pairing_token", token: res.body.token });
      expect(await runner.next("hello_rejected")).toMatchObject({
        reason: "invalid_pairing_token",
      });
    });

    it("Team Runner 的 Pairing token 只有 Admin 以上能產生", async () => {
      expect((await as("member").post("/api/runner-pairing-tokens", { kind: "team" })).status).toBe(
        403,
      );
      const res = await as("admin").post<{ token: string }>("/api/runner-pairing-tokens", {
        kind: "team",
      });
      expect(res.status).toBe(201);
      const runner = await h.connect();
      runner.hello({ kind: "pairing_token", token: res.body.token });
      const ack = await runner.next("hello_ack");
      const [row] = await database.db.select().from(runners).where(eq(runners.id, ack.runner_id));
      expect(row).toMatchObject({ kind: "team", memberId: null, teamId: team.teamId });
    });

    it("Viewer 不能產生 Local Runner 的 Pairing token", async () => {
      expect(
        (await as("viewer").post("/api/runner-pairing-tokens", { kind: "local" })).status,
      ).toBe(403);
    });
  });

  describe("Runner 清單與 AgentAvailability", () => {
    it("回報的 AgentAvailability 出現在 Runner 清單中", async () => {
      const runner = await h.pairRunner(team.members.member, "local", [
        { id: "claude-code" },
        { id: "codex", available: false },
      ]);
      const res = await as("member").get("/api/runners");
      const list = expectContract(z.array(Runner), res.body);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: runner.runnerId,
        kind: "local",
        online: true,
        acceptingDispatches: true,
      });
      expect(list[0]?.agents.map((a) => [a.agent, a.available, a.maxConcurrency])).toEqual([
        ["claude-code", true, 30],
        ["codex", false, 30],
      ]);
    });

    it("Member 只看得到 Team Runner 與自己的 Local Runner；Admin 看得到全部", async () => {
      await h.pairRunner(team.members.member, "local");
      await h.pairRunner(team.members.admin, "local");
      await h.pairRunner(team.members.admin, "team");
      expect(((await as("member").get("/api/runners")).body as unknown[]).length).toBe(2);
      expect(((await as("admin").get("/api/runners")).body as unknown[]).length).toBe(3);
    });

    it("斷線後顯示為離線", async () => {
      const runner = await h.pairRunner(team.members.member, "local");
      runner.close();
      await runner.closed;
      await waitUntil(() => !h.ctx.services.hub.isOnline(runner.runnerId));
      const list = (await as("member").get<{ online: boolean }[]>("/api/runners")).body;
      expect(list[0]?.online).toBe(false);
    });
  });

  describe("派工", () => {
    it("「在我的電腦跑」只派給派工者自己的 Local Runner，Offer 帶完整的資訊", async () => {
      const other = await h.pairRunner(team.members.admin, "local");
      const team_ = await h.pairRunner(team.members.admin, "team");
      const mine = await h.pairRunner(team.members.member, "local");
      const task = await readyTask();

      const res = await dispatch(task.id);
      expect(res.status).toBe(201);
      const run = expectContract(Run, res.body);
      expect(run).toMatchObject({
        status: "queued",
        runnerKind: "local",
        permissionPolicy: "auto",
        startedByMemberId: team.members.member.id,
        branch: `${NAMES.branchPrefix}${task.key}-add-login-page`,
      });
      const [taskRow] = await database.db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(taskRow?.status).toBe("running");

      await h.ctx.services.dispatcher.kick();
      const offer = await mine.next("dispatch_offer");
      expect(offer).toMatchObject({
        run_id: run.id,
        task: { task_id: task.id, task_key: task.key, title: task.title },
        run_seq: 1,
        repo: {
          name: "orbis",
          clone_url: "https://github.com/acme/orbis.git",
          default_branch: "main",
          base_ref: "origin/main",
        },
        branch: run.branch,
        agent: "claude-code",
        model: null,
        permission_policy: "auto",
        plan_gate: false,
        delegation: null,
        last_event_seq: 0,
      });
      expect(offer.prompt[0]).toMatchObject({ type: "text" });
      expect(JSON.stringify(offer.prompt)).toContain("pnpm test");
      expect(other.pending("dispatch_offer")).toHaveLength(0);
      expect(team_.pending("dispatch_offer")).toHaveLength(0);
      expect((await runRow(run.id))?.status).toBe("dispatched");
    });

    it("Local Runner 離線時 Run 留在佇列，不轉給 Team Runner；上線後才派", async () => {
      const teamRunner = await h.pairRunner(team.members.admin, "team");
      const task = await readyTask();
      const run = (await dispatch(task.id)).body;
      await h.ctx.services.dispatcher.kick();
      expect((await runRow(run.id))?.status).toBe("queued");
      expect(teamRunner.pending("dispatch_offer")).toHaveLength(0);

      const mine = await h.pairRunner(team.members.member, "local");
      await h.ctx.services.dispatcher.kick();
      expect((await mine.next("dispatch_offer")).run_id).toBe(run.id);
    });

    it("Team Runner 的 Run 進入 Team 佇列", async () => {
      const teamRunner = await h.pairRunner(team.members.admin, "team");
      await h.pairRunner(team.members.member, "local");
      const task = await readyTask();
      const run = (await dispatch(task.id, { agent: "claude-code", runnerKind: "team" })).body;
      await h.ctx.services.dispatcher.kick();
      expect((await teamRunner.next("dispatch_offer")).run_id).toBe(run.id);
    });

    it("其他 Team 的 Team Runner 不會領到", async () => {
      const other = await seedTeam(database.db, "Other");
      const foreign = await h.pairRunner(other.members.admin, "team");
      const task = await readyTask();
      const run = (await dispatch(task.id, { agent: "claude-code", runnerKind: "team" })).body;
      await h.ctx.services.dispatcher.kick();
      expect((await runRow(run.id))?.status).toBe("queued");
      expect(foreign.pending("dispatch_offer")).toHaveLength(0);
    });

    it("Runner 沒有該 Agent 或 Agent 不可用時不派；回報可用後才派", async () => {
      const mine = await h.pairRunner(team.members.member, "local", [
        { id: "claude-code", available: false },
      ]);
      const task = await readyTask();
      const run = (await dispatch(task.id)).body;
      await h.ctx.services.dispatcher.kick();
      expect((await runRow(run.id))?.status).toBe("queued");

      mine.availability([{ id: "claude-code" }]);
      expect((await mine.next("dispatch_offer")).run_id).toBe(run.id);
    });

    it("Heartbeat 的 accepting_dispatches 為 false 時不派工", async () => {
      const mine = await h.pairRunner(team.members.member, "local");
      mine.heartbeat({ accepting_dispatches: false });
      await waitUntil(() => !h.ctx.services.hub.isAcceptingDispatches(mine.runnerId));
      const task = await readyTask();
      const run = (await dispatch(task.id)).body;
      await h.ctx.services.dispatcher.kick();
      expect((await runRow(run.id))?.status).toBe("queued");

      mine.heartbeat({ accepting_dispatches: true });
      expect((await mine.next("dispatch_offer")).run_id).toBe(run.id);
    });

    it("Task 不在 Ready 或相依的 Task 還沒 Done 時拒絕派工", async () => {
      const backlog = await readyTask({ status: "backlog" });
      const res = await dispatch(backlog.id);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "invalid_transition" });

      const dep = await readyTask();
      const task = await readyTask();
      await as("member").patch(`/api/tasks/${task.id}`, { dependsOn: [dep.id] });
      expect((await dispatch(task.id)).status).toBe(409);
      await database.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, dep.id));
      expect((await dispatch(task.id)).status).toBe(201);
    });

    it("Permission Policy：預設用 Project 的設定；yolo 只能用在 Local Runner", async () => {
      await database.db.execute(
        sql`update projects set default_permission_policy = 'manual' where id = ${project.id}`,
      );
      const a = await readyTask();
      expect((await dispatch(a.id)).body.permissionPolicy).toBe("manual");

      const b = await readyTask();
      const teamYolo = await dispatch(b.id, {
        agent: "claude-code",
        runnerKind: "team",
        permissionPolicy: "yolo",
      });
      expect(teamYolo.status).toBe(422);
      const localYolo = await dispatch(b.id, {
        agent: "claude-code",
        runnerKind: "local",
        permissionPolicy: "yolo",
      });
      expect(localYolo.status).toBe(201);
      expect(localYolo.body.permissionPolicy).toBe("yolo");
    });

    it("同一個 Task 的第二個 Run 的分支加上序號", async () => {
      const task = await readyTask();
      const first = (await dispatch(task.id)).body;
      await as("member").post(`/api/runs/${first.id}/cancel`);
      const second = (await dispatch(task.id)).body;
      expect(second.branch).toBe(`${NAMES.branchPrefix}${task.key}-add-login-page-r2`);
    });
  });

  describe("Dispatch 的回覆與逾時", () => {
    async function offered() {
      const mine = await h.pairRunner(team.members.member, "local");
      const task = await readyTask();
      const run = (await dispatch(task.id)).body;
      await h.ctx.services.dispatcher.kick();
      const offer = await mine.next("dispatch_offer");
      return { mine, task, run, offer };
    }

    it("接受後 Dispatch 為 accepted、Run 為 starting", async () => {
      const { mine, run, offer } = await offered();
      mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await waitUntil(async () => (await runRow(run.id))?.status === "starting");
      const [row] = await database.db
        .select()
        .from(dispatches)
        .where(eq(dispatches.id, offer.dispatch_id));
      expect(row?.status).toBe("accepted");
    });

    it("拒絕後 Run 回到佇列，冷卻期間不再派給同一台 Runner，改派給另一台", async () => {
      const { mine, run, offer } = await offered();
      mine.send({
        type: "dispatch_reject",
        dispatch_id: offer.dispatch_id,
        reason: "concurrency_limit",
        message: "滿了",
      });
      await waitUntil(async () => (await runRow(run.id))?.status === "queued");
      const [row] = await database.db
        .select()
        .from(dispatches)
        .where(eq(dispatches.id, offer.dispatch_id));
      expect(row).toMatchObject({ status: "rejected", rejectReason: "concurrency_limit" });

      await h.ctx.services.dispatcher.kick();
      expect(mine.pending("dispatch_offer")).toHaveLength(0);
      const second = await h.pairRunner(team.members.member, "local");
      await h.ctx.services.dispatcher.kick();
      expect((await second.next("dispatch_offer")).run_id).toBe(run.id);
    });

    it("Offer 逾時沒有回覆就過期並重新派工；過期後的 accept 被忽略", async () => {
      const { mine, run, offer } = await offered();
      h.ctx.clock.advance(OFFER_TIMEOUT_MS);
      // 先讓 Server 收到新的 Heartbeat，避免同時被判定為 Heartbeat 逾時。
      mine.heartbeat();
      await waitUntil(async () => {
        const [row] = await database.db.select().from(runners).where(eq(runners.id, mine.runnerId));
        return row?.lastHeartbeatAt?.getTime() === h.ctx.clock.now().getTime();
      });
      await h.ctx.services.dispatcher.kick();
      const reoffer = await mine.next("dispatch_offer");
      expect(reoffer.run_id).toBe(run.id);
      expect(reoffer.dispatch_id).not.toBe(offer.dispatch_id);
      const [old] = await database.db
        .select()
        .from(dispatches)
        .where(eq(dispatches.id, offer.dispatch_id));
      expect(old?.status).toBe("expired");

      mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      mine.send({ type: "dispatch_accept", dispatch_id: reoffer.dispatch_id });
      await waitUntil(async () => (await runRow(run.id))?.status === "starting");
      const [stillExpired] = await database.db
        .select()
        .from(dispatches)
        .where(eq(dispatches.id, offer.dispatch_id));
      expect(stillExpired?.status).toBe("expired");
    });

    it("逾時前重新連上沿用原 Dispatch，hello_ack 的 resume 帶最後的 seq", async () => {
      const { mine, run, offer } = await offered();
      mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await waitUntil(async () => (await runRow(run.id))?.status === "starting");
      await mine.eventAcked(offer.dispatch_id, run.id, {
        kind: "status_changed",
        status: "running",
        gate: null,
        message: null,
      });
      await mine.eventAcked(offer.dispatch_id, run.id, { kind: "thought_chunk", text: "想一下" });
      mine.close();
      await mine.closed;

      h.ctx.clock.advance(HEARTBEAT_INTERVAL_MS);
      const back = await h.connect();
      back.hello({ kind: "runner_token", runner_id: mine.runnerId, token: mine.runnerToken });
      const ack = await back.next("hello_ack");
      expect(ack.resume).toEqual([{ run_id: run.id, last_seq: 2 }]);
      await h.ctx.services.dispatcher.kick();
      const [row] = await database.db
        .select()
        .from(dispatches)
        .where(eq(dispatches.id, offer.dispatch_id));
      expect(row?.status).toBe("accepted");
    });

    it("Heartbeat 逾時後改派：新的 Offer 帶 last_event_seq，舊 Dispatch 的 Event 被拒絕", async () => {
      const { mine, run, offer } = await offered();
      mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await waitUntil(async () => (await runRow(run.id))?.status === "starting");
      for (let i = 0; i < 3; i++) {
        await mine.eventAcked(offer.dispatch_id, run.id, { kind: "thought_chunk", text: `${i}` });
      }

      h.ctx.clock.advance(3 * HEARTBEAT_INTERVAL_MS + 1);
      await h.ctx.services.dispatcher.kick();
      expect(await mine.closed).toBe(4002);
      const [old] = await database.db
        .select()
        .from(dispatches)
        .where(eq(dispatches.id, offer.dispatch_id));
      expect(old?.status).toBe("expired");
      expect((await runRow(run.id))?.status).toBe("queued");

      const back = await h.reconnect(mine);
      await h.ctx.services.dispatcher.kick();
      const reoffer = await back.next("dispatch_offer");
      expect(reoffer).toMatchObject({ run_id: run.id, last_event_seq: 3 });

      // 舊 Dispatch 送來的 Event 不會被保存，也不會 ack。
      back.event(offer.dispatch_id, run.id, { kind: "thought_chunk", text: "過期" }, 4);
      back.send({ type: "dispatch_accept", dispatch_id: reoffer.dispatch_id });
      await waitUntil(async () => (await runRow(run.id))?.status === "starting");
      const ack = await back.eventAcked(
        reoffer.dispatch_id,
        run.id,
        { kind: "thought_chunk", text: "新的" },
        4,
      );
      expect(ack.seq).toBe(4);
      const events = await as("viewer").get<{ event: { text: string } }[]>(
        `/api/runs/${run.id}/events`,
      );
      expect(events.body.map((e) => e.event.text)).toEqual(["0", "1", "2", "新的"]);
    });

    it("撤銷 Runner：立刻斷線、Runner token 失效、進行中的 Run 回到佇列", async () => {
      const { mine, run, offer } = await offered();
      mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await waitUntil(async () => (await runRow(run.id))?.status === "starting");

      expect((await as("viewer").delete(`/api/runners/${mine.runnerId}`)).status).toBe(403);
      expect((await as("member").delete(`/api/runners/${mine.runnerId}`)).status).toBe(204);
      expect(await mine.closed).toBe(CLOSE_REVOKED);
      expect((await runRow(run.id))?.status).toBe("queued");

      const back = await h.connect();
      back.hello({ kind: "runner_token", runner_id: mine.runnerId, token: mine.runnerToken });
      expect(await back.next("hello_rejected")).toMatchObject({ reason: "invalid_runner_token" });
    });

    it("Admin 可以撤銷別人的 Local Runner，Member 不行", async () => {
      const others = await h.pairRunner(team.members.admin, "local");
      expect((await as("member").delete(`/api/runners/${others.runnerId}`)).status).toBe(403);
      const mine = await h.pairRunner(team.members.member, "local");
      expect((await as("admin").delete(`/api/runners/${mine.runnerId}`)).status).toBe(204);
    });
  });
});
