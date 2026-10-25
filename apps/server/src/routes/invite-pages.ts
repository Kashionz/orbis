// 邀請連結（PAGE_ROUTES，不在 `/api` 之下）：瀏覽器導覽，回應一律是 302。
// - `/invites/<token>`：Task 邀請（ADR-0012）。
// - `/preview-invites/<token>`：預覽邀請（ADR-0015），見 preview/invites.ts。
//
// 共通規則：沒有登入時先以 GitHub 登入、登入後回到同一個網址；登入者已驗證的 email（session 的
// verified_email）必須等於受邀的 email。失敗時轉到 Web 的 `/invites/error?code=<代碼>`。
// 在 Web 靜態檔的 SPA fallback 之前註冊（app.ts）。

import {
  API_ROUTES,
  apiPath,
  type InviteErrorCode,
  PAGE_ROUTES,
  type TaskShareRole,
} from "@orbis/api-contract";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { findSession, type Session } from "../auth/service";
import { sha256Hex } from "../crypto";
import type { Database } from "../db/client";
import { members, projects, sessions, taskInvites, taskMembers, tasks } from "../db/schema";
import { inTransaction } from "../db/tx";
import type { Services } from "../services";
import { SESSION_COOKIE } from "./auth";
import { higherTaskRole } from "./task-share";

/** 已經重新登入過一次（補上 email）的標記：避免登入者沒有已驗證 email 時一直重新登入。 */
export const RELOGIN_QUERY = "relogin";

export function inviteErrorRedirect(c: Context, publicUrl: string, code: InviteErrorCode) {
  const url = new URL(`${publicUrl}${PAGE_ROUTES.inviteError}`);
  url.searchParams.set("code", code);
  return c.redirect(url.href, 302);
}

export type InviteSessionResult =
  | { kind: "session"; session: Session }
  | { kind: "redirect"; response: Response };

/**
 * 邀請連結需要的 session：沒有登入時轉到 GitHub 登入；session 還沒有已驗證的 email（例如這個欄位加入之前
 * 登入的 session）時重新登入一次補上，已經重新登入過仍然沒有時照常回傳（由呼叫端判斷不符）。
 */
export async function inviteSession(
  c: Context,
  db: Database,
  publicUrl: string,
  now: Date,
): Promise<InviteSessionResult> {
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await findSession(db, token, now) : null;
  const relogin = c.req.query(RELOGIN_QUERY) === "1";
  if (session && (session.verifiedEmail !== null || relogin)) return { kind: "session", session };
  const back = new URL(c.req.url);
  if (session) back.searchParams.set(RELOGIN_QUERY, "1");
  const login = new URL(`${publicUrl}${API_ROUTES.authGithubLogin}`);
  login.searchParams.set("returnTo", `${back.pathname}${back.search}`);
  c.header("cache-control", "no-store");
  return { kind: "redirect", response: c.redirect(login.href, 302) };
}

export interface InvitePageDeps {
  db: Database;
  publicUrl: string;
  now: () => Date;
}

/** `GET /invites/<token>`：接受 Task 邀請。 */
export async function acceptTaskInvite(c: Context, deps: InvitePageDeps): Promise<Response> {
  const { db, publicUrl } = deps;
  const now = deps.now();
  const auth = await inviteSession(c, db, publicUrl, now);
  if (auth.kind === "redirect") return auth.response;
  const { session } = auth;
  // token 在網址中：不要被快取，也不要以 Referer 帶到其他網站
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");

  const [row] = await db
    .select({ invite: taskInvites, task: tasks, teamId: projects.teamId })
    .from(taskInvites)
    .innerJoin(tasks, eq(tasks.id, taskInvites.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(taskInvites.tokenHash, sha256Hex(c.req.param("token") ?? "")));
  if (!row) return inviteErrorRedirect(c, publicUrl, "invite_not_found");
  const { invite, task, teamId } = row;
  const taskUrl = `${publicUrl}/tasks/${encodeURIComponent(task.key)}`;

  if (invite.acceptedAt) {
    // 接受過的連結：接受的人再開一次就直接到 Task；其他人當作找不到。
    const [accepter] = invite.acceptedByMemberId
      ? await db
          .select({ githubUserId: members.githubUserId })
          .from(members)
          .where(eq(members.id, invite.acceptedByMemberId))
      : [];
    if (accepter?.githubUserId !== session.githubUserId) {
      return inviteErrorRedirect(c, publicUrl, "invite_not_found");
    }
    await switchTeam(db, session.id, teamId);
    return c.redirect(taskUrl, 302);
  }
  if (invite.revokedAt) return inviteErrorRedirect(c, publicUrl, "invite_revoked");
  if (invite.expiresAt <= now) return inviteErrorRedirect(c, publicUrl, "invite_expired");
  if (session.verifiedEmail === null || session.verifiedEmail !== invite.email) {
    return inviteErrorRedirect(c, publicUrl, "invite_email_mismatch");
  }

  const accepted = await inTransaction(db, async ({ tx }) => {
    const [locked] = await tx
      .select()
      .from(taskInvites)
      .where(eq(taskInvites.id, invite.id))
      .for("update");
    if (!locked || locked.acceptedAt || locked.revokedAt) return false;
    // 還不是這個 Team 的 Member 時以 Viewer 身分加入（ADR-0012）。
    await tx
      .insert(members)
      .values({
        teamId,
        githubUserId: session.githubUserId,
        githubLogin: session.githubLogin,
        name: session.githubName,
        avatarUrl: session.githubAvatarUrl,
        email: session.verifiedEmail,
        role: "viewer",
      })
      .onConflictDoNothing();
    const [member] = await tx
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.teamId, teamId), eq(members.githubUserId, session.githubUserId)));
    if (!member) throw new Error("加入 Team 失敗");
    const [current] = await tx
      .select({ role: taskMembers.role })
      .from(taskMembers)
      .where(and(eq(taskMembers.taskId, task.id), eq(taskMembers.memberId, member.id)));
    const role = higherTaskRole(current?.role ?? null, invite.role as TaskShareRole);
    await tx
      .insert(taskMembers)
      .values({ taskId: task.id, memberId: member.id, role })
      .onConflictDoUpdate({
        target: [taskMembers.taskId, taskMembers.memberId],
        set: { role, updatedAt: now },
      });
    await tx
      .update(taskInvites)
      .set({ acceptedAt: now, acceptedByMemberId: member.id })
      .where(eq(taskInvites.id, invite.id));
    await tx.update(sessions).set({ currentTeamId: teamId }).where(eq(sessions.id, session.id));
    return true;
  });
  if (!accepted) return inviteErrorRedirect(c, publicUrl, "invite_not_found");
  return c.redirect(taskUrl, 302);
}

/** session 目前所在的 Team 改成邀請的 Team（登入者是多個 Team 的 Member 時）。 */
async function switchTeam(db: Database, sessionId: string, teamId: string): Promise<void> {
  await db.update(sessions).set({ currentTeamId: teamId }).where(eq(sessions.id, sessionId));
}

/** 邀請連結的路由（不需要 `services.auth`：沒有 Team 的人也要能進來）。 */
export function createInvitePageRoutes(s: Services): Hono {
  const app = new Hono();
  const deps: InvitePageDeps = { db: s.db, publicUrl: s.publicUrl, now: () => s.clock.now() };
  app.get(PAGE_ROUTES.inviteAccept, (c) => acceptTaskInvite(c, deps));
  return app;
}

/** 邀請連結的完整網址（信件與 API 回應中使用）。 */
export function taskInviteUrl(publicUrl: string, token: string): string {
  return `${publicUrl}${apiPath(PAGE_ROUTES.inviteAccept, { token })}`;
}
