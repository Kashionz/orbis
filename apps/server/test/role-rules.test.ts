// Role 的細部規則（ARCHITECTURE §8、§10、§12.2）：Project 可以設定「不能核准自己的 Task」、禁止 Member 派工到
// Team Runner、覆寫個別 Member 的 Role；這些規則在每個入口都生效（Gate、派工、@agent、Draft Task、共同編輯）。

import { formatMention, NeedsYouListResponse, NotificationListResponse } from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collabAccess } from "../src/collab/authz";
import { collabDocRef } from "../src/collab/doc-name";
import { draftTasks, needsYouItems, projectMemberRoles, runs } from "../src/db/schema";
import { resolveActor } from "../src/http/session";
import { expectContract, resetDatabase, seedReadyTask } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_REVIEW,
  type Flow,
  openGate,
  RUN_DIFF,
  startFlow,
  startRun,
} from "./helpers/flow";

describe.skipIf(dbSkipReason !== null)("Role 的細部規則", () => {
  let database: TestDatabase;
  let flow: Flow;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  afterEach(async () => {
    await flow.close();
  });

  const override = (memberId: string, role: "admin" | "member" | "viewer") =>
    database.db.insert(projectMemberRoles).values({ projectId: flow.project.id, memberId, role });

  describe("不能核准自己的 Task（Review Gate）", () => {
    beforeEach(async () => {
      await resetDatabase(database.db);
      flow = await startFlow(database.db, { forbidSelfApproval: true });
    });

    async function reviewGate(assigneeMemberId: string) {
      const started = await startRun(flow, {
        task: { assigneeMemberId },
        criteria: [{ kind: "command", description: "測試通過", command: "pnpm test" }],
      });
      await started.send(RUN_DIFF);
      await started.send(AWAITING_REVIEW);
      await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
      return { started, gate: await openGate(flow, started.task.id) };
    }

    const gateItems = async (role: "owner" | "admin" | "member" | "viewer") =>
      expectContract(NeedsYouListResponse, (await flow.as(role).get("/api/needs-you")).body).filter(
        (i) => i.kind === "gate",
      );

    it("負責人是 Member：Gate 不指派給特定的人，其他能核准的人都看得到並收到通知，負責人不能核准", async () => {
      const { member } = flow.team.members;
      const { gate } = await reviewGate(member.id);
      const [item] = await database.db
        .select()
        .from(needsYouItems)
        .where(eq(needsYouItems.gateId, gate.id));
      expect(item?.memberId).toBeNull();
      expect(await gateItems("member")).toEqual([]);
      expect(await gateItems("viewer")).toEqual([]);
      expect((await gateItems("admin")).map((i) => i.memberId)).toEqual([
        flow.team.members.admin.id,
      ]);
      expect((await gateItems("owner")).map((i) => i.memberId)).toEqual([
        flow.team.members.owner.id,
      ]);
      const notified = async (role: "owner" | "admin" | "member") =>
        expectContract(
          NotificationListResponse,
          (await flow.as(role).get("/api/notifications")).body,
        ).items.filter((n) => n.kind === "gate_pending").length;
      expect(await notified("admin")).toBe(1);
      expect(await notified("owner")).toBe(1);
      expect(await notified("member")).toBe(0);
      expect(
        (await flow.as("member").post(`/api/gates/${gate.id}/decision`, { action: "approve" }))
          .status,
      ).toBe(403);
      // 負責人仍可以退回自己的 Task。
      expect(
        (
          await flow.as("member").post(`/api/gates/${gate.id}/decision`, {
            action: "reject",
            comment: "我自己再改",
          })
        ).status,
      ).toBe(200);
    });

    it("Project 把負責人覆寫成 Admin 時不受限制，Gate 照常指派給本人", async () => {
      const { member } = flow.team.members;
      await override(member.id, "admin");
      const { gate } = await reviewGate(member.id);
      const [item] = await database.db
        .select()
        .from(needsYouItems)
        .where(eq(needsYouItems.gateId, gate.id));
      expect(item?.memberId).toBe(member.id);
    });

    it("Team 的 Admin 被 Project 覆寫成 Member 時，就不能核准自己的 Task", async () => {
      const { admin } = flow.team.members;
      await override(admin.id, "member");
      const { gate } = await reviewGate(admin.id);
      expect(
        (await flow.as("admin").post(`/api/gates/${gate.id}/decision`, { action: "approve" }))
          .status,
      ).toBe(403);
    });
  });

  describe("禁止 Member 派工到 Team Runner", () => {
    beforeEach(async () => {
      await resetDatabase(database.db);
      flow = await startFlow(database.db, { allowMemberTeamRunnerDispatch: false });
    });

    it("Member 派工到 Team Runner 被拒絕，Local Runner 照常；Admin 不受影響", async () => {
      const task = await seedReadyTask(database.db, flow.project, flow.repoId);
      const team = { agent: "claude-code", runnerKind: "team" };
      expect((await flow.as("member").post(`/api/tasks/${task.id}/runs`, team)).status).toBe(403);
      expect(
        (
          await flow
            .as("member")
            .post(`/api/tasks/${task.id}/runs`, { agent: "claude-code", runnerKind: "local" })
        ).status,
      ).toBe(201);
      const other = await seedReadyTask(database.db, flow.project, flow.repoId);
      expect((await flow.as("admin").post(`/api/tasks/${other.id}/runs`, team)).status).toBe(201);
    });

    it("@agent 要讀 Team Runner 上的 Worktree 時，Member 不能建立 consult Run", async () => {
      const runner = await flow.h.pairRunner(flow.team.members.admin, "team");
      const task = await seedReadyTask(database.db, flow.project, flow.repoId);
      const res = await flow
        .as("admin")
        .post<{ id: string }>(`/api/tasks/${task.id}/runs`, {
          agent: "claude-code",
          runnerKind: "team",
        });
      await flow.h.ctx.services.dispatcher.kick();
      const offer = await runner.next("dispatch_offer", (o) => o.run_id === res.body.id);
      runner.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await runner.eventAcked(offer.dispatch_id, res.body.id, {
        kind: "worktree_ready",
        worktree_path: "/w/ORB-1-1",
        branch: offer.branch,
        base_commit: "a".repeat(40),
      });
      const agent = formatMention("claude", { type: "agent", agent: "claude-code" });
      const comment = await flow
        .as("member")
        .post<{ consultRunIds: string[] }>(`/api/tasks/${task.id}/comments`, {
          body: `${agent} 看一下`,
        });
      expect(comment.body.consultRunIds).toEqual([]);
      expect(await database.db.select().from(runs).where(eq(runs.origin, "mention"))).toEqual([]);
    });
  });

  describe("覆寫個別 Member 的 Role", () => {
    beforeEach(async () => {
      await resetDatabase(database.db);
      flow = await startFlow(database.db);
    });

    it("覆寫成 Viewer：不能編輯 Task、派工、確認 Draft Task，共同編輯只能讀", async () => {
      const { member } = flow.team.members;
      await override(member.id, "viewer");
      const task = await seedReadyTask(database.db, flow.project, flow.repoId);
      expect((await flow.as("member").patch(`/api/tasks/${task.id}`, { title: "x" })).status).toBe(
        403,
      );
      expect(
        (
          await flow
            .as("member")
            .post(`/api/tasks/${task.id}/runs`, { agent: "claude-code", runnerKind: "local" })
        ).status,
      ).toBe(403);
      const [draft] = await database.db
        .insert(draftTasks)
        .values({ projectId: flow.project.id, title: "Draft" })
        .returning();
      expect((await flow.as("member").post(`/api/draft-tasks/${draft?.id}/confirm`)).status).toBe(
        403,
      );
      const actor = await resolveActor(database.db, flow.h.ctx.clock, member.cookie.split("=")[1]);
      expect(
        await collabAccess(database.db, actor, collabDocRef("task-description", task.id)),
      ).toBe("read");
    });

    it("覆寫成 Admin：可以修改 Project 的政策", async () => {
      const { member } = flow.team.members;
      expect(
        (
          await flow.as("member").patch(`/api/projects/${flow.project.id}`, {
            policy: { forbidSelfApproval: true },
          })
        ).status,
      ).toBe(403);
      await override(member.id, "admin");
      expect(
        (
          await flow.as("member").patch(`/api/projects/${flow.project.id}`, {
            policy: { forbidSelfApproval: true },
          })
        ).status,
      ).toBe(200);
    });

    it("不能覆寫成 Owner", async () => {
      const res = await flow
        .as("owner")
        .put(`/api/projects/${flow.project.id}/roles/${flow.team.members.member.id}`, {
          role: "owner",
        });
      expect(res.status).toBe(400);
    });
  });
});
