// Draft Task 與 Task note（ARCHITECTURE §9）：`propose_tasks` 建立的 Draft Task 經人確認才進入 Backlog；
// `update_task_note` 的紀錄保存並帶來源 Run；Agent 不能修改 Task 的狀態、指派對象與 Acceptance Criterion。

import { DraftTaskListResponse, Task, TaskNoteListResponse } from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acceptanceCriteria,
  draftTasks,
  taskDependencies,
  taskNotes,
  tasks,
} from "../src/db/schema";
import { expectContract, resetDatabase, seedReadyTask } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import { type Flow, type StartedRun, startFlow, startRun, taskRow } from "./helpers/flow";

describe.skipIf(dbSkipReason !== null)("Draft Task 與 Task note", () => {
  let database: TestDatabase;
  let flow: Flow;
  let started: StartedRun;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    flow = await startFlow(database.db);
    started = await startRun(flow);
  });

  afterEach(async () => {
    await flow.close();
  });

  const call = (body: Record<string, unknown>, callId?: string) =>
    started.mine.toolCall(started.offer.dispatch_id, started.run.id, body, callId);

  const PROPOSAL = {
    tool: "propose_tasks",
    spec: "docs/specs/login.md",
    tasks: [
      {
        title: "登入 API",
        description: "POST /login",
        acceptance_criteria: [
          { kind: "command", description: "API 測試通過", command: "pnpm test" },
        ],
        depends_on: [],
      },
      {
        title: "登入頁",
        description: "表單與錯誤訊息",
        acceptance_criteria: [{ kind: "manual", description: "畫面正確", command: null }],
        depends_on: ["#1"],
      },
    ],
  };

  const drafts = async () =>
    expectContract(
      DraftTaskListResponse,
      (await flow.as("viewer").get(`/api/projects/${flow.project.id}/draft-tasks`)).body,
    );

  describe("propose_tasks", () => {
    it("建立一批 Draft Task（記下提出的 Run），不佔 Task Key，也不會出現在 Task 清單", async () => {
      const before = await database.db.select().from(tasks);
      const { result } = await call(PROPOSAL);
      expect(result).toMatchObject({ outcome: "ok", output: { tool: "propose_tasks" } });
      const list = await drafts();
      expect(list).toMatchObject([
        { title: "登入 API", position: 1, dependsOn: [], proposedByRunId: started.run.id },
        { title: "登入頁", position: 2, dependsOn: ["#1"], spec: "docs/specs/login.md" },
      ]);
      expect(list[0]?.batchId).toBe(list[1]?.batchId);
      expect(list[0]?.repoId).toBe(flow.repoId);
      expect(await database.db.select().from(tasks)).toHaveLength(before.length);
    });

    it("依賴格式不對或指向不存在的 #<n> 時回錯誤，不建立任何 Draft Task", async () => {
      const bad = {
        ...PROPOSAL,
        tasks: PROPOSAL.tasks.map((t, i) => (i === 1 ? { ...t, depends_on: ["#5"] } : t)),
      };
      const { result } = await call(bad);
      expect(result).toMatchObject({ outcome: "error", code: "invalid_state" });
      expect(await drafts()).toEqual([]);
    });

    it("同一個 call_id 重送時回同樣的結果，不會建立兩批", async () => {
      const first = await call(PROPOSAL);
      const again = await call(PROPOSAL, first.callId);
      expect(again.result).toEqual(first.result);
      expect(await drafts()).toHaveLength(2);
    });
  });

  describe("確認與捨棄", () => {
    it("確認一筆：建立 Backlog 的 Task（含 Acceptance Criterion），發出 task.created", async () => {
      const created: string[] = [];
      flow.h.ctx.services.events.subscribe((event) => {
        if (event.type === "task.created") created.push(event.taskId);
      });
      await call(PROPOSAL);
      const [api] = await drafts();
      const res = await flow.as("member").post(`/api/draft-tasks/${api?.id}/confirm`);
      expect(res.status).toBe(201);
      const task = expectContract(Task, res.body);
      expect(task).toMatchObject({ status: "backlog", title: "登入 API" });
      expect(created).toEqual([task.id]);
      const criteria = await database.db
        .select()
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.taskId, task.id));
      expect(criteria).toMatchObject([{ kind: "command", command: "pnpm test" }]);
      // 同一批的 #1 改寫成新的 Task Key。
      const [page] = await drafts();
      expect(page).toMatchObject({ title: "登入頁", dependsOn: [task.key] });
    });

    it("依賴的 Draft Task 還沒確認時回 409；批次確認依相依順序建立", async () => {
      await call(PROPOSAL);
      const [api, page] = await drafts();
      expect((await flow.as("member").post(`/api/draft-tasks/${page?.id}/confirm`)).status).toBe(
        409,
      );
      const res = await flow
        .as("member")
        .post(`/api/projects/${flow.project.id}/draft-tasks/confirm`, {
          draftTaskIds: [page?.id, api?.id],
        });
      expect(res.status).toBe(201);
      const body = res.body as { draftTaskId: string; task: { id: string; key: string } }[];
      expect(body.map((b) => b.draftTaskId)).toEqual([page?.id, api?.id]);
      const pageTask = body[0]?.task;
      const apiTask = body[1]?.task;
      const deps = await database.db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, pageTask?.id ?? ""));
      expect(deps).toMatchObject([{ dependsOnTaskId: apiTask?.id }]);
      expect(await drafts()).toEqual([]);
    });

    it("捨棄：從清單移除，同一批中指向它的依賴一併移除", async () => {
      await call(PROPOSAL);
      const [api] = await drafts();
      expect((await flow.as("member").post(`/api/draft-tasks/${api?.id}/dismiss`)).status).toBe(
        204,
      );
      expect(await drafts()).toMatchObject([{ title: "登入頁", dependsOn: [] }]);
    });

    it("修改 Draft Task 後再確認", async () => {
      await call(PROPOSAL);
      const [api] = await drafts();
      const patched = await flow.as("member").patch(`/api/draft-tasks/${api?.id}`, {
        title: "登入 API（v2）",
        acceptanceCriteria: [{ kind: "agent", description: "回應格式正確", command: null }],
      });
      expect(patched.status).toBe(200);
      const res = await flow.as("member").post(`/api/draft-tasks/${api?.id}/confirm`);
      expect(expectContract(Task, res.body).title).toBe("登入 API（v2）");
    });

    it("Viewer 不能確認、捨棄或修改；別的 Team 看不到", async () => {
      await call(PROPOSAL);
      const [api] = await drafts();
      expect((await flow.as("viewer").post(`/api/draft-tasks/${api?.id}/confirm`)).status).toBe(
        403,
      );
      expect((await flow.as("viewer").post(`/api/draft-tasks/${api?.id}/dismiss`)).status).toBe(
        403,
      );
      expect(
        (await flow.as("viewer").patch(`/api/draft-tasks/${api?.id}`, { title: "x" })).status,
      ).toBe(403);
    });
  });

  describe("update_task_note", () => {
    it("在自己的 Task 上留下紀錄，帶來源 Run", async () => {
      const { result } = await call({ tool: "update_task_note", task: null, note: "決定用 JWT" });
      expect(result).toMatchObject({ outcome: "ok", output: { tool: "update_task_note" } });
      const notes = expectContract(
        TaskNoteListResponse,
        (await flow.as("viewer").get(`/api/tasks/${started.task.id}/notes`)).body,
      );
      expect(notes).toMatchObject([
        { body: "決定用 JWT", runId: started.run.id, source: "agent", url: null },
      ]);
    });

    it("可以指定同一個 Project 的其他 Task；別的 Project 的 Task 回 not_found", async () => {
      const { result } = await call({ tool: "update_task_note", task: "XYZ-1", note: "x" });
      expect(result).toMatchObject({ outcome: "error", code: "not_found" });
    });

    it("其他 Task 依派工的人在上面的權限：看不到和不存在一樣回 not_found，只能檢視時不能寫", async () => {
      const other = await seedReadyTask(flow.db, flow.project, flow.repoId, {
        createdByMemberId: flow.team.members.admin.id,
      });
      const setAccess = (generalAccess: "invited" | "team_view" | "team_edit") =>
        flow.db.update(tasks).set({ generalAccess }).where(eq(tasks.id, other.id));
      const write = () => call({ tool: "update_task_note", task: other.key, note: "x" });

      await setAccess("invited");
      const hidden = (await write()).result;
      const missing = (await call({ tool: "update_task_note", task: "ORB-999", note: "x" })).result;
      expect(hidden).toMatchObject({ outcome: "error", code: "not_found" });
      expect(missing).toMatchObject({ outcome: "error", code: "not_found" });
      expect((hidden as { message: string }).message).toBe(
        (missing as { message: string }).message.replace("ORB-999", other.key),
      );

      await setAccess("team_view");
      expect((await write()).result).toMatchObject({ outcome: "error", code: "invalid_state" });

      await setAccess("team_edit");
      expect((await write()).result).toMatchObject({ outcome: "ok" });
      const notes = await flow.db.select().from(taskNotes).where(eq(taskNotes.taskId, other.id));
      expect(notes).toHaveLength(1);
    });
  });

  describe("Agent 不能修改 Task 的狀態、指派對象與 Acceptance Criterion", () => {
    it("Server 不提供修改 Task 的工具：不認得的工具一律回 invalid_state，Task 不變", async () => {
      const before = await taskRow(database.db, started.task.id);
      for (const tool of [
        "update_task",
        "set_status",
        "assign_task",
        "update_acceptance_criteria",
      ]) {
        const { result } = await call({
          tool,
          task: started.task.key,
          status: "done",
          assignee: flow.team.members.owner.id,
        });
        expect(result).toMatchObject({ outcome: "error", code: "invalid_state" });
      }
      const after = await taskRow(database.db, started.task.id);
      expect(after.status).toBe(before.status);
      expect(after.assigneeMemberId).toBe(before.assigneeMemberId);
    });

    it("propose_tasks 與 update_task_note 帶額外的欄位也不會改到既有的 Task 與條件", async () => {
      const before = await taskRow(database.db, started.task.id);
      const criteriaBefore = await database.db
        .select()
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.taskId, started.task.id));
      await call({
        ...PROPOSAL,
        task: started.task.key,
        status: "done",
        tasks: PROPOSAL.tasks.map((t) => ({ ...t, id: started.task.id, status: "done" })),
      });
      await call({
        tool: "update_task_note",
        task: null,
        note: "x",
        status: "done",
        assignee_member_id: flow.team.members.owner.id,
        acceptance_criteria: [],
      });
      const after = await taskRow(database.db, started.task.id);
      expect(after).toMatchObject({
        status: before.status,
        assigneeMemberId: before.assigneeMemberId,
        title: before.title,
        description: before.description,
      });
      const criteriaAfter = await database.db
        .select()
        .from(acceptanceCriteria)
        .where(eq(acceptanceCriteria.taskId, started.task.id));
      expect(criteriaAfter).toEqual(criteriaBefore);
      expect(await database.db.select().from(draftTasks)).toHaveLength(2);
    });

    it("Runner token 不能呼叫 Web API", async () => {
      const res = await flow.h.ctx.app.request(`/api/tasks/${started.task.id}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${started.mine.runnerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ assigneeMemberId: flow.team.members.owner.id }),
      });
      expect(res.status).toBe(401);
      const transition = await flow.h.ctx.app.request(`/api/tasks/${started.task.id}/transition`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${started.mine.runnerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "backlog" }),
      });
      expect(transition.status).toBe(401);
    });

    it("不是 Run 目前 Dispatch 的工具呼叫一律拒絕", async () => {
      const { result } = await started.mine.toolCall(crypto.randomUUID(), started.run.id, {
        tool: "update_task_note",
        task: null,
        note: "x",
      });
      expect(result).toMatchObject({ outcome: "error", code: "invalid_state" });
    });
  });
});
