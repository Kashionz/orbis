// 預覽邀請（ADR-0015、ARCHITECTURE §13）：把一個 Run 的 Preview 分享給特定的人。
//
// - Team 設定「允許對外分享預覽」打開後，對這個 Task 有操作權限（edit_task）的人可以列出、邀請與撤銷；
//   關閉時一律 403 `preview_sharing_disabled`。
// - 以 GitHub 帳號（查出 user id 保存，登入時以 id 比對）或 email（以登入者 session 的已驗證 email 比對）指定。
// - 每位受邀者各自一條連結（只存 token 的 SHA-256，連結只在建立時回傳一次），期限 1 小時／24 小時／7 天。
// - 撤銷、過期、Run 結束、Preview 停止或 Worktree 封存後無效（狀態每次查詢時計算，不寫回 DB）。

import {
  API_ROUTES,
  apiPath,
  CreatePreviewInviteInput,
  NAMES,
  PAGE_ROUTES,
  type PreviewInvite,
  type PreviewInviteCreated,
  type PreviewInviteDuration,
  type PreviewInviteStatus,
} from "@orbis/api-contract";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { Session } from "../auth/service";
import { loadRunScope, type RunScope, requireProjectCapability } from "../authz/scope";
import { randomToken, sha256Hex } from "../crypto";
import type { Database } from "../db/client";
import { members, previewInvites, runControls, runs, teams } from "../db/schema";
import type { Executor } from "../db/tx";
import { isTerminalRunStatus } from "../domain/run-status";
import { ApiError, conflict, notFound, readId, readJson } from "../http/errors";
import type { AppEnv } from "../http/session";
import { inviteErrorRedirect, inviteSession } from "../routes/invite-pages";
import type { Services } from "../services";
import { PREVIEW_CALLBACK_PATH, previewShareUrl } from "./domain";
import { loadPreviewState } from "./state";

const DURATION_MS: Record<PreviewInviteDuration, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

type InviteRow = typeof previewInvites.$inferSelect;
type RunRow = typeof runs.$inferSelect;

/** Run 的 Preview 目前能不能用邀請開：Run 還在進行、Preview 沒有停止、Worktree 沒有封存。 */
export async function previewOpenForInvites(
  db: Database,
  run: Pick<RunRow, "id" | "status" | "runnerId">,
): Promise<boolean> {
  if (isTerminalRunStatus(run.status)) return false;
  const state = await loadPreviewState(db, run, null);
  if (state.status === "stopped" || state.status === "not_configured") return false;
  const [archived] = await db
    .select({ id: runControls.controlId })
    .from(runControls)
    .where(
      and(
        eq(runControls.runId, run.id),
        eq(runControls.action, "archive"),
        eq(runControls.outcome, "applied"),
      ),
    )
    .limit(1);
  return !archived;
}

function inviteStatus(row: InviteRow, now: Date, previewOpen: boolean): PreviewInviteStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt <= now || !previewOpen) return "expired";
  return "active";
}

function toPreviewInvite(row: InviteRow, now: Date, previewOpen: boolean): PreviewInvite {
  return {
    id: row.id,
    runId: row.runId,
    githubLogin: row.githubLogin,
    githubUserId: row.githubUserId,
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
    createdByMemberId: row.createdByMemberId,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
    status: inviteStatus(row, now, previewOpen),
  };
}

/** 登入者是不是這個邀請的對象。 */
function isInvitee(row: InviteRow, session: Pick<Session, "githubUserId" | "verifiedEmail">) {
  if (row.githubUserId !== null) return row.githubUserId === session.githubUserId;
  return (
    row.email !== null && session.verifiedEmail !== null && row.email === session.verifiedEmail
  );
}

/**
 * 這個 session 能不能以預覽邀請查看 Run 的 Preview（preview session 定期重新確認時使用）。
 */
export async function hasActivePreviewInvite(
  db: Database,
  session: Pick<Session, "githubUserId" | "verifiedEmail">,
  run: Pick<RunRow, "id" | "status" | "runnerId">,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(previewInvites)
    .where(
      and(
        eq(previewInvites.runId, run.id),
        isNull(previewInvites.revokedAt),
        or(
          eq(previewInvites.githubUserId, session.githubUserId),
          session.verifiedEmail ? eq(previewInvites.email, session.verifiedEmail) : undefined,
        ),
      ),
    );
  if (!rows.some((row) => row.expiresAt > now && isInvitee(row, session))) return false;
  return previewOpenForInvites(db, run);
}

async function requireSharingEnabled(db: Executor, teamId: string): Promise<void> {
  const [team] = await db
    .select({ allowed: teams.allowExternalPreview })
    .from(teams)
    .where(eq(teams.id, teamId));
  if (!team?.allowed) {
    throw new ApiError(403, "preview_sharing_disabled", "Team 設定沒有打開對外分享預覽");
  }
}

function previewInviteMail(taskKey: string, inviterName: string, url: string) {
  const product = NAMES.productName;
  return {
    subject: `${product}：${inviterName} 分享了 ${taskKey} 的預覽／shared a preview of ${taskKey}`,
    text: [
      `${inviterName} 邀請你查看 ${product} 中 ${taskKey} 的預覽。請用 GitHub 登入後開啟以下連結：`,
      url,
      "",
      `${inviterName} invited you to view the preview of ${taskKey} in ${product}.`,
      "Sign in with GitHub and open the link above.",
    ].join("\n"),
  };
}

export function createPreviewInviteRoutes(s: Services): Hono<AppEnv> {
  const { db, auth, clock } = s;
  const app = new Hono<AppEnv>();

  async function editableScope(c: Context<AppEnv>): Promise<RunScope> {
    const actor = c.get("actor");
    const scope = await loadRunScope(db, actor, readId(c, "runId", "Run"));
    requireProjectCapability(actor, scope, "edit_task");
    await requireSharingEnabled(db, actor.teamId);
    return scope;
  }

  app.get(API_ROUTES.runPreviewInvites, auth, async (c) => {
    const scope = await editableScope(c);
    const rows = await db
      .select()
      .from(previewInvites)
      .where(eq(previewInvites.runId, scope.run.id))
      .orderBy(desc(previewInvites.createdAt), desc(previewInvites.id));
    const open = await previewOpenForInvites(db, scope.run);
    const now = clock.now();
    return c.json(rows.map((row) => toPreviewInvite(row, now, open)));
  });

  app.post(API_ROUTES.runPreviewInvites, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await editableScope(c);
    const input = await readJson(c, CreatePreviewInviteInput);
    if (!s.preview.domain) throw conflict("Server 沒有設定 Preview 網域，無法分享 Preview");
    let invitee: { githubUserId: number; githubLogin: string } | { email: string };
    if ("githubLogin" in input) {
      const user = await s.github.userLookup.findByLogin(input.githubLogin);
      if (!user)
        throw new ApiError(422, "invalid_input", `找不到 GitHub 帳號 ${input.githubLogin}`);
      invitee = { githubUserId: user.id, githubLogin: user.login };
    } else {
      invitee = { email: input.email };
    }
    const now = clock.now();
    const token = randomToken();
    const [row] = await db
      .insert(previewInvites)
      .values({
        runId: scope.run.id,
        ...invitee,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(now.getTime() + DURATION_MS[input.duration]),
        createdByMemberId: actor.memberId,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("建立預覽邀請失敗");
    const inviteUrl = `${s.publicUrl}${apiPath(PAGE_ROUTES.previewInviteAccept, { token })}`;
    let emailSent = false;
    if ("email" in invitee) {
      const [inviter] = await db.select().from(members).where(eq(members.id, actor.memberId));
      emailSent = await s.mailer.send({
        to: invitee.email,
        ...previewInviteMail(
          scope.task.key,
          inviter?.name ?? inviter?.githubLogin ?? NAMES.productName,
          inviteUrl,
        ),
      });
    }
    const open = await previewOpenForInvites(db, scope.run);
    return c.json(
      {
        invite: toPreviewInvite(row, now, open),
        inviteUrl,
        emailSent,
      } satisfies PreviewInviteCreated,
      201,
    );
  });

  app.delete(API_ROUTES.runPreviewInvite, auth, async (c) => {
    const scope = await editableScope(c);
    const inviteId = readId(c, "inviteId", "預覽邀請");
    const [row] = await db
      .update(previewInvites)
      .set({ revokedAt: clock.now() })
      .where(
        and(
          eq(previewInvites.id, inviteId),
          eq(previewInvites.runId, scope.run.id),
          isNull(previewInvites.revokedAt),
        ),
      )
      .returning();
    if (!row) throw notFound("預覽邀請");
    return c.body(null, 204);
  });

  return app;
}

/** `GET /preview-invites/<token>`：受邀者登入後換票，轉到 Preview 子網域（和 previewAuthorize 相同的流程）。 */
export async function acceptPreviewInvite(c: Context, s: Services): Promise<Response> {
  const { db, publicUrl } = s;
  const now = s.clock.now();
  const auth = await inviteSession(c, db, publicUrl, now);
  if (auth.kind === "redirect") return auth.response;
  const { session } = auth;
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");

  const [row] = await db
    .select({ invite: previewInvites, run: runs })
    .from(previewInvites)
    .innerJoin(runs, eq(runs.id, previewInvites.runId))
    .where(eq(previewInvites.tokenHash, sha256Hex(c.req.param("token") ?? "")));
  if (!row) return inviteErrorRedirect(c, publicUrl, "invite_not_found");
  const { invite, run } = row;
  if (invite.revokedAt) return inviteErrorRedirect(c, publicUrl, "invite_revoked");
  const domain = s.preview.domain;
  if (invite.expiresAt <= now || !domain || !(await previewOpenForInvites(db, run))) {
    return inviteErrorRedirect(c, publicUrl, "invite_expired");
  }
  if (!isInvitee(invite, session)) {
    return inviteErrorRedirect(c, publicUrl, "invite_email_mismatch");
  }
  await db
    .update(previewInvites)
    .set({ lastOpenedAt: now })
    .where(eq(previewInvites.id, invite.id));
  const callback = new URL(PREVIEW_CALLBACK_PATH, previewShareUrl(run.id, domain));
  callback.searchParams.set("ticket", s.preview.auth.issueTicket(run.id, session.id));
  callback.searchParams.set("return", "/");
  return c.redirect(callback.href, 302);
}
