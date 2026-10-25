// 登入：依 GitHub 身分處理 Team／Member、建立與查詢 session。

import type { MeResponse } from "@orbis/api-contract";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { randomToken, sha256Hex } from "../crypto";
import type { Database } from "../db/client";
import { members, sessions, teams } from "../db/schema";
import type { GitHubUser } from "./github-oauth";

/** session 的有效期限。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Session = typeof sessions.$inferSelect;

export interface SignInResult {
  /** 放進 cookie 的 session token（DB 只存它的雜湊）。 */
  sessionToken: string;
  session: Session;
  /** 這次登入是否以 bootstrap owner 身分建立了 Team。 */
  bootstrapped: boolean;
}

/**
 * GitHub 登入成功後呼叫：
 * - 更新這個 GitHub 帳號所有 Member 紀錄上的 login、名稱、頭像快照。
 * - 已是 Member：session 的目前 Team 設為最早加入的 Team。
 * - 不是任何 Team 的 Member，而且 GitHub user id 等於 bootstrap owner、系統中還沒有任何 Team：
 *   建立 Team（名稱為 GitHub login）並成為 Owner。
 * - 其他情況：session 沒有目前 Team，`/api/auth/me` 的 member 為 null。
 */
export async function signIn(
  db: Database,
  user: GitHubUser,
  options: { bootstrapOwnerGithubUserId: number | null; now?: Date },
): Promise<SignInResult> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    // 序列化登入，避免兩個人同時以 bootstrap owner 登入而建立出兩個 Team。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"team_bootstrap"}))`);

    await tx
      .update(members)
      // email 每次登入覆寫（沒有已驗證 email 時寫 null），Task 邀請與預覽邀請以此比對。
      .set({
        githubLogin: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        email: user.email ?? null,
      })
      .where(eq(members.githubUserId, user.id));

    const [existing] = await tx
      .select({ teamId: members.teamId })
      .from(members)
      .where(eq(members.githubUserId, user.id))
      .orderBy(asc(members.createdAt), asc(members.id))
      .limit(1);

    let currentTeamId = existing?.teamId ?? null;
    let bootstrapped = false;
    if (!currentTeamId && options.bootstrapOwnerGithubUserId === user.id) {
      const [anyTeam] = await tx.select({ id: teams.id }).from(teams).limit(1);
      if (!anyTeam) {
        const [team] = await tx.insert(teams).values({ name: user.login }).returning();
        if (!team) throw new Error("建立 Team 失敗");
        await tx.insert(members).values({
          teamId: team.id,
          githubUserId: user.id,
          githubLogin: user.login,
          name: user.name,
          avatarUrl: user.avatarUrl,
          email: user.email ?? null,
          role: "owner",
        });
        currentTeamId = team.id;
        bootstrapped = true;
      }
    }

    const sessionToken = randomToken();
    const [session] = await tx
      .insert(sessions)
      .values({
        tokenHash: sha256Hex(sessionToken),
        githubUserId: user.id,
        githubLogin: user.login,
        githubName: user.name,
        githubAvatarUrl: user.avatarUrl,
        verifiedEmail: user.email ?? null,
        currentTeamId,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      })
      .returning();
    if (!session) throw new Error("建立 session 失敗");
    return { sessionToken, session, bootstrapped };
  });
}

/** 以 cookie 中的 token 找出未過期的 session。 */
export async function findSession(
  db: Database,
  sessionToken: string,
  now: Date = new Date(),
): Promise<Session | null> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, sha256Hex(sessionToken)), gt(sessions.expiresAt, now)))
    .limit(1);
  return session ?? null;
}

export async function deleteSession(db: Database, sessionToken: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(sessionToken)));
}

/** 組出 `GET /api/auth/me` 的回應。 */
export async function buildMeResponse(db: Database, session: Session): Promise<MeResponse> {
  let member: MeResponse["member"] = null;
  if (session.currentTeamId) {
    const [row] = await db
      .select({
        id: members.id,
        teamId: members.teamId,
        teamName: teams.name,
        role: members.role,
        email: members.email,
      })
      .from(members)
      .innerJoin(teams, eq(teams.id, members.teamId))
      .where(
        and(
          eq(members.teamId, session.currentTeamId),
          eq(members.githubUserId, session.githubUserId),
        ),
      )
      .limit(1);
    member = row ?? null;
  }
  return {
    githubUserId: session.githubUserId,
    githubLogin: session.githubLogin,
    name: session.githubName,
    avatarUrl: session.githubAvatarUrl,
    member,
  };
}
