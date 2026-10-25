// Team 與 Member（ARCHITECTURE §4、§12.2）。
//
// Owner 規則：只有 Owner 能指派、變更或移除 Owner；Admin 管理 Admin／Member／Viewer；
// 不能移除或降級最後一位 Owner。

import {
  AddMemberInput,
  API_ROUTES,
  type Role,
  UpdateMemberInput,
  UpdateTeamInput,
} from "@orbis/api-contract";
import { and, asc, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireTeamCapability } from "../authz/scope";
import { members, teams } from "../db/schema";
import type { Executor } from "../db/tx";
import { toMember, toTeam } from "../http/dto";
import { ApiError, conflict, forbidden, notFound, readId, readJson } from "../http/errors";
import type { Actor, AppEnv } from "../http/session";
import type { Services } from "../services";

export function createTeamRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  app.get(API_ROUTES.team, auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "view");
    const [team] = await db.select().from(teams).where(eq(teams.id, actor.teamId));
    if (!team) throw notFound("Team");
    return c.json(toTeam(team));
  });

  app.patch(API_ROUTES.team, auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "manage_team");
    const input = await readJson(c, UpdateTeamInput);
    // 只寫入有送的欄位（契約保證至少一個）。
    const changes: Partial<typeof teams.$inferInsert> = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.allowExternalPreview !== undefined) {
      changes.allowExternalPreview = input.allowExternalPreview;
    }
    if (input.allowTeamRunnerTerminal !== undefined) {
      changes.allowTeamRunnerTerminal = input.allowTeamRunnerTerminal;
    }
    const [team] = await db
      .update(teams)
      .set(changes)
      .where(eq(teams.id, actor.teamId))
      .returning();
    if (!team) throw notFound("Team");
    return c.json(toTeam(team));
  });

  app.get(API_ROUTES.members, auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "view");
    const rows = await db
      .select()
      .from(members)
      .where(eq(members.teamId, actor.teamId))
      .orderBy(asc(members.createdAt), asc(members.id));
    return c.json(rows.map(toMember));
  });

  app.post(API_ROUTES.members, auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "manage_team");
    const input = await readJson(c, AddMemberInput);
    requireCanAssignRole(actor, input.role);
    const user = await s.github.userLookup.findByLogin(input.githubLogin);
    if (!user) throw notFound(`GitHub 使用者 ${input.githubLogin}`);
    const [member] = await db
      .insert(members)
      .values({
        teamId: actor.teamId,
        githubUserId: user.id,
        githubLogin: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        role: input.role,
      })
      .onConflictDoNothing()
      .returning();
    if (!member) throw conflict(`${user.login} 已經是這個 Team 的 Member`);
    return c.json(toMember(member), 201);
  });

  app.patch(API_ROUTES.member, auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "manage_team");
    const memberId = readId(c, "memberId", "Member");
    const input = await readJson(c, UpdateMemberInput);
    const updated = await db.transaction(async (tx) => {
      const target = await lockMember(tx, actor, memberId);
      requireCanAssignRole(actor, target.role);
      requireCanAssignRole(actor, input.role);
      if (target.role === "owner" && input.role !== "owner") {
        await requireAnotherOwner(tx, actor.teamId);
      }
      const [row] = await tx
        .update(members)
        .set({ role: input.role })
        .where(eq(members.id, memberId))
        .returning();
      return row;
    });
    if (!updated) throw notFound("Member");
    return c.json(toMember(updated));
  });

  app.delete(API_ROUTES.member, auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "manage_team");
    const memberId = readId(c, "memberId", "Member");
    await db.transaction(async (tx) => {
      const target = await lockMember(tx, actor, memberId);
      requireCanAssignRole(actor, target.role);
      if (target.role === "owner") await requireAnotherOwner(tx, actor.teamId);
      await tx.delete(members).where(eq(members.id, memberId));
    });
    return c.body(null, 204);
  });

  return app;
}

/** Owner 只能由 Owner 指派、變更或移除。 */
function requireCanAssignRole(actor: Actor, role: Role): void {
  if (role === "owner" && actor.teamRole !== "owner") {
    throw forbidden("只有 Owner 能指派、變更或移除 Owner");
  }
}

async function lockMember(tx: Executor, actor: Actor, memberId: string) {
  // 鎖住整個 Team 的 Owner，避免兩個請求同時移除最後兩位 Owner。
  await tx
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.teamId, actor.teamId), eq(members.role, "owner")))
    .for("update");
  const [target] = await tx
    .select()
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.teamId, actor.teamId)))
    .for("update");
  if (!target) throw notFound("Member");
  return target;
}

async function requireAnotherOwner(tx: Executor, teamId: string): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(members)
    .where(and(eq(members.teamId, teamId), eq(members.role, "owner")));
  if ((row?.n ?? 0) <= 1) {
    throw new ApiError(409, "conflict", "Team 至少要有一位 Owner");
  }
}
