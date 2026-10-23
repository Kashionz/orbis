// Runner 登錄（Pairing token、撤銷、AgentAvailability）與 Dispatch 佇列（派工規則、逾時、改派）。
// 以模擬 Runner 直接送協定 frame，時間用 ManualClock 推進。

import {
  API_ROUTES,
  apiPath,
  DispatchOptions,
  NAMES,
  PairingTokenCreated,
  Run,
  Runner,
} from "@orbis/api-contract";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  dispatches,
  projects,
  runnerPairingTokens,
  runners,
  runs,
  sessions,
  tasks,
} from "../src/db/schema";
import { CLOSE_REVOKED } from "../src/runner/hub";
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
      // 建立 token 的 session 複製到 Runner，登出時據此撤銷。
      const [token] = await database.db
        .select()
        .from(runnerPairingTokens)
        .where(eq(runnerPairingTokens.id, created.id));
      expect(token?.createdBySessionId).not.toBeNull();
      expect(row?.pairedSessionId).toBe(token?.createdBySessionId);

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
      expect(row).toMatchObject({
        kind: "team",
        memberId: null,
        teamId: team.teamId,
        pairedSessionId: null,
      });
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

    it("沒有 Credential 的 Agent，credential 是 null（不是空字串）", async () => {
      await h.pairRunner(team.members.member, "local", [{ id: "gemini", credential: null }]);
      const list = expectContract(z.array(Runner), (await as("member").get("/api/runners")).body);
      expect(list[0]?.agents).toMatchObject([{ agent: "gemini", credential: null }]);
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
      // 契約的 CreateRunInput 直接拒絕（400，issues 指向 permissionPolicy）。
      expect(teamYolo.status).toBe(400);
      expect(teamYolo.body).toMatchObject({
        error: "invalid_input",
        issues: [{ path: ["permissionPolicy"] }],
      });
      // Project 的預設政策是 yolo 時，派工到 Team Runner 由 Server 拒絕。
      await database.db.execute(
        sql`update projects set default_permission_policy = 'yolo' where id = ${project.id}`,
      );
      expect((await dispatch(b.id, { agent: "claude-code", runnerKind: "team" })).status).toBe(422);
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

  describe("派工對話框的選項", () => {
    const optionsOf = async (role: keyof SeededTeam["members"]) => {
      const res = await as(role).get(
        apiPath(API_ROUTES.projectDispatchOptions, { projectId: project.id }),
      );
      expect(res.status).toBe(200);
      return expectContract(DispatchOptions, res.body);
    };

    it("彙整本人的 Local Runner 與 Team Runner 回報的 Agent，並帶 Project 的預設政策", async () => {
      await database.db
        .update(projects)
        .set({ defaultPermissionPolicy: "manual" })
        .where(eq(projects.id, project.id));
      expect(await optionsOf("member")).toEqual({
        local: null,
        team: null,
        defaultPermissionPolicy: "manual",
      });
      await h.pairRunner(team.members.member, "local", [
        { id: "claude-code", models: ["opus"], permissionGaps: [".claude/settings.json"] },
        { id: "codex", available: false },
      ]);
      // 別人的 Local Runner 不算在「我的電腦」。
      await h.pairRunner(team.members.admin, "local", [{ id: "gemini" }]);
      const first = await h.pairRunner(team.members.admin, "team", [
        { id: "claude-code", models: ["sonnet"] },
      ]);
      await h.pairRunner(team.members.owner, "team", [
        { id: "claude-code", models: ["opus"], permissionGaps: ["hooks"] },
      ]);
      expect(first.runnerId).toBeTruthy();

      const options = await optionsOf("member");
      expect(options.local).toEqual({
        online: true,
        agents: [
          {
            id: "claude-code",
            version: "1.0.0",
            available: true,
            unavailableReason: null,
            models: ["opus"],
            permissionGaps: [".claude/settings.json"],
          },
          {
            id: "codex",
            version: "1.0.0",
            available: false,
            unavailableReason: "未登入",
            models: [],
            permissionGaps: [],
          },
        ],
      });
      // 多台 Team Runner：models 與 permissionGaps 取聯集。
      expect(options.team?.agents).toEqual([
        {
          id: "claude-code",
          version: "1.0.0",
          available: true,
          unavailableReason: null,
          models: ["opus", "sonnet"],
          permissionGaps: ["hooks"],
        },
      ]);
    });

    it("Runner 暫停領取或離線時，online 為 false、Agent 不可用", async () => {
      const mine = await h.pairRunner(team.members.member, "local");
      mine.heartbeat({ accepting_dispatches: false });
      await waitUntil(() => !h.ctx.services.hub.isAcceptingDispatches(mine.runnerId));
      const paused = await optionsOf("member");
      expect(paused.local).toMatchObject({
        online: false,
        agents: [{ id: "claude-code", available: false }],
      });
      expect(paused.local?.agents[0]?.unavailableReason).not.toBeNull();
      mine.close();
      await mine.closed;
      await waitUntil(() => !h.ctx.services.hub.isOnline(mine.runnerId));
      expect((await optionsOf("member")).local).toMatchObject({ online: false });
    });

    it("依 Role 與 Project 政策：Viewer 都是 null；禁止 Member 派工到 Team Runner 時 Member 的 team 是 null", async () => {
      await h.pairRunner(team.members.admin, "team");
      expect(await optionsOf("viewer")).toMatchObject({ local: null, team: null });
      expect((await optionsOf("member")).team).not.toBeNull();
      await database.db
        .update(projects)
        .set({ allowMemberTeamRunnerDispatch: false })
        .where(eq(projects.id, project.id));
      expect((await optionsOf("member")).team).toBeNull();
      expect((await optionsOf("admin")).team).not.toBeNull();
    });

    it("撤銷的 Runner 不列入；其他 Team 的 Project 回 404", async () => {
      const mine = await h.pairRunner(team.members.member, "local");
      expect((await as("member").delete(`/api/runners/${mine.runnerId}`)).status).toBe(204);
      expect((await optionsOf("member")).local).toBeNull();
      const other = await seedTeam(database.db, "Other");
      const res = await client(h.ctx.app, other.members.owner.cookie).get(
        apiPath(API_ROUTES.projectDispatchOptions, { projectId: project.id }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("登出與 session 過期時撤銷 Local Runner", () => {
    it("登出：撤銷這個 session 配對的 Local Runner 並立刻斷線，其他 Runner 不受影響", async () => {
      const mine = await h.pairRunner(team.members.member, "local");
      // 同一個人在另一個 session（例如另一台電腦）配對的 Local Runner。
      const otherSession = await seedMember(database.db, team.teamId, "member");
      await database.db
        .update(sessions)
        .set({ githubUserId: team.members.member.githubUserId })
        .where(eq(sessions.githubUserId, otherSession.githubUserId));
      const elsewhere = await h.pairRunner(
        { ...team.members.member, cookie: otherSession.cookie },
        "local",
      );
      const teamRunner = await h.pairRunner(team.members.admin, "team");
      const unused = await as("member").post<{ id: string; token: string }>(
        "/api/runner-pairing-tokens",
        { kind: "local" },
      );

      expect((await as("member").post("/api/auth/logout")).status).toBe(204);
      expect(await mine.closed).toBe(CLOSE_REVOKED);
      const [row] = await database.db.select().from(runners).where(eq(runners.id, mine.runnerId));
      expect(row?.revokedAt).not.toBeNull();
      expect(h.ctx.services.hub.isOnline(elsewhere.runnerId)).toBe(true);
      expect(h.ctx.services.hub.isOnline(teamRunner.runnerId)).toBe(true);
      // 還沒使用的 Pairing token 也一併失效。
      const late = await h.connect();
      late.hello({ kind: "pairing_token", token: unused.body.token });
      expect(await late.next("hello_rejected")).toMatchObject({ reason: "invalid_pairing_token" });
      // 撤銷後 Runner token 不能再連線。
      const back = await h.connect();
      back.hello({ kind: "runner_token", runner_id: mine.runnerId, token: mine.runnerToken });
      expect(await back.next("hello_rejected")).toMatchObject({ reason: "invalid_runner_token" });
    });

    it("登出時 Runner 上進行中的 Run 回到佇列", async () => {
      const mine = await h.pairRunner(team.members.member, "local");
      const run = (await dispatch((await readyTask()).id)).body;
      await h.ctx.services.dispatcher.kick();
      const offer = await mine.next("dispatch_offer");
      mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await waitUntil(async () => (await runRow(run.id))?.status === "starting");
      await as("member").post("/api/auth/logout");
      expect(await mine.closed).toBe(CLOSE_REVOKED);
      expect((await runRow(run.id))?.status).toBe("queued");
    });

    it("清除過期 session 時，先撤銷它配對的 Local Runner 再刪除 session", async () => {
      const mine = await h.pairRunner(team.members.member, "local");
      const keep = await h.pairRunner(team.members.admin, "local");
      await database.db
        .update(sessions)
        .set({ expiresAt: new Date(h.ctx.clock.now().getTime() - 1) })
        .where(eq(sessions.githubUserId, team.members.member.githubUserId));
      expect(await h.ctx.services.sessionCleanup.runOnce()).toBe(1);
      expect(await mine.closed).toBe(CLOSE_REVOKED);
      const [row] = await database.db.select().from(runners).where(eq(runners.id, mine.runnerId));
      expect(row?.revokedAt).not.toBeNull();
      expect(
        await database.db
          .select()
          .from(sessions)
          .where(eq(sessions.githubUserId, team.members.member.githubUserId)),
      ).toHaveLength(0);
      expect(h.ctx.services.hub.isOnline(keep.runnerId)).toBe(true);
    });

    it("Desktop 以 session cookie 撤銷自己的 Local Runner", async () => {
      const mine = await h.pairRunner(team.members.member, "local");
      const res = await as("member").delete(
        apiPath(API_ROUTES.runner, { runnerId: mine.runnerId }),
      );
      expect(res.status).toBe(204);
      expect(await mine.closed).toBe(CLOSE_REVOKED);
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

    it("改派也遵守派工規則：Local Run 不會改派給在線的 Team Runner，也不派給暫停領取的 Runner", async () => {
      const { mine, run, offer } = await offered();
      const teamRunner = await h.pairRunner(team.members.admin, "team");
      mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await waitUntil(async () => (await runRow(run.id))?.status === "starting");

      h.ctx.clock.advance(3 * HEARTBEAT_INTERVAL_MS + 1);
      teamRunner.heartbeat();
      await waitUntil(async () => {
        const [row] = await database.db
          .select()
          .from(runners)
          .where(eq(runners.id, teamRunner.runnerId));
        return row?.lastHeartbeatAt?.getTime() === h.ctx.clock.now().getTime();
      });
      await h.ctx.services.dispatcher.kick();
      expect(await mine.closed).toBe(4002);
      expect((await runRow(run.id))?.status).toBe("queued");
      await h.ctx.services.dispatcher.kick();
      expect(teamRunner.pending("dispatch_offer")).toHaveLength(0);
      expect((await runRow(run.id))?.status).toBe("queued");

      // 負責的 Local Runner 回來但暫停領取時也不派；恢復後才派。
      const back = await h.reconnect(mine);
      back.heartbeat({ accepting_dispatches: false });
      await waitUntil(() => !h.ctx.services.hub.isAcceptingDispatches(back.runnerId));
      await h.ctx.services.dispatcher.kick();
      expect(back.pending("dispatch_offer")).toHaveLength(0);
      back.heartbeat({ accepting_dispatches: true });
      expect(await back.next("dispatch_offer")).toMatchObject({ run_id: run.id });
      expect(teamRunner.pending("dispatch_offer")).toHaveLength(0);
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
