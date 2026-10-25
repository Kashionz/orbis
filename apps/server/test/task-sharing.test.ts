// Task 分享與 Task 邀請（ADR-0012）：有效權限的矩陣、列表過濾、管理分享、以 email 邀請與接受。

import {
  API_ROUTES,
  apiPath,
  type GeneralAccess,
  PAGE_ROUTES,
  type Role,
  type Task,
  type TaskAccess,
  TaskInviteCreated,
  TaskShare,
} from "@orbis/api-contract";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  members,
  needsYouItems,
  type projects,
  runs,
  sessions,
  taskInvites,
  taskMembers,
  tasks,
} from "../src/db/schema";
import { RecordingMailer } from "../src/mail/mailer";
import {
  client,
  createTestContext,
  expectContract,
  ROLES_UNDER_TEST,
  resetDatabase,
  type SeededTeam,
  seedMember,
  seedProject,
  seedReadyTask,
  seedSession,
  seedTeam,
  type TestContext,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

type ShareRole = "view" | "edit" | null;
const GENERAL: GeneralAccess[] = ["invited", "team_view", "team_edit"];

/**
 * 預期的有效權限（ADR-0012）：Owner／Admin 永遠 manage；其他人取 Task 角色與一般存取限制後的 Role 中
 * 較高的一個。null＝看不到。
 */
const EXPECTED: Record<
  "member" | "viewer",
  Record<string, Record<GeneralAccess, TaskAccess | null>>
> = {
  member: {
    none: { invited: null, team_view: "view", team_edit: "edit" },
    view: { invited: "view", team_view: "view", team_edit: "edit" },
    edit: { invited: "edit", team_view: "edit", team_edit: "edit" },
  },
  viewer: {
    none: { invited: null, team_view: "view", team_edit: "view" },
    view: { invited: "view", team_view: "view", team_edit: "view" },
    edit: { invited: "edit", team_view: "edit", team_edit: "edit" },
  },
};

describe.skipIf(dbSkipReason !== null)("Task 分享與邀請", () => {
  let database: TestDatabase;
  let ctx: TestContext;
  let team: SeededTeam;
  let project: typeof projects.$inferSelect;
  let repoId: string;
  let mailer: RecordingMailer;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    mailer = new RecordingMailer();
    ctx = createTestContext(database.db, { mailer, publicUrl: "http://localhost:5173" });
    team = await seedTeam(database.db);
    const seeded = await seedProject(database.db, team.teamId);
    project = seeded.project;
    repoId = seeded.repo.id;
  });

  const as = (role: Role) => client(ctx.app, team.members[role].cookie);

  /** Owner 建立的 Task（擁有者是 Team 的 Owner）。 */
  async function ownedTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
    return seedReadyTask(database.db, project, repoId, {
      createdByMemberId: team.members.owner.id,
      ...overrides,
    });
  }

  async function share(taskId: string, memberId: string, role: "view" | "edit") {
    await database.db.insert(taskMembers).values({ taskId, memberId, role });
  }

  describe("有效權限的矩陣", () => {
    it("Team Role × Task 角色 × 一般存取：viewerAccess、查看與編輯", async () => {
      const failures: string[] = [];
      for (const generalAccess of GENERAL) {
        for (const shareRole of [null, "view", "edit"] as ShareRole[]) {
          const task = await ownedTask({ generalAccess });
          for (const role of ROLES_UNDER_TEST) {
            if (role === "owner") continue;
            if (shareRole) await share(task.id, team.members[role].id, shareRole);
            const expected: TaskAccess | null =
              role === "admin"
                ? "manage"
                : (EXPECTED[role][shareRole ?? "none"]?.[generalAccess] ?? null);
            const got = await as(role).get<Task>(apiPath(API_ROUTES.task, { taskId: task.id }));
            const actual = got.status === 404 ? null : got.body.viewerAccess;
            const edit = await as(role).patch(apiPath(API_ROUTES.task, { taskId: task.id }), {
              title: `改名 ${role}`,
            });
            const canEdit = edit.status === 200;
            const shouldEdit = expected === "edit" || expected === "manage";
            const label = `${role}／${shareRole ?? "none"}／${generalAccess}`;
            if (actual !== expected)
              failures.push(`${label}：viewerAccess ${actual} ≠ ${expected}`);
            if (canEdit !== shouldEdit) failures.push(`${label}：PATCH ${edit.status}`);
            if (expected === null && edit.status !== 404) {
              failures.push(`${label}：看不到時應該 404，實際 ${edit.status}`);
            }
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it("Team Owner 與 Admin 在「僅受邀成員」的 Task 上仍有完整權限", async () => {
      const task = await seedReadyTask(database.db, project, repoId, {
        createdByMemberId: team.members.member.id,
        generalAccess: "invited",
      });
      for (const role of ["owner", "admin"] as const) {
        const got = await as(role).get<Task>(apiPath(API_ROUTES.task, { taskId: task.id }));
        expect(got.body.viewerAccess).toBe("manage");
        const put = await as(role).put(apiPath(API_ROUTES.taskShareGeneral, { taskId: task.id }), {
          generalAccess: "team_edit",
        });
        expect(put.status).toBe(200);
        await database.db
          .update(tasks)
          .set({ generalAccess: "invited" })
          .where(eq(tasks.id, task.id));
      }
    });

    it("擁有者是 Member 時可以管理分享；Admin 層級的能力不受 Task 角色影響", async () => {
      const task = await seedReadyTask(database.db, project, repoId, {
        createdByMemberId: team.members.member.id,
      });
      const got = await as("member").get<Task>(apiPath(API_ROUTES.task, { taskId: task.id }));
      expect(got.body.viewerAccess).toBe("manage");
      // Project 設定仍要 Admin 以上
      const patch = await as("member").patch(
        apiPath(API_ROUTES.project, { projectId: project.id }),
        {
          name: "改名",
        },
      );
      expect(patch.status).toBe(403);
    });

    it("被分享為可操作的 Team Viewer 可以移動 Task；可檢視的不行", async () => {
      const task = await ownedTask({ status: "backlog" });
      await share(task.id, team.members.viewer.id, "view");
      const path = apiPath(API_ROUTES.taskTransition, { taskId: task.id });
      expect((await as("viewer").post(path, { status: "ready" })).status).toBe(403);
      await database.db
        .update(taskMembers)
        .set({ role: "edit" })
        .where(eq(taskMembers.memberId, team.members.viewer.id));
      expect((await as("viewer").post(path, { status: "ready" })).status).toBe(200);
    });
  });

  describe("列表過濾", () => {
    it("看板與待我處理濾掉看不到的 Task", async () => {
      const open = await ownedTask();
      const hidden = await ownedTask({ generalAccess: "invited" });
      for (const task of [open, hidden]) {
        const [run] = await database.db
          .insert(runs)
          .values({
            taskId: task.id,
            agent: "claude-code",
            permissionPolicy: "auto",
            target: "local",
            status: "awaiting_gate",
          })
          .returning();
        await database.db.insert(needsYouItems).values({
          projectId: project.id,
          memberId: team.members.member.id,
          kind: "stopped_run",
          taskId: task.id,
          runId: run?.id,
          payload: { reasonCode: "push_failed", attempt: null, detail: null },
        });
      }
      const board = await as("member").get<Task[]>(
        apiPath(API_ROUTES.projectTasks, { projectId: project.id }),
      );
      expect(board.body.map((t) => t.id)).toEqual([open.id]);
      const needsYou = await as("member").get<{ taskId: string }[]>(API_ROUTES.needsYou);
      expect(needsYou.body.map((i) => i.taskId)).toEqual([open.id]);

      await share(hidden.id, team.members.member.id, "view");
      const after = await as("member").get<Task[]>(
        apiPath(API_ROUTES.projectTasks, { projectId: project.id }),
      );
      expect(after.body.map((t) => t.id).sort()).toEqual([open.id, hidden.id].sort());
      // Admin 不受影響
      const admin = await as("admin").get<Task[]>(
        apiPath(API_ROUTES.projectTasks, { projectId: project.id }),
      );
      expect(admin.body).toHaveLength(2);
    });

    it("建立 Task 的人是擁有者", async () => {
      const created = await as("member").post<Task>(
        apiPath(API_ROUTES.projectTasks, { projectId: project.id }),
        { title: "新功能", repoId },
      );
      expect(created.status).toBe(201);
      expect(created.body.viewerAccess).toBe("manage");
      const shareBody = await as("viewer").get(
        apiPath(API_ROUTES.taskShare, { taskId: created.body.id }),
      );
      const parsed = expectContract(TaskShare, shareBody.body);
      expect(parsed.ownerMemberId).toBe(team.members.member.id);
      expect(parsed.generalAccess).toBe("team_edit");
    });
  });

  describe("管理分享", () => {
    it("加入成員、改角色、移除；非擁有者的 Member 不能管理", async () => {
      const task = await ownedTask();
      const membersPath = apiPath(API_ROUTES.taskShareMembers, { taskId: task.id });
      const denied = await as("member").post(membersPath, {
        memberIds: [team.members.viewer.id],
        role: "edit",
      });
      expect(denied.status).toBe(403);

      const added = await as("owner").post(membersPath, {
        memberIds: [team.members.viewer.id, team.members.member.id],
        role: "view",
      });
      expect(added.status).toBe(200);
      expect(expectContract(TaskShare, added.body).members).toHaveLength(3);

      const member = apiPath(API_ROUTES.taskShareMember, {
        taskId: task.id,
        memberId: team.members.viewer.id,
      });
      const changed = await as("owner").patch<TaskShare>(member, { role: "edit" });
      expect(changed.body.members.find((m) => m.memberId === team.members.viewer.id)?.role).toBe(
        "edit",
      );
      const removed = await as("owner").delete<TaskShare>(member);
      expect(removed.body.members.some((m) => m.memberId === team.members.viewer.id)).toBe(false);
    });

    it("轉移擁有者：原擁有者變成可操作；擁有者不能直接移除或降級", async () => {
      const task = await ownedTask();
      const ownerPath = apiPath(API_ROUTES.taskShareMember, {
        taskId: task.id,
        memberId: team.members.owner.id,
      });
      expect((await as("owner").delete(ownerPath)).status).toBe(409);
      expect((await as("owner").patch(ownerPath, { role: "view" })).status).toBe(409);

      const transferred = await as("owner").patch<TaskShare>(
        apiPath(API_ROUTES.taskShareMember, { taskId: task.id, memberId: team.members.member.id }),
        { role: "owner" },
      );
      expect(transferred.status).toBe(200);
      expect(transferred.body.ownerMemberId).toBe(team.members.member.id);
      expect(transferred.body.members.find((m) => m.memberId === team.members.owner.id)?.role).toBe(
        "edit",
      );
      // 新的擁有者（Team Member）現在可以管理分享
      const put = await as("member").put(
        apiPath(API_ROUTES.taskShareGeneral, { taskId: task.id }),
        {
          generalAccess: "team_view",
        },
      );
      expect(expectContract(TaskShare, put.body).generalAccess).toBe("team_view");
    });

    it("只能加入同一個 Team 的 Member", async () => {
      const task = await ownedTask();
      const other = await seedTeam(database.db, "Other");
      const result = await as("owner").post(
        apiPath(API_ROUTES.taskShareMembers, { taskId: task.id }),
        { memberIds: [other.members.member.id], role: "view" },
      );
      expect(result.status).toBe(404);
    });
  });

  describe("以 email 邀請", () => {
    const inviteInput = { email: "Guest@Example.com", role: "edit" as const };

    async function invite(taskId: string) {
      const created = await as("owner").post(
        apiPath(API_ROUTES.taskShareInvites, { taskId }),
        inviteInput,
      );
      expect(created.status).toBe(201);
      const parsed = expectContract(TaskInviteCreated, created.body);
      if (parsed.kind !== "invited") throw new Error("應該產生邀請");
      return parsed;
    }

    function open(url: string, cookie: string | null) {
      const path = new URL(url).pathname + new URL(url).search;
      return ctx.app.request(path, { headers: cookie ? { cookie } : {} });
    }

    it("產生只出現一次的連結、只存 hash、有設定 SMTP 時寄信", async () => {
      const task = await ownedTask();
      const created = await invite(task.id);
      expect(created.invite.email).toBe("guest@example.com");
      expect(created.emailSent).toBe(true);
      expect(mailer.sent[0]?.to).toBe("guest@example.com");
      expect(mailer.sent[0]?.text).toContain(created.inviteUrl);
      const token = new URL(created.inviteUrl).pathname.split("/").at(-1) as string;
      expect(created.inviteUrl).toBe(
        `http://localhost:5173${apiPath(PAGE_ROUTES.inviteAccept, { token })}`,
      );
      const [row] = await database.db.select().from(taskInvites);
      expect(row?.tokenHash).toBe(sha256Hex(token));
      expect(JSON.stringify(row)).not.toContain(token);
      const shareBody = await as("owner").get(apiPath(API_ROUTES.taskShare, { taskId: task.id }));
      expect(JSON.stringify(shareBody.body)).not.toContain(token);
      expect(expectContract(TaskShare, shareBody.body).invites).toHaveLength(1);
    });

    it("沒有設定 SMTP 時不寄（emailSent 為 false）", async () => {
      ctx = createTestContext(database.db);
      const task = await ownedTask();
      const created = await invite(task.id);
      expect(created.emailSent).toBe(false);
    });

    it("email 已是 Member 的已驗證 email 時直接加進 Task", async () => {
      const task = await ownedTask();
      const guest = await seedMember(database.db, team.teamId, "viewer", {
        email: "guest@example.com",
      });
      const created = await as("owner").post(
        apiPath(API_ROUTES.taskShareInvites, { taskId: task.id }),
        inviteInput,
      );
      const parsed = expectContract(TaskInviteCreated, created.body);
      expect(parsed.kind).toBe("member_added");
      const [row] = await database.db
        .select()
        .from(taskMembers)
        .where(and(eq(taskMembers.taskId, task.id), eq(taskMembers.memberId, guest.id)));
      expect(row?.role).toBe("edit");
      expect(await database.db.select().from(taskInvites)).toHaveLength(0);
    });

    it("接受：還不是 Member 的人以 Viewer 加入 Team，取得 Task 角色，轉到 Task", async () => {
      const task = await ownedTask({ generalAccess: "invited" });
      const created = await invite(task.id);
      const guest = await seedSession(database.db, { email: "guest@example.com" });
      const response = await open(created.inviteUrl, guest.cookie);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `http://localhost:5173/tasks/${encodeURIComponent(task.key)}`,
      );
      const [member] = await database.db
        .select()
        .from(members)
        .where(eq(members.githubUserId, guest.githubUserId));
      expect(member?.role).toBe("viewer");
      expect(member?.teamId).toBe(team.teamId);
      const [session] = await database.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, guest.sessionId));
      expect(session?.currentTeamId).toBe(team.teamId);
      // 調高後在「僅受邀成員」的 Task 上可以操作
      const got = await client(ctx.app, guest.cookie).get<Task>(
        apiPath(API_ROUTES.task, { taskId: task.id }),
      );
      expect(got.body.viewerAccess).toBe("edit");
      // 再開一次直接到 Task；別人開已接受的連結當作找不到
      expect((await open(created.inviteUrl, guest.cookie)).status).toBe(302);
      const other = await seedSession(database.db, { email: "guest@example.com" });
      const reused = await open(created.inviteUrl, other.cookie);
      expect(reused.headers.get("location")).toContain("code=invite_not_found");
    });

    it("沒有登入時先轉到 GitHub 登入，登入後回到邀請連結", async () => {
      const task = await ownedTask();
      const created = await invite(task.id);
      const response = await open(created.inviteUrl, null);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") as string);
      expect(location.pathname).toBe(API_ROUTES.authGithubLogin);
      expect(location.searchParams.get("returnTo")).toBe(new URL(created.inviteUrl).pathname);
    });

    it("session 沒有已驗證 email 時重新登入一次，仍然沒有就是 email 不符", async () => {
      const task = await ownedTask();
      const created = await invite(task.id);
      const guest = await seedSession(database.db, { email: null });
      const first = await open(created.inviteUrl, guest.cookie);
      const login = new URL(first.headers.get("location") as string);
      expect(login.pathname).toBe(API_ROUTES.authGithubLogin);
      const back = login.searchParams.get("returnTo") as string;
      expect(back).toContain("relogin=1");
      const second = await open(`http://localhost:5173${back}`, guest.cookie);
      expect(second.headers.get("location")).toContain("code=invite_email_mismatch");
    });

    it("email 不符、過期、撤銷、不存在", async () => {
      const task = await ownedTask();
      const created = await invite(task.id);
      const wrong = await seedSession(database.db, { email: "someone@example.com" });
      expect((await open(created.inviteUrl, wrong.cookie)).headers.get("location")).toBe(
        "http://localhost:5173/invites/error?code=invite_email_mismatch",
      );

      const guest = await seedSession(database.db, { email: "guest@example.com" });
      ctx.clock.advance(7 * 24 * 60 * 60 * 1000 + 1);
      expect((await open(created.inviteUrl, guest.cookie)).headers.get("location")).toContain(
        "code=invite_expired",
      );

      const again = await invite(task.id);
      const revoke = await as("owner").delete(
        apiPath(API_ROUTES.taskShareInvite, { taskId: task.id, inviteId: again.invite.id }),
      );
      expect(revoke.status).toBe(200);
      expect(expectContract(TaskShare, revoke.body).invites).toHaveLength(0);
      expect((await open(again.inviteUrl, guest.cookie)).headers.get("location")).toContain(
        "code=invite_revoked",
      );
      expect(
        (await open("http://localhost:5173/invites/not-a-token", guest.cookie)).headers.get(
          "location",
        ),
      ).toContain("code=invite_not_found");
    });

    it("再邀請同一個 email 時撤銷舊的連結", async () => {
      const task = await ownedTask();
      const first = await invite(task.id);
      await invite(task.id);
      const guest = await seedSession(database.db, { email: "guest@example.com" });
      expect((await open(first.inviteUrl, guest.cookie)).headers.get("location")).toContain(
        "code=invite_revoked",
      );
    });

    it("非擁有者的 Member 不能邀請", async () => {
      const task = await ownedTask();
      const result = await as("member").post(
        apiPath(API_ROUTES.taskShareInvites, { taskId: task.id }),
        inviteInput,
      );
      expect(result.status).toBe(403);
    });
  });
});
