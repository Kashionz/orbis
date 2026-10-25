// 以 Orbis session 的 ID 判斷能不能查看某個 Run（preview session 定期重新確認時使用）。
// 規則和 Web 的 API 相同：session 未過期、仍是目前 Team 的 Member、Run 屬於這個 Team，
// 而且在該 Project 有 `view` 能力（含 Viewer）。

import { and, eq, gt } from "drizzle-orm";
import { authorize } from "../authz/capabilities";
import { loadRunScope } from "../authz/scope";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { members, runs, sessions } from "../db/schema";
import { ApiError } from "../http/errors";
import type { Actor } from "../http/session";
import { hasActivePreviewInvite } from "./invites";

export async function actorForSession(
  db: Database,
  clock: Clock,
  sessionId: string,
): Promise<Actor | null> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, clock.now())))
    .limit(1);
  if (!session?.currentTeamId) return null;
  const [member] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(
      and(
        eq(members.teamId, session.currentTeamId),
        eq(members.githubUserId, session.githubUserId),
      ),
    )
    .limit(1);
  if (!member) return null;
  return {
    memberId: member.id,
    teamId: session.currentTeamId,
    teamRole: member.role,
    githubUserId: session.githubUserId,
    sessionId: session.id,
  };
}

/** Actor 能不能查看這個 Run；看不到時丟出 404（和 API 相同，不透露 Run 是否存在）。 */
export async function requireRunVisible(db: Database, actor: Actor, runId: string) {
  const scope = await loadRunScope(db, actor, runId);
  const result = authorize("view", { memberId: actor.memberId, role: scope.role });
  if (!result.ok) throw new ApiError(404, "not_found", "找不到Run");
  return scope;
}

/**
 * 這個 Orbis session 能不能查看 Run 的 Preview：Team 中能查看這個 Run，或有這個 Run 有效的預覽邀請
 * （ADR-0015，受邀者可以不屬於任何 Team）。
 */
export async function canViewRun(
  db: Database,
  clock: Clock,
  sessionId: string,
  runId: string,
): Promise<boolean> {
  const actor = await actorForSession(db, clock, sessionId);
  if (actor) {
    try {
      await requireRunVisible(db, actor, runId);
      return true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  return canViewRunByInvite(db, clock, sessionId, runId);
}

/** 以預覽邀請查看：session 有效，而且有這個 Run 有效的邀請。 */
export async function canViewRunByInvite(
  db: Database,
  clock: Clock,
  sessionId: string,
  runId: string,
): Promise<boolean> {
  const now = clock.now();
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!session) return false;
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return false;
  return hasActivePreviewInvite(db, session, run, now);
}
