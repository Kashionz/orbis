// 預覽邀請（ADR-0015）：Team 設定、權限、名單內外、期限、撤銷、Preview 停止與 Worktree 封存後失效、
// 開啟時間的紀錄，以及沒有 Team 的受邀者也能換票。

import {
  API_ROUTES,
  apiPath,
  PreviewInviteCreated,
  PreviewInviteListResponse,
} from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/crypto";
import {
  dispatches,
  previewInvites,
  runControls,
  runEvents,
  runners,
  runs,
  taskMembers,
  teams,
} from "../../src/db/schema";
import { RecordingMailer } from "../../src/mail/mailer";
import { canViewRun } from "../../src/preview/access";
import {
  client,
  createTestContext,
  expectContract,
  resetDatabase,
  type SeededTeam,
  seedProject,
  seedReadyTask,
  seedSession,
  seedTeam,
  type TestContext,
} from "../helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "../helpers/db";

const PREVIEW_DOMAIN = "preview.test";
const PUBLIC_URL = "http://localhost:5173";

describe.skipIf(dbSkipReason !== null)("預覽邀請", () => {
  let database: TestDatabase;
  let ctx: TestContext;
  let team: SeededTeam;
  let runId: string;
  let taskId: string;
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
    ctx = createTestContext(database.db, {
      previewDomain: PREVIEW_DOMAIN,
      publicUrl: PUBLIC_URL,
      mailer,
    });
    ctx.githubUsers.add({ id: 4242, login: "Designer", name: null, avatarUrl: null });
    team = await seedTeam(database.db);
    await database.db
      .update(teams)
      .set({ allowExternalPreview: true })
      .where(eq(teams.id, team.teamId));
    const { project, repo } = await seedProject(database.db, team.teamId);
    const task = await seedReadyTask(database.db, project, repo.id, { status: "running" });
    taskId = task.id;
    const [run] = await database.db
      .insert(runs)
      .values({
        taskId: task.id,
        agent: "claude-code",
        permissionPolicy: "manual",
        target: "local",
        status: "running",
      })
      .returning();
    if (!run) throw new Error("建立 Run 失敗");
    runId = run.id;
    await addEvent(1, "worktree_ready", {
      worktree_path: "C:\\ob\\orbis\\ORB-1",
      branch: "orbis/orb-1",
      base_commit: "a".repeat(40),
      preview_port: 41234,
    });
    await addEvent(2, "preview_ready", { port: 41234, url: "http://localhost:41234/" });
  });

  async function addEvent(seq: number, kind: string, payload: Record<string, unknown>) {
    await database.db
      .insert(runEvents)
      .values({ runId, seq, ts: new Date(), kind, payload: { kind, ...payload } });
  }

  const list = () => apiPath(API_ROUTES.runPreviewInvites, { runId });
  const as = (role: "owner" | "admin" | "member" | "viewer") =>
    client(ctx.app, team.members[role].cookie);

  async function invite(body: Record<string, unknown>) {
    const res = await as("member").post(list(), body);
    expect(res.status).toBe(201);
    return expectContract(PreviewInviteCreated, res.body);
  }

  function open(url: string, cookie: string | null) {
    const target = new URL(url);
    return ctx.app.request(`${target.pathname}${target.search}`, {
      headers: cookie ? { cookie } : {},
    });
  }

  it("以 GitHub 帳號邀請：保存 user id；受邀者（不屬於任何 Team）登入後換票、記錄開啟時間", async () => {
    const created = await invite({ githubLogin: "designer" });
    expect(created.invite).toMatchObject({
      githubUserId: 4242,
      githubLogin: "Designer",
      email: null,
      status: "active",
    });
    expect(created.emailSent).toBe(false);
    const token = new URL(created.inviteUrl).pathname.split("/").at(-1) as string;
    const [row] = await database.db.select().from(previewInvites);
    expect(row?.tokenHash).toBe(sha256Hex(token));

    const guest = await seedSession(database.db, { githubUserId: 4242, email: "d@example.com" });
    const res = await open(created.inviteUrl, guest.cookie);
    expect(res.status).toBe(302);
    const callback = new URL(res.headers.get("location") as string);
    expect(callback.host).toBe(`${runId}.${PREVIEW_DOMAIN}`);
    expect(callback.searchParams.get("ticket")).toBeTruthy();
    expect(await canViewRun(database.db, ctx.clock, guest.sessionId, runId)).toBe(true);
    // 受邀者看不到 Task 的 API
    expect(
      (await client(ctx.app, guest.cookie).get(apiPath(API_ROUTES.task, { taskId }))).status,
    ).toBe(403);

    const listed = expectContract(PreviewInviteListResponse, (await as("member").get(list())).body);
    expect(listed[0]?.lastOpenedAt).not.toBeNull();

    // previewAuthorize（preview cookie 過期後重新換票）也接受有效的邀請
    const again = await ctx.app.request(`/api/preview/${runId}/authorize`, {
      headers: { cookie: guest.cookie },
    });
    expect(again.status).toBe(302);
  });

  it("以 email 邀請：有設定 SMTP 時寄信；以 session 的已驗證 email 比對；名單外的人打不開", async () => {
    const created = await invite({ email: "PM@Example.com", duration: "1h" });
    expect(created.invite.email).toBe("pm@example.com");
    expect(created.emailSent).toBe(true);
    expect(mailer.sent[0]?.text).toContain(created.inviteUrl);

    const stranger = await seedSession(database.db, { email: "other@example.com" });
    expect((await open(created.inviteUrl, stranger.cookie)).headers.get("location")).toBe(
      `${PUBLIC_URL}/invites/error?code=invite_email_mismatch`,
    );
    expect(await canViewRun(database.db, ctx.clock, stranger.sessionId, runId)).toBe(false);
    const pm = await seedSession(database.db, { email: "pm@example.com" });
    expect((await open(created.inviteUrl, pm.cookie)).status).toBe(302);
    expect(await canViewRun(database.db, ctx.clock, pm.sessionId, runId)).toBe(true);

    ctx.clock.advance(60 * 60 * 1000 + 1);
    expect(await canViewRun(database.db, ctx.clock, pm.sessionId, runId)).toBe(false);
    expect((await open(created.inviteUrl, pm.cookie)).headers.get("location")).toContain(
      "code=invite_expired",
    );
  });

  it("撤銷後打不開；Preview 停止、Run 結束、Worktree 封存後全部失效", async () => {
    const created = await invite({ email: "pm@example.com" });
    const pm = await seedSession(database.db, { email: "pm@example.com" });
    const del = await as("member").delete(
      apiPath(API_ROUTES.runPreviewInvite, { runId, inviteId: created.invite.id }),
    );
    expect(del.status).toBe(204);
    expect((await open(created.inviteUrl, pm.cookie)).headers.get("location")).toContain(
      "code=invite_revoked",
    );

    const second = await invite({ email: "pm@example.com" });
    await addEvent(3, "preview_stopped", { reason: "exited", exit_code: 1, output: "" });
    expect((await open(second.inviteUrl, pm.cookie)).headers.get("location")).toContain(
      "code=invite_expired",
    );
    const listed = expectContract(PreviewInviteListResponse, (await as("member").get(list())).body);
    expect(listed.map((i) => i.status)).toEqual(["expired", "revoked"]);

    await addEvent(4, "preview_ready", { port: 41234, url: "http://localhost:41234/" });
    expect(await canViewRun(database.db, ctx.clock, pm.sessionId, runId)).toBe(true);
    const [runner] = await database.db
      .insert(runners)
      .values({
        teamId: team.teamId,
        kind: "team",
        name: "r",
        runnerVersion: "0",
        os: "windows",
        arch: "x86_64",
        tokenHash: "x",
      })
      .returning();
    const [dispatch] = await database.db
      .insert(dispatches)
      .values({
        runId,
        runnerId: runner?.id as string,
        status: "completed",
        expiresAt: new Date("2100-01-01"),
      })
      .returning();
    await database.db.insert(runControls).values({
      controlId: "0192f0c4-7b1a-7c3e-9a51-3f1d2c4b5a6e",
      runId,
      dispatchId: dispatch?.id as string,
      action: "archive",
      payload: { action: "archive" },
      outcome: "applied",
      resolvedAt: new Date(),
    });
    expect(await canViewRun(database.db, ctx.clock, pm.sessionId, runId)).toBe(false);
    await database.db.delete(runControls);
    await database.db.update(runs).set({ status: "completed" }).where(eq(runs.id, runId));
    expect(await canViewRun(database.db, ctx.clock, pm.sessionId, runId)).toBe(false);
  });

  it("Team 設定關閉時 403 preview_sharing_disabled；Viewer 不能邀請，被分享為可操作的 Viewer 可以", async () => {
    expect((await as("viewer").post(list(), { email: "a@example.com" })).status).toBe(403);
    await database.db
      .insert(taskMembers)
      .values({ taskId, memberId: team.members.viewer.id, role: "edit" });
    const created = expectContract(
      PreviewInviteCreated,
      (await as("viewer").post(list(), { email: "a@example.com" })).body,
    );
    const pm = await seedSession(database.db, { email: "a@example.com" });
    expect(await canViewRun(database.db, ctx.clock, pm.sessionId, runId)).toBe(true);

    await database.db
      .update(teams)
      .set({ allowExternalPreview: false })
      .where(eq(teams.id, team.teamId));
    // 關閉後既有的邀請全部失效，但仍然可以撤銷
    expect(await canViewRun(database.db, ctx.clock, pm.sessionId, runId)).toBe(false);
    expect((await open(created.inviteUrl, pm.cookie)).headers.get("location")).toContain(
      "code=invite_expired",
    );
    const revoke = await as("member").delete(
      apiPath(API_ROUTES.runPreviewInvite, { runId, inviteId: created.invite.id }),
    );
    expect(revoke.status).toBe(204);
    const create = await as("member").post(list(), { email: "a@example.com" });
    expect(create.status).toBe(403);
    expect(create.body).toMatchObject({ error: "preview_sharing_disabled" });
    expect((await as("member").get(list())).body).toMatchObject({
      error: "preview_sharing_disabled",
    });
  });

  it("查不到的 GitHub 帳號 422；沒有登入時轉到登入，登入後回到邀請連結", async () => {
    expect((await as("member").post(list(), { githubLogin: "nobody" })).status).toBe(422);
    const created = await invite({ githubLogin: "designer" });
    const res = await open(created.inviteUrl, null);
    const location = new URL(res.headers.get("location") as string);
    expect(location.pathname).toBe(API_ROUTES.authGithubLogin);
    expect(location.searchParams.get("returnTo")).toBe(new URL(created.inviteUrl).pathname);
  });
});
