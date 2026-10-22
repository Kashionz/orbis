// PM API：Team、Member、Project、Role 覆寫、Repo、Task、相依、Acceptance Criterion。
// 每個成功的回應都用契約（packages/api-contract，或尚未進契約的暫時 schema）驗證。

import { AcceptanceCriterion, Project, Repo, Task } from "@orbis/api-contract";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Member, ProjectMemberRole, ProjectPolicy, Team } from "../src/contract-pending";
import { sessions } from "../src/db/schema";
import { RepoRegistrationError } from "../src/github/integration";
import {
  client,
  createTestContext,
  expectContract,
  resetDatabase,
  type SeededTeam,
  seedMember,
  seedTeam,
  type TestContext,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

// TODO(contract): Project 的 policy 加上 defaultPermissionPolicy 後改用契約的 Project。
const ProjectWithPolicy = Project.extend({ policy: ProjectPolicy });

describe.skipIf(dbSkipReason !== null)("PM API", () => {
  let database: TestDatabase;
  let ctx: TestContext;
  let team: SeededTeam;
  let rejectRepo: string | null;

  const as = (role: keyof SeededTeam["members"]) => client(ctx.app, team.members[role].cookie);

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    rejectRepo = null;
    ctx = createTestContext(database.db, {
      repoRegistrar: {
        register: async (input) => {
          if (`${input.owner}/${input.name}` === rejectRepo) {
            throw new RepoRegistrationError("GitHub App 沒有安裝在這個 Repo");
          }
          return { ...input, githubRepoId: 42 };
        },
      },
    });
    team = await seedTeam(database.db);
  });

  async function createProject(prefix = "ORB") {
    const res = await as("admin").post("/api/projects", { name: "Orbis", keyPrefix: prefix });
    expect(res.status).toBe(201);
    return expectContract(ProjectWithPolicy, res.body);
  }

  async function createRepo(projectId: string, name = "orbis") {
    const res = await as("admin").post(`/api/projects/${projectId}/repos`, {
      owner: "acme",
      name,
      defaultBranch: "main",
    });
    expect(res.status).toBe(201);
    return expectContract(Repo, res.body);
  }

  async function createTask(
    projectId: string,
    repoId: string,
    extra: Record<string, unknown> = {},
  ) {
    const res = await as("member").post(`/api/projects/${projectId}/tasks`, {
      repoId,
      title: "新增登入頁",
      description: "用 GitHub 登入",
      ...extra,
    });
    expect(res.status).toBe(201);
    return expectContract(Task, res.body);
  }

  describe("登入檢查", () => {
    it("沒有 session 時回 401", async () => {
      const res = await client(ctx.app, null).get("/api/team");
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "unauthorized" });
    });

    it("登入了但不是任何 Team 的 Member 時回 403 no_team", async () => {
      const member = await seedMember(database.db, team.teamId, "member");
      await database.db.execute(
        sql`update ${sessions} set current_team_id = null where github_user_id = ${member.githubUserId}`,
      );
      const res = await client(ctx.app, member.cookie).get("/api/team");
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "no_team" });
    });
  });

  describe("Team 與 Member", () => {
    it("Viewer 可以讀取 Team 與 Member 清單", async () => {
      const teamRes = await as("viewer").get("/api/team");
      expect(teamRes.status).toBe(200);
      expectContract(Team, teamRes.body);
      const list = await as("viewer").get("/api/members");
      expect(list.status).toBe(200);
      expect(expectContract(z.array(Member), list.body)).toHaveLength(4);
    });

    it("Admin 可以改 Team 名稱，Member 不行", async () => {
      expect((await as("member").patch("/api/team", { name: "X" })).status).toBe(403);
      const res = await as("admin").patch("/api/team", { name: "核心小組" });
      expect(res.status).toBe(200);
      expect(expectContract(Team, res.body).name).toBe("核心小組");
    });

    it("Admin 以 GitHub login 新增 Member", async () => {
      ctx.githubUsers.add({ id: 77, login: "Newbie", name: "New", avatarUrl: null });
      const res = await as("admin").post("/api/members", { githubLogin: "newbie", role: "member" });
      expect(res.status).toBe(201);
      expect(expectContract(Member, res.body)).toMatchObject({
        githubUserId: 77,
        githubLogin: "Newbie",
        role: "member",
      });
      const again = await as("admin").post("/api/members", { githubLogin: "newbie" });
      expect(again.status).toBe(409);
    });

    it("找不到 GitHub 使用者時回 404", async () => {
      const res = await as("admin").post("/api/members", { githubLogin: "ghost" });
      expect(res.status).toBe(404);
    });

    it("Member 不能新增 Member", async () => {
      ctx.githubUsers.add({ id: 78, login: "x", name: null, avatarUrl: null });
      expect((await as("member").post("/api/members", { githubLogin: "x" })).status).toBe(403);
    });

    it("只有 Owner 能指派 Owner", async () => {
      ctx.githubUsers.add({ id: 79, login: "boss", name: null, avatarUrl: null });
      expect(
        (await as("admin").post("/api/members", { githubLogin: "boss", role: "owner" })).status,
      ).toBe(403);
      expect(
        (await as("owner").post("/api/members", { githubLogin: "boss", role: "owner" })).status,
      ).toBe(201);
    });

    it("Admin 不能變更或移除 Owner", async () => {
      const ownerId = team.members.owner.id;
      expect((await as("admin").patch(`/api/members/${ownerId}`, { role: "member" })).status).toBe(
        403,
      );
      expect((await as("admin").delete(`/api/members/${ownerId}`)).status).toBe(403);
    });

    it("Admin 可以變更 Member 的 Role", async () => {
      const res = await as("admin").patch(`/api/members/${team.members.viewer.id}`, {
        role: "member",
      });
      expect(res.status).toBe(200);
      expect(expectContract(Member, res.body).role).toBe("member");
    });

    it("不能降級或移除最後一位 Owner", async () => {
      const ownerId = team.members.owner.id;
      expect((await as("owner").patch(`/api/members/${ownerId}`, { role: "admin" })).status).toBe(
        409,
      );
      expect((await as("owner").delete(`/api/members/${ownerId}`)).status).toBe(409);
    });

    it("有兩位 Owner 時可以降級其中一位", async () => {
      const second = await seedMember(database.db, team.teamId, "owner");
      const res = await as("owner").patch(`/api/members/${second.id}`, { role: "admin" });
      expect(res.status).toBe(200);
    });

    it("Admin 可以移除 Member", async () => {
      expect((await as("admin").delete(`/api/members/${team.members.viewer.id}`)).status).toBe(204);
      const list = await as("admin").get<unknown[]>("/api/members");
      expect(list.body).toHaveLength(3);
    });
  });

  describe("Project", () => {
    it("Admin 建立 Project，回應符合契約", async () => {
      const project = await createProject();
      expect(project).toMatchObject({
        keyPrefix: "ORB",
        teamId: team.teamId,
        policy: { planGateEnabled: true, defaultPermissionPolicy: "auto" },
      });
    });

    it("Member 不能建立 Project", async () => {
      const res = await as("member").post("/api/projects", { name: "X", keyPrefix: "XX" });
      expect(res.status).toBe(403);
    });

    it("Task Key 前綴在 Team 內不能重複，格式錯誤回 400", async () => {
      await createProject("ORB");
      expect(
        (await as("admin").post("/api/projects", { name: "Y", keyPrefix: "ORB" })).status,
      ).toBe(409);
      expect((await as("admin").post("/api/projects", { name: "Y", keyPrefix: "o" })).status).toBe(
        400,
      );
    });

    it("修改政策與預設 Permission Policy", async () => {
      const project = await createProject();
      const res = await as("admin").patch(`/api/projects/${project.id}`, {
        policy: { forbidSelfApproval: true, defaultPermissionPolicy: "manual" },
      });
      expect(res.status).toBe(200);
      expect(expectContract(ProjectWithPolicy, res.body).policy).toMatchObject({
        forbidSelfApproval: true,
        defaultPermissionPolicy: "manual",
      });
    });

    it("Viewer 可以讀取，不能修改或刪除", async () => {
      const project = await createProject();
      expect((await as("viewer").get(`/api/projects/${project.id}`)).status).toBe(200);
      expect(
        expectContract(z.array(ProjectWithPolicy), (await as("viewer").get("/api/projects")).body),
      ).toHaveLength(1);
      expect((await as("viewer").patch(`/api/projects/${project.id}`, { name: "Z" })).status).toBe(
        403,
      );
      expect((await as("viewer").delete(`/api/projects/${project.id}`)).status).toBe(403);
    });

    it("Admin 可以刪除 Project", async () => {
      const project = await createProject();
      expect((await as("admin").delete(`/api/projects/${project.id}`)).status).toBe(204);
      expect((await as("admin").get(`/api/projects/${project.id}`)).status).toBe(404);
    });

    it("其他 Team 的 Project 一律當作找不到", async () => {
      const project = await createProject();
      const other = await seedTeam(database.db, "Other");
      const res = await client(ctx.app, other.members.owner.cookie).get(
        `/api/projects/${project.id}`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("Project 的 Role 覆寫", () => {
    it("把 Viewer 升成 Member 後就能在這個 Project 建立 Task", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const body = { repoId: repo.id, title: "T" };
      expect((await as("viewer").post(`/api/projects/${project.id}/tasks`, body)).status).toBe(403);
      const put = await as("admin").put(
        `/api/projects/${project.id}/roles/${team.members.viewer.id}`,
        { role: "member" },
      );
      expect(put.status).toBe(200);
      expectContract(ProjectMemberRole, put.body);
      expect((await as("viewer").post(`/api/projects/${project.id}/tasks`, body)).status).toBe(201);
      const list = await as("viewer").get(`/api/projects/${project.id}/roles`);
      expect(expectContract(z.array(ProjectMemberRole), list.body)).toHaveLength(1);
    });

    it("把 Admin 降成 Viewer 後就不能在這個 Project 建立 Task", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      await as("owner").put(`/api/projects/${project.id}/roles/${team.members.admin.id}`, {
        role: "viewer",
      });
      const res = await as("admin").post(`/api/projects/${project.id}/tasks`, {
        repoId: repo.id,
        title: "T",
      });
      expect(res.status).toBe(403);
    });

    it("移除覆寫後恢復 Team 的 Role", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const path = `/api/projects/${project.id}/roles/${team.members.member.id}`;
      await as("admin").put(path, { role: "viewer" });
      expect((await as("admin").delete(path)).status).toBe(204);
      await createTask(project.id, repo.id);
    });

    it("不能覆寫成 Owner，也不能覆寫 Team 的 Owner", async () => {
      const project = await createProject();
      const base = `/api/projects/${project.id}/roles`;
      expect(
        (await as("admin").put(`${base}/${team.members.member.id}`, { role: "owner" })).status,
      ).toBe(400);
      expect(
        (await as("admin").put(`${base}/${team.members.owner.id}`, { role: "viewer" })).status,
      ).toBe(409);
    });

    it("Member 不能設定覆寫", async () => {
      const project = await createProject();
      const res = await as("member").put(
        `/api/projects/${project.id}/roles/${team.members.viewer.id}`,
        { role: "admin" },
      );
      expect(res.status).toBe(403);
    });
  });

  describe("Repo", () => {
    it("登記、列出 Repo", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      expect(repo).toMatchObject({ owner: "acme", name: "orbis", defaultBranch: "main" });
      const list = await as("viewer").get(`/api/projects/${project.id}/repos`);
      expect(expectContract(z.array(Repo), list.body)).toHaveLength(1);
    });

    it("重複登記回 409；GitHub 整合拒絕時回 422", async () => {
      const project = await createProject();
      await createRepo(project.id);
      const dup = await as("admin").post(`/api/projects/${project.id}/repos`, {
        owner: "acme",
        name: "orbis",
      });
      expect(dup.status).toBe(409);
      rejectRepo = "acme/secret";
      const rejected = await as("admin").post(`/api/projects/${project.id}/repos`, {
        owner: "acme",
        name: "secret",
      });
      expect(rejected.status).toBe(422);
    });

    it("Member 不能登記 Repo", async () => {
      const project = await createProject();
      const res = await as("member").post(`/api/projects/${project.id}/repos`, {
        owner: "acme",
        name: "x",
      });
      expect(res.status).toBe(403);
    });

    it("還有 Task 使用時不能移除 Repo", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const unused = await createRepo(project.id, "unused");
      await createTask(project.id, repo.id);
      expect((await as("admin").delete(`/api/repos/${repo.id}`)).status).toBe(409);
      expect((await as("admin").delete(`/api/repos/${unused.id}`)).status).toBe(204);
    });
  });

  describe("Task", () => {
    it("建立 Task 時依序產生 Task Key", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const first = await createTask(project.id, repo.id);
      const second = await createTask(project.id, repo.id);
      expect(first).toMatchObject({
        key: "ORB-1",
        status: "backlog",
        createdByMemberId: team.members.member.id,
      });
      expect(second.key).toBe("ORB-2");
    });

    it("並行建立 20 個 Task，Task Key 不重複而且連續", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          as("member").post<{ key: string }>(`/api/projects/${project.id}/tasks`, {
            repoId: repo.id,
            title: `並行 ${i}`,
          }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const keys = results
        .map((r) => r.body.key)
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      expect(keys).toEqual(Array.from({ length: 20 }, (_, i) => `ORB-${i + 1}`));
    });

    it("Repo 不屬於這個 Project 時回 422", async () => {
      const project = await createProject("ORB");
      const other = await createProject("OTH");
      const otherRepo = await createRepo(other.id);
      const res = await as("member").post(`/api/projects/${project.id}/tasks`, {
        repoId: otherRepo.id,
        title: "T",
      });
      expect(res.status).toBe(422);
    });

    it("Viewer 不能建立或修改 Task", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id);
      expect(
        (
          await as("viewer").post(`/api/projects/${project.id}/tasks`, {
            repoId: repo.id,
            title: "T",
          })
        ).status,
      ).toBe(403);
      expect((await as("viewer").patch(`/api/tasks/${task.id}`, { title: "X" })).status).toBe(403);
      expect((await as("viewer").get(`/api/tasks/${task.id}`)).status).toBe(200);
    });

    it("以 Task Key 查詢", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id);
      const res = await as("viewer").get(`/api/tasks/by-key/${task.key}`);
      expect(res.status).toBe(200);
      expect(expectContract(Task, res.body).id).toBe(task.id);
      expect((await as("viewer").get("/api/tasks/by-key/ORB-999")).status).toBe(404);
      expect((await as("viewer").get("/api/tasks/by-key/nope")).status).toBe(404);
    });

    it("更新欄位、指派對象與 Spec 路徑", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id);
      const res = await as("member").patch(`/api/tasks/${task.id}`, {
        title: "改過的標題",
        assigneeMemberId: team.members.member.id,
        specPath: "docs\\specs\\login.md",
        planGateEnabled: false,
      });
      expect(res.status).toBe(200);
      expect(expectContract(Task, res.body)).toMatchObject({
        title: "改過的標題",
        assigneeMemberId: team.members.member.id,
        specPath: "docs/specs/login.md",
        planGateEnabled: false,
      });
    });

    it("指派給其他 Team 的人時回 422", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id);
      const other = await seedTeam(database.db, "Other");
      const res = await as("member").patch(`/api/tasks/${task.id}`, {
        assigneeMemberId: other.members.member.id,
      });
      expect(res.status).toBe(422);
    });

    it("建立與更新相依；拒絕依賴自己、循環與跨 Project", async () => {
      const project = await createProject("ORB");
      const repo = await createRepo(project.id);
      const a = await createTask(project.id, repo.id);
      const b = await createTask(project.id, repo.id, { dependsOn: [a.id] });
      expect(b.dependsOn).toEqual([a.id]);
      const c = await createTask(project.id, repo.id, { dependsOn: [b.id] });

      expect((await as("member").patch(`/api/tasks/${a.id}`, { dependsOn: [a.id] })).status).toBe(
        422,
      );
      // a → c → b → a
      expect((await as("member").patch(`/api/tasks/${a.id}`, { dependsOn: [c.id] })).status).toBe(
        422,
      );
      expect((await as("member").patch(`/api/tasks/${a.id}`, { dependsOn: [b.id] })).status).toBe(
        422,
      );

      const other = await createProject("OTH");
      const otherRepo = await createRepo(other.id);
      const foreign = await createTask(other.id, otherRepo.id);
      expect(
        (await as("member").patch(`/api/tasks/${a.id}`, { dependsOn: [foreign.id] })).status,
      ).toBe(422);

      const cleared = await as("member").patch(`/api/tasks/${c.id}`, { dependsOn: [a.id] });
      expect(expectContract(Task, cleared.body).dependsOn).toEqual([a.id]);
    });

    it("列出 Project 的 Task，可以依狀態篩選", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      await createTask(project.id, repo.id);
      await createTask(project.id, repo.id);
      const all = await as("viewer").get(`/api/projects/${project.id}/tasks`);
      expect(expectContract(z.array(Task), all.body)).toHaveLength(2);
      const ready = await as("viewer").get(`/api/projects/${project.id}/tasks?status=ready`);
      expect(ready.body).toEqual([]);
      expect((await as("viewer").get(`/api/projects/${project.id}/tasks?status=nope`)).status).toBe(
        400,
      );
    });

    it("刪除 Task", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id);
      expect((await as("member").delete(`/api/tasks/${task.id}`)).status).toBe(204);
      expect((await as("member").get(`/api/tasks/${task.id}`)).status).toBe(404);
    });
  });

  describe("手動狀態轉換", () => {
    it("Spec 與 Acceptance Criterion 不齊時不能進 Ready", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id, { description: "" });
      const res = await as("member").post(`/api/tasks/${task.id}/transition`, { status: "ready" });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: "invalid_transition",
        missing: ["沒有描述或 Spec", "沒有 Acceptance Criterion"],
      });
    });

    it("齊備後可以 Backlog → Ready → Backlog", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id);
      await as("member").post(`/api/tasks/${task.id}/acceptance-criteria`, {
        kind: "manual",
        description: "可以登入",
      });
      const ready = await as("member").post(`/api/tasks/${task.id}/transition`, {
        status: "ready",
      });
      expect(ready.status).toBe(200);
      expect(expectContract(Task, ready.body).status).toBe("ready");
      const back = await as("member").post(`/api/tasks/${task.id}/transition`, {
        status: "backlog",
      });
      expect(expectContract(Task, back.body).status).toBe("backlog");
    });

    it("手動轉到其他狀態一律回 409 invalid_transition", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id);
      for (const status of ["planning", "running", "review_gate", "pr_open", "done"]) {
        const res = await as("member").post(`/api/tasks/${task.id}/transition`, { status });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: "invalid_transition" });
      }
    });

    it("Viewer 不能轉換狀態", async () => {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id);
      const res = await as("viewer").post(`/api/tasks/${task.id}/transition`, { status: "ready" });
      expect(res.status).toBe(403);
    });
  });

  describe("Acceptance Criterion", () => {
    async function setup() {
      const project = await createProject();
      const repo = await createRepo(project.id);
      const task = await createTask(project.id, repo.id);
      const add = async (description: string, extra: Record<string, unknown> = {}) => {
        const res = await as("member").post(`/api/tasks/${task.id}/acceptance-criteria`, {
          kind: "manual",
          description,
          ...extra,
        });
        expect(res.status).toBe(201);
        return expectContract(AcceptanceCriterion, res.body);
      };
      const list = async () => {
        const res = await as("viewer").get(`/api/tasks/${task.id}/acceptance-criteria`);
        return expectContract(z.array(AcceptanceCriterion), res.body);
      };
      return { task, add, list };
    }

    it("新增時預設加在最後，指定 position 時插入", async () => {
      const { add, list } = await setup();
      await add("A");
      await add("B");
      await add("C", { position: 0 });
      expect((await list()).map((c) => [c.description, c.position])).toEqual([
        ["C", 0],
        ["A", 1],
        ["B", 2],
      ]);
    });

    it("command 類型要有指令；其他類型不能有指令", async () => {
      const { task, add } = await setup();
      const cmd = await add("lint 通過", { kind: "command", command: "pnpm lint" });
      expect(cmd).toMatchObject({ kind: "command", command: "pnpm lint", result: "pending" });
      const bad = await as("member").post(`/api/tasks/${task.id}/acceptance-criteria`, {
        kind: "manual",
        description: "x",
        command: "rm -rf /",
      });
      expect(bad.status).toBe(400);
      const manual = await add("人工");
      expect(
        (await as("member").patch(`/api/acceptance-criteria/${manual.id}`, { command: "ls" }))
          .status,
      ).toBe(400);
      const switched = await as("member").patch(`/api/acceptance-criteria/${cmd.id}`, {
        kind: "agent",
        command: null,
      });
      expect(expectContract(AcceptanceCriterion, switched.body)).toMatchObject({
        kind: "agent",
        command: null,
      });
    });

    it("移動位置與刪除後重新排序", async () => {
      const { add, list } = await setup();
      const a = await add("A");
      await add("B");
      await add("C");
      await as("member").patch(`/api/acceptance-criteria/${a.id}`, { position: 2 });
      expect((await list()).map((c) => c.description)).toEqual(["B", "C", "A"]);
      await as("member").patch(`/api/acceptance-criteria/${a.id}`, { position: 0 });
      expect((await list()).map((c) => c.description)).toEqual(["A", "B", "C"]);
      expect((await as("member").delete(`/api/acceptance-criteria/${a.id}`)).status).toBe(204);
      expect((await list()).map((c) => [c.description, c.position])).toEqual([
        ["B", 0],
        ["C", 1],
      ]);
    });

    it("Viewer 不能新增、修改或刪除", async () => {
      const { task, add } = await setup();
      const a = await add("A");
      expect(
        (
          await as("viewer").post(`/api/tasks/${task.id}/acceptance-criteria`, {
            kind: "manual",
            description: "x",
          })
        ).status,
      ).toBe(403);
      expect(
        (await as("viewer").patch(`/api/acceptance-criteria/${a.id}`, { description: "y" })).status,
      ).toBe(403);
      expect((await as("viewer").delete(`/api/acceptance-criteria/${a.id}`)).status).toBe(403);
    });
  });
});
