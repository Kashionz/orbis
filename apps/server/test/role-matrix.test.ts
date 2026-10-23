// Role 授權矩陣（ARCHITECTURE §12.2）的每一格：每一列能力 × 每個 Role，都打真實的 API 端點。
// 允許的格子必須回 2xx，不允許的格子必須回 403。Project 的 Role 覆寫與政策開關另外各有一組。
//
// 矩陣中還沒有 API 可以測的項目（之後的軌實作）：
// - 「Credential 的並行上限」：並行控管在 B2。
// - 「留言」：留言在 B2。

import { API_ROUTES, apiPath, type Role } from "@orbis/api-contract";
import type { PermissionPurpose } from "@orbis/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { dispatches, gates, needsYouItems, projects, runners, runs, tasks } from "../src/db/schema";
import {
  client,
  createTestContext,
  ROLES_UNDER_TEST,
  resetDatabase,
  type SeededTeam,
  seedProject,
  seedReadyTask,
  seedTeam,
  type TestContext,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

type Expectation = Record<Role, boolean>;

const ADMIN_UP: Expectation = { owner: true, admin: true, member: false, viewer: false };
const MEMBER_UP: Expectation = { owner: true, admin: true, member: true, viewer: false };
const EVERYONE: Expectation = { owner: true, admin: true, member: true, viewer: true };
/** 只有 Role 為 Member 的那一位（Local Runner 的擁有者）。 */
const ONLY_MEMBER: Expectation = { owner: false, admin: false, member: true, viewer: false };

describe.skipIf(dbSkipReason !== null)("Role 授權矩陣（每一格都打真實端點）", () => {
  let database: TestDatabase;
  let ctx: TestContext;
  let team: SeededTeam;
  let project: typeof projects.$inferSelect;
  let repoId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    ctx = createTestContext(database.db);
    team = await seedTeam(database.db);
    const seeded = await seedProject(database.db, team.teamId);
    project = seeded.project;
    repoId = seeded.repo.id;
  });

  const as = (role: Role) => client(ctx.app, team.members[role].cookie);

  /** 對每個 Role 執行一次 action，檢查允許（2xx）或拒絕（403）。 */
  async function checkCells(expectation: Expectation, action: (role: Role) => Promise<number>) {
    const results: Record<string, number> = {};
    for (const role of ROLES_UNDER_TEST) results[role] = await action(role);
    const expected = Object.fromEntries(
      ROLES_UNDER_TEST.map((role) => [role, expectation[role] ? "2xx" : 403]),
    );
    const actual = Object.fromEntries(
      ROLES_UNDER_TEST.map((role) => {
        const status = results[role] ?? 0;
        return [role, status >= 200 && status < 300 ? "2xx" : status];
      }),
    );
    expect(actual).toEqual(expected);
  }

  async function setPolicy(columns: Partial<typeof projects.$inferInsert>) {
    await database.db.update(projects).set(columns).where(eq(projects.id, project.id));
  }

  /**
   * 已在 Review Gate、Run 已被（離線的）Runner 接受的 Task 與它的 Gate。
   * `atCreation`：Gate 建立時的指派對象（預設與目前的相同）。
   */
  async function reviewGate(
    assigneeMemberId: string | null = null,
    atCreation: string | null = assigneeMemberId,
  ) {
    const task = await seedReadyTask(database.db, project, repoId, {
      status: "review_gate",
      assigneeMemberId,
    });
    const [runner] = await database.db
      .insert(runners)
      .values({
        teamId: team.teamId,
        kind: "team",
        name: "r",
        runnerVersion: "0",
        os: "linux",
        arch: "x86_64",
        tokenHash: sha256Hex(`${task.id}`),
      })
      .returning();
    const [run] = await database.db
      .insert(runs)
      .values({
        taskId: task.id,
        agent: "claude-code",
        permissionPolicy: "auto",
        target: "team",
        status: "awaiting_gate",
        runnerId: runner?.id,
      })
      .returning();
    await database.db.insert(dispatches).values({
      runId: run?.id as string,
      runnerId: runner?.id as string,
      status: "accepted",
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
    });
    const [gate] = await database.db
      .insert(gates)
      .values({
        taskId: task.id,
        runId: run?.id,
        kind: "review",
        assigneeMemberIdAtCreation: atCreation,
      })
      .returning();
    return { task, gate: gate as typeof gates.$inferSelect };
  }

  /**
   * 在（離線的）Runner 上執行中的 Run，以及它的一個權限請求。
   * Local Runner 的擁有者是 Role 為 Member 的那一位。回傳回覆的路徑。
   */
  async function permissionRequest(runnerKind: "local" | "team", purpose: PermissionPurpose) {
    const owner = team.members.member.id;
    const task = await seedReadyTask(database.db, project, repoId, { status: "running" });
    const [runner] = await database.db
      .insert(runners)
      .values({
        teamId: team.teamId,
        kind: runnerKind,
        memberId: runnerKind === "local" ? owner : null,
        name: "r",
        runnerVersion: "0",
        os: "windows",
        arch: "x86_64",
        tokenHash: sha256Hex(`permission-${task.id}`),
      })
      .returning();
    const [run] = await database.db
      .insert(runs)
      .values({
        taskId: task.id,
        agent: "claude-code",
        permissionPolicy: "manual",
        target: runnerKind,
        status: "awaiting_permission",
        runnerId: runner?.id,
        requestedByMemberId: owner,
      })
      .returning();
    const runId = run?.id as string;
    await database.db.insert(dispatches).values({
      runId,
      runnerId: runner?.id as string,
      status: "accepted",
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
    });
    const requestId = `req-${task.id}`;
    await database.db.insert(needsYouItems).values({
      projectId: project.id,
      memberId: owner,
      kind: "permission_request",
      taskId: task.id,
      runId,
      payload: {
        permissionRequestId: requestId,
        toolCallId: null,
        title: "權限請求",
        purpose,
        options: [{ optionId: "allow", name: "允許", kind: "allow_once" }],
      },
    });
    return apiPath(API_ROUTES.runPermissionResponse, { runId, requestId });
  }

  describe("管理成員、Team Runner", () => {
    it("新增 Member", async () => {
      let id = 5000;
      await checkCells(ADMIN_UP, async (role) => {
        const login = `new${id}`;
        ctx.githubUsers.add({ id: id++, login, name: null, avatarUrl: null });
        return (await as(role).post("/api/members", { githubLogin: login })).status;
      });
    });

    it("變更 Member 的 Role", async () => {
      await checkCells(
        ADMIN_UP,
        async (role) =>
          (
            await as(role).patch(`/api/members/${team.members.viewer.id}`, {
              role: "viewer",
            })
          ).status,
      );
    });

    it("產生 Team Runner 的 Pairing token", async () => {
      await checkCells(
        ADMIN_UP,
        async (role) =>
          (await as(role).post("/api/runner-pairing-tokens", { kind: "team" })).status,
      );
    });

    it("撤銷 Team Runner", async () => {
      await checkCells(ADMIN_UP, async (role) => {
        const [runner] = await database.db
          .insert(runners)
          .values({
            teamId: team.teamId,
            kind: "team",
            name: role,
            runnerVersion: "0",
            os: "linux",
            arch: "x86_64",
            tokenHash: sha256Hex(`revoke-${role}`),
          })
          .returning();
        return (await as(role).delete(`/api/runners/${runner?.id}`)).status;
      });
    });
  });

  describe("修改 Permission Policy", () => {
    it("修改 Project 的預設 Permission Policy", async () => {
      await checkCells(
        ADMIN_UP,
        async (role) =>
          (
            await as(role).patch(`/api/projects/${project.id}`, {
              policy: { defaultPermissionPolicy: "manual" },
            })
          ).status,
      );
    });
  });

  describe("派工到 Team Runner", () => {
    it("Project 允許時", async () => {
      await checkCells(MEMBER_UP, async (role) => {
        const task = await seedReadyTask(database.db, project, repoId);
        return (
          await as(role).post(`/api/tasks/${task.id}/runs`, {
            agent: "claude-code",
            runnerKind: "team",
          })
        ).status;
      });
    });

    it("Project 關閉 Member 派工到 Team Runner 時", async () => {
      await setPolicy({ allowMemberTeamRunnerDispatch: false });
      await checkCells(ADMIN_UP, async (role) => {
        const task = await seedReadyTask(database.db, project, repoId);
        return (
          await as(role).post(`/api/tasks/${task.id}/runs`, {
            agent: "claude-code",
            runnerKind: "team",
          })
        ).status;
      });
    });
  });

  describe("建立與編輯 Task、派工到自己的 Local Runner", () => {
    it("建立 Task", async () => {
      await checkCells(
        MEMBER_UP,
        async (role) =>
          (await as(role).post(`/api/projects/${project.id}/tasks`, { repoId, title: role }))
            .status,
      );
    });

    it("編輯 Task", async () => {
      const task = await seedReadyTask(database.db, project, repoId);
      await checkCells(
        MEMBER_UP,
        async (role) => (await as(role).patch(`/api/tasks/${task.id}`, { title: role })).status,
      );
    });

    it("新增 Acceptance Criterion", async () => {
      const task = await seedReadyTask(database.db, project, repoId);
      await checkCells(
        MEMBER_UP,
        async (role) =>
          (
            await as(role).post(`/api/tasks/${task.id}/acceptance-criteria`, {
              kind: "manual",
              description: role,
            })
          ).status,
      );
    });

    it("手動轉換狀態", async () => {
      await checkCells(MEMBER_UP, async (role) => {
        const task = await seedReadyTask(database.db, project, repoId);
        return (await as(role).post(`/api/tasks/${task.id}/transition`, { status: "backlog" }))
          .status;
      });
    });

    it("派工到自己的 Local Runner", async () => {
      await checkCells(MEMBER_UP, async (role) => {
        const task = await seedReadyTask(database.db, project, repoId);
        return (
          await as(role).post(`/api/tasks/${task.id}/runs`, {
            agent: "claude-code",
            runnerKind: "local",
          })
        ).status;
      });
    });

    it("產生自己的 Local Runner 的 Pairing token", async () => {
      await checkCells(
        MEMBER_UP,
        async (role) =>
          (await as(role).post("/api/runner-pairing-tokens", { kind: "local" })).status,
      );
    });

    it("中止 Run", async () => {
      await checkCells(MEMBER_UP, async (role) => {
        const task = await seedReadyTask(database.db, project, repoId);
        const run = await as("owner").post<{ id: string }>(`/api/tasks/${task.id}/runs`, {
          agent: "claude-code",
          runnerKind: "team",
        });
        return (await as(role).post(`/api/runs/${run.body.id}/cancel`)).status;
      });
    });
  });

  describe("核准 Gate、開 PR", () => {
    it("核准 Review Gate", async () => {
      await checkCells(MEMBER_UP, async (role) => {
        const { gate } = await reviewGate();
        return (await as(role).post(`/api/gates/${gate.id}/decision`, { action: "approve" }))
          .status;
      });
    });

    it("退回 Review Gate", async () => {
      await checkCells(MEMBER_UP, async (role) => {
        const { gate } = await reviewGate();
        return (
          await as(role).post(`/api/gates/${gate.id}/decision`, {
            action: "reject",
            comment: "再改一下",
          })
        ).status;
      });
    });

    it("Project 禁止核准自己的 Task 時，核准指派給自己的 Task", async () => {
      await setPolicy({ forbidSelfApproval: true });
      await checkCells(ADMIN_UP, async (role) => {
        const { gate } = await reviewGate(team.members[role].id);
        return (await as(role).post(`/api/gates/${gate.id}/decision`, { action: "approve" }))
          .status;
      });
    });

    it("Project 禁止核准自己的 Task 時，核准 Gate 建立時指派給自己、之後改派給別人的 Task", async () => {
      await setPolicy({ forbidSelfApproval: true });
      await checkCells(ADMIN_UP, async (role) => {
        const { gate } = await reviewGate(team.members.owner.id, team.members[role].id);
        return (await as(role).post(`/api/gates/${gate.id}/decision`, { action: "approve" }))
          .status;
      });
    });

    it("Project 禁止核准自己的 Task 時，核准指派給別人的 Task", async () => {
      await setPolicy({ forbidSelfApproval: true });
      await checkCells(MEMBER_UP, async (role) => {
        const { gate } = await reviewGate(team.members.owner.id);
        return (await as(role).post(`/api/gates/${gate.id}/decision`, { action: "approve" }))
          .status;
      });
    });
  });

  describe("回覆權限請求（§8）", () => {
    const respond = async (role: Role, path: string) =>
      (await as(role).post(path, { optionId: "allow" })).status;

    it("Team Runner 上的 Run：Member 以上", async () => {
      await checkCells(MEMBER_UP, async (role) =>
        respond(role, await permissionRequest("team", "tool")),
      );
    });

    it("Local Runner 上的 Run：只有 Runner 的擁有者", async () => {
      await checkCells(ONLY_MEMBER, async (role) =>
        respond(role, await permissionRequest("local", "tool")),
      );
    });

    it("核准 config 的信任（config_trust，Team Run）：Admin 以上", async () => {
      await checkCells(ADMIN_UP, async (role) =>
        respond(role, await permissionRequest("team", "config_trust")),
      );
    });

    it("核准 config 的信任（config_trust，Local Run）：Admin 以上，擁有者是 Member 也不行", async () => {
      await checkCells(ADMIN_UP, async (role) =>
        respond(role, await permissionRequest("local", "config_trust")),
      );
    });

    it("Agent 設定檔被修改（agent_settings_changed）沿用一般規則", async () => {
      await checkCells(MEMBER_UP, async (role) =>
        respond(role, await permissionRequest("team", "agent_settings_changed")),
      );
      await checkCells(ONLY_MEMBER, async (role) =>
        respond(role, await permissionRequest("local", "agent_settings_changed")),
      );
    });
  });

  describe("查看", () => {
    it("查看 Project、Task 與 Run 的 Event", async () => {
      const task = await seedReadyTask(database.db, project, repoId);
      const run = await as("owner").post<{ id: string }>(`/api/tasks/${task.id}/runs`, {
        agent: "claude-code",
        runnerKind: "team",
      });
      await checkCells(EVERYONE, async (role) => {
        const statuses = [
          (await as(role).get(`/api/projects/${project.id}`)).status,
          (await as(role).get(`/api/tasks/${task.id}`)).status,
          (await as(role).get(`/api/runs/${run.body.id}/events`)).status,
          (await as(role).get("/api/needs-you")).status,
        ];
        return Math.max(...statuses);
      });
    });
  });

  describe("矩陣補充：Project 管理一律 Admin 以上", () => {
    it("建立 Project", async () => {
      let n = 0;
      await checkCells(
        ADMIN_UP,
        async (role) =>
          (await as(role).post("/api/projects", { name: role, keyPrefix: `P${n++}X` })).status,
      );
    });

    it("登記 Repo", async () => {
      await checkCells(
        ADMIN_UP,
        async (role) =>
          (await as(role).post(`/api/projects/${project.id}/repos`, { owner: "acme", name: role }))
            .status,
      );
    });

    it("設定 Project 的 Role 覆寫", async () => {
      await checkCells(
        ADMIN_UP,
        async (role) =>
          (
            await as(role).put(`/api/projects/${project.id}/roles/${team.members.viewer.id}`, {
              role: "viewer",
            })
          ).status,
      );
    });
  });

  describe("Project 的 Role 覆寫套用到矩陣", () => {
    it("所有人都覆寫成 Viewer 後，只剩 Owner 能建立 Task", async () => {
      for (const role of ["admin", "member"] as const) {
        await as("owner").put(`/api/projects/${project.id}/roles/${team.members[role].id}`, {
          role: "viewer",
        });
      }
      await checkCells(
        { owner: true, admin: false, member: false, viewer: false },
        async (role) =>
          (await as(role).post(`/api/projects/${project.id}/tasks`, { repoId, title: role }))
            .status,
      );
    });

    it("Viewer 覆寫成 Admin 後，可以修改這個 Project 的預設 Permission Policy", async () => {
      await as("owner").put(`/api/projects/${project.id}/roles/${team.members.viewer.id}`, {
        role: "admin",
      });
      await checkCells(
        { owner: true, admin: true, member: false, viewer: true },
        async (role) =>
          (
            await as(role).patch(`/api/projects/${project.id}`, {
              policy: { defaultPermissionPolicy: "auto" },
            })
          ).status,
      );
    });
  });

  it("Task 不屬於自己的 Team 時一律 404（不透露存在與否）", async () => {
    const other = await seedTeam(database.db, "Other");
    const task = await seedReadyTask(database.db, project, repoId);
    const outsider = client(ctx.app, other.members.owner.cookie);
    expect((await outsider.get(`/api/tasks/${task.id}`)).status).toBe(404);
    expect((await outsider.patch(`/api/tasks/${task.id}`, { title: "x" })).status).toBe(404);
    const [row] = await database.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.title).not.toBe("x");
  });
});
