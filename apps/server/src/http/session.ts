// 登入狀態的 middleware：cookie → session → 目前 Team 的 Member（Actor）。

import type { Role } from "@orbis/api-contract";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { findSession } from "../auth/service";
import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { members } from "../db/schema";
import { SESSION_COOKIE } from "../routes/auth";
import { ApiError } from "./errors";

/** 發出請求的 Member。API 一律以 session 的目前 Team 為範圍。 */
export interface Actor {
  memberId: string;
  teamId: string;
  /** Team 層級的 Role；Project 層級的判斷要再套用覆寫（authz/effectiveRole）。 */
  teamRole: Role;
  githubUserId: number;
  sessionId: string;
}

export interface AppEnv {
  Variables: { actor: Actor };
}

/** 要求已登入、而且是目前 Team 的 Member。 */
export function requireActor(db: Database, clock: Clock): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await findSession(db, token, clock.now()) : null;
    if (!session) throw new ApiError(401, "unauthorized", "尚未登入");
    if (!session.currentTeamId) {
      throw new ApiError(403, "no_team", "還不是任何 Team 的 Member");
    }
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
    if (!member) throw new ApiError(403, "no_team", "已不是這個 Team 的 Member");
    c.set("actor", {
      memberId: member.id,
      teamId: session.currentTeamId,
      teamRole: member.role,
      githubUserId: session.githubUserId,
      sessionId: session.id,
    });
    await next();
  };
}
