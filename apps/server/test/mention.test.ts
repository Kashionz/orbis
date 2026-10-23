// @mention（ARCHITECTURE §12.3）：解析 Task 留言、Spec、diff 行內留言中的 @member 與 @agent。

import { randomUUID } from "node:crypto";
import {
  COLLAB_FRAGMENT,
  formatMention,
  MentionCandidates,
  MentionListResponse,
  NotificationListResponse,
  type Role,
  TaskComment,
  TaskCommentListResponse,
} from "@orbis/api-contract";
import type { EventKind } from "@orbis/protocol";
import { eq } from "drizzle-orm";
import * as encoding from "lib0/encoding";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { collabDocRef } from "../src/collab/doc-name";
import { runs } from "../src/db/schema";
import { GitHubDomainService } from "../src/domain/github-domain";
import {
  createTestContext,
  expectContract,
  resetDatabase,
  seedProject,
  seedReadyTask,
  seedTeam,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_REVIEW,
  type Flow,
  openGate,
  RUN_DIFF,
  RUNNING,
  runRow,
  startFlow,
  startRun,
  taskRow,
} from "./helpers/flow";
import { waitUntil } from "./helpers/runner-harness";

describe.skipIf(dbSkipReason !== null)("同步到 GitHub Issue 時的 mention", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("Member 換成 @login；Agent、別的 Team 的 Member 只留顯示名稱", async () => {
    const team = await seedTeam(database.db);
    const other = await seedTeam(database.db, "Other");
    const { project, repo } = await seedProject(database.db, team.teamId);
    const member = team.members.member;
    const task = await seedReadyTask(database.db, project, repo.id, {
      description: `請 @[小明](member:${member.id.toUpperCase()}) 看，@[claude](agent:claude-code)、@[外人](member:${other.members.owner.id}) 與 @[壞的](member:not-a-uuid)`,
    });
    const ctx = createTestContext(database.db);
    const domain = new GitHubDomainService(database.db, ctx.services.lifecycle);
    const record = await domain.getTask(task.id);
    expect(record?.description).toBe(`請 @user${member.githubUserId} 看，claude、外人 與 壞的`);
  });
});

describe.skipIf(dbSkipReason !== null)("@mention 與 Task 留言", () => {
  let database: TestDatabase;
  let flow: Flow;
  let task: Awaited<ReturnType<typeof seedReadyTask>>;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    flow = await startFlow(database.db);
    task = await seedReadyTask(database.db, flow.project, flow.repoId);
  });

  afterEach(async () => {
    await flow.close();
  });

  const member = (role: Role) => flow.team.members[role];
  const token = (role: Role, label = role) =>
    formatMention(label, { type: "member", memberId: member(role).id });
  const AGENT = formatMention("claude", { type: "agent", agent: "claude-code" });

  const comment = async (role: Role, body: string) => {
    const res = await flow.as(role).post(`/api/tasks/${task.id}/comments`, { body });
    expect(res.status).toBe(201);
    return expectContract(TaskComment, res.body);
  };
  const notificationsOf = async (role: Role) =>
    expectContract(NotificationListResponse, (await flow.as(role).get("/api/notifications")).body)
      .items;
  const mentionRuns = () => database.db.select().from(runs).where(eq(runs.origin, "mention"));

  describe("Task 留言", () => {
    it("Viewer 也能留言；只能修改或刪除自己的留言", async () => {
      const created = await comment("viewer", "看起來不錯");
      const list = expectContract(
        TaskCommentListResponse,
        (await flow.as("member").get(`/api/tasks/${task.id}/comments`)).body,
      );
      expect(list).toMatchObject([{ body: "看起來不錯", authorMemberId: member("viewer").id }]);
      const path = `/api/task-comments/${created.id}`;
      expect((await flow.as("member").patch(path, { body: "x" })).status).toBe(403);
      expect((await flow.as("member").delete(path)).status).toBe(403);
      expect((await flow.as("viewer").patch(path, { body: "改過" })).status).toBe(200);
      expect((await flow.as("viewer").delete(path)).status).toBe(204);
    });
  });

  describe("@member", () => {
    it("通知被提及的人；修改留言時只有新出現的 mention 才通知", async () => {
      const created = await comment("member", `請 ${token("admin")} 看一下`);
      expect(await notificationsOf("admin")).toMatchObject([
        { kind: "mentioned", taskKey: task.key, actorMemberId: member("member").id },
      ]);
      await flow.as("member").patch(`/api/task-comments/${created.id}`, {
        body: `請 ${token("admin")} 與 ${token("owner")} 看一下`,
      });
      expect(await notificationsOf("admin")).toHaveLength(1);
      expect(await notificationsOf("owner")).toMatchObject([{ kind: "mentioned" }]);
    });

    it("提及自己、別的 Team 的人、或寫在程式碼中的 token 都不通知", async () => {
      const other = await seedTeam(database.db, "Other");
      const outsider = formatMention("x", { type: "member", memberId: other.members.owner.id });
      await comment("member", `${token("member")} ${outsider} \`${token("admin")}\``);
      expect(await notificationsOf("member")).toEqual([]);
      expect(await notificationsOf("admin")).toEqual([]);
      const mentions = expectContract(
        MentionListResponse,
        (await flow.as("viewer").get(`/api/tasks/${task.id}/mentions`)).body,
      );
      expect(mentions.map((m) => m.target)).toEqual([
        { type: "member", memberId: member("member").id },
      ]);
    });
  });

  describe("@agent", () => {
    it("建立 consult Run，派到留言者自己的 Local Runner，prompt 帶入留言與 Task", async () => {
      const runner = await flow.h.pairRunner(member("member"), "local");
      const created = await comment("member", `${AGENT} 幫我看這段`);
      const [run] = await mentionRuns();
      expect(created.consultRunIds).toEqual([run?.id]);
      expect(run).toMatchObject({
        delegationMode: "consult",
        parentRunId: null,
        agent: "claude-code",
        target: "local",
        requestedByMemberId: member("member").id,
        consultOfRunId: null,
      });
      await flow.h.ctx.services.dispatcher.kick();
      const offer = await runner.next("dispatch_offer", (o) => o.run_id === run?.id);
      expect(offer.origin).toBe("mention");
      expect(offer.plan_gate).toBe(false);
      expect(JSON.stringify(offer.prompt)).toContain("幫我看這段");
      expect(JSON.stringify(offer.prompt)).toContain(task.title);
      // consult Run 不會改變 Task 的狀態。
      expect((await taskRow(database.db, task.id)).status).toBe("ready");
    });

    it("Task 有保留 Worktree 的主 Run 在留言者自己的 Runner 上時，唯讀讀那個 Worktree", async () => {
      const started = await startRun(flow, {});
      await started.send({
        kind: "worktree_ready",
        worktree_path: "C:/w/ORB-2-1",
        branch: started.run.branch,
        base_commit: "a".repeat(40),
      });
      const res = await flow.as("member").post(`/api/tasks/${started.task.id}/comments`, {
        body: `${AGENT} 這段可以嗎`,
      });
      const consult = expectContract(TaskComment, res.body).consultRunIds[0];
      expect((await runRow(database.db, consult ?? ""))?.consultOfRunId).toBe(started.run.id);
      await flow.h.ctx.services.dispatcher.kick();
      const offer = await started.mine.next("dispatch_offer", (o) => o.run_id === consult);
      expect(offer.consult_of_run_id).toBe(started.run.id);
    });

    it("那個 Worktree 在別人的 Local Runner 上時不沿用，改派到留言者自己的 Local Runner", async () => {
      const started = await startRun(flow, {});
      await started.send({
        kind: "worktree_ready",
        worktree_path: "C:/w/ORB-2-1",
        branch: started.run.branch,
        base_commit: "a".repeat(40),
      });
      const res = await flow.as("admin").post(`/api/tasks/${started.task.id}/comments`, {
        body: `${AGENT} 這段可以嗎`,
      });
      const consult = expectContract(TaskComment, res.body).consultRunIds[0];
      expect(await runRow(database.db, consult ?? "")).toMatchObject({
        consultOfRunId: null,
        requestedByMemberId: member("admin").id,
      });
    });

    it("Viewer 的 @agent 只記錄，不建立 Run", async () => {
      const created = await comment("viewer", `${AGENT} 幫我看`);
      expect(created.consultRunIds).toEqual([]);
      expect(await mentionRuns()).toEqual([]);
    });

    it("consult Run 結束後，Agent 最後的回覆貼回成 Task 留言（作者是那個 Run）", async () => {
      const runner = await flow.h.pairRunner(member("member"), "local");
      await comment("member", `${AGENT} 幫我看這段`);
      const [run] = await mentionRuns();
      await flow.h.ctx.services.dispatcher.kick();
      const offer = await runner.next("dispatch_offer", (o) => o.run_id === run?.id);
      runner.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await waitUntil(
        async () => (await runRow(database.db, run?.id ?? ""))?.status === "starting",
      );
      const send = (kind: EventKind) => runner.eventAcked(offer.dispatch_id, run?.id ?? "", kind);
      await send(RUNNING);
      await send({ kind: "final_message", text: { type: "inline", text: "這段沒問題。" } });
      await send({ kind: "status_changed", status: "completed", gate: null, message: null });
      const list = expectContract(
        TaskCommentListResponse,
        (await flow.as("viewer").get(`/api/tasks/${task.id}/comments`)).body,
      );
      expect(list.at(-1)).toMatchObject({
        body: "這段沒問題。",
        authorRunId: run?.id,
        authorMemberId: null,
      });
    });

    it("diff 行內留言的 @agent 讀被 review 的 Run 的 Worktree，prompt 帶檔案與行號", async () => {
      const started = await startRun(flow, {
        criteria: [{ kind: "manual", description: "看過" }],
      });
      await started.send(RUN_DIFF);
      await started.send(AWAITING_REVIEW);
      const gate = await openGate(flow, started.task.id);
      await flow.as("member").post(`/api/gates/${gate.id}/decision`, {
        action: "reject",
        reviewComments: [
          { path: "src/login.ts", line: 3, side: "new", body: `${AGENT} 這裡安全嗎` },
        ],
      });
      const [run] = await mentionRuns();
      expect(run).toMatchObject({ consultOfRunId: started.run.id });
      expect(JSON.stringify(run?.prompt)).toContain("src/login.ts:3");
    });
  });

  describe("共同編輯文件中的 mention", () => {
    it("存檔時處理新出現的 mention 節點（以 nodeId 去重），作者是加入節點的人", async () => {
      const hub = flow.h.ctx.services.collab;
      const ref = collabDocRef("task-description", task.id);
      const room = await hub.open(ref);
      const peer = { memberId: member("member").id, writable: true, send: () => {} };
      room.reserve();
      room.join(peer);
      // 模擬 client 加入一個 mention 節點。
      const client = new Y.Doc();
      Y.applyUpdate(client, Y.encodeStateAsUpdate(room.doc));
      const paragraph = new Y.XmlElement("paragraph");
      client.getXmlFragment(COLLAB_FRAGMENT).insert(0, [paragraph]);
      const mention = new Y.XmlElement("mention");
      paragraph.insert(0, [mention]);
      mention.setAttribute("id", `member:${member("admin").id}`);
      mention.setAttribute("label", "admin");
      mention.setAttribute("nodeId", randomUUID());
      const update = Y.encodeStateAsUpdate(client, Y.encodeStateVector(room.doc));
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      encoding.writeVarUint(encoder, 2);
      encoding.writeVarUint8Array(encoder, update);
      room.receive(peer, encoding.toUint8Array(encoder));
      await room.flush();
      expect(await notificationsOf("admin")).toMatchObject([
        { kind: "mentioned", actorMemberId: member("member").id },
      ]);
      // 再存一次不重複通知。
      room.replaceMarkdown(`${room.markdown()}\n\n多一段`);
      await room.flush();
      expect(await notificationsOf("admin")).toHaveLength(1);
      room.leave(peer);
      await hub.release(room);
    });
  });

  it("自動完成的候選：Team 的成員與目前有 Runner 能跑的 Agent", async () => {
    await flow.h.pairRunner(member("member"), "local", [{ id: "claude-code" }, { id: "codex" }]);
    const candidates = expectContract(
      MentionCandidates,
      (await flow.as("viewer").get(`/api/projects/${flow.project.id}/mention-candidates`)).body,
    );
    expect(candidates.members).toHaveLength(4);
    expect(candidates.agents).toEqual([
      { agent: "claude-code", label: "claude" },
      { agent: "codex", label: "codex" },
    ]);
  });
});
