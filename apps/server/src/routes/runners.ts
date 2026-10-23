// Runner 與 Pairing token（ARCHITECTURE §6.1、§12.2）。
//
// - Local Runner 的 Pairing token：Member 以上，綁定呼叫者本人（Electron 登入後呼叫）。
// - Team Runner 的 Pairing token：Admin 以上。
// - 撤銷：本人的 Local Runner，或 Admin 撤銷 Team 中任何 Runner。撤銷後立刻斷線，進行中的 Run 回到佇列。
//   以 session cookie 認證，Desktop 也用同一個端點。
// - Local Runner 的 Pairing token 記下建立它的 session；Pairing 時複製到 Runner，登出時一併撤銷。

import { API_ROUTES, CreatePairingTokenInput, type Runner } from "@orbis/api-contract";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { authorize } from "../authz/capabilities";
import { requireTeamCapability } from "../authz/scope";
import { agentAvailabilities, runners } from "../db/schema";
import { conflict, forbidden, notFound, readId, readJson } from "../http/errors";
import type { AppEnv } from "../http/session";
import { revokeRunner } from "../runner/revoke";
import { createPairingToken } from "../runner/service";
import type { Services } from "../services";

export function createRunnerRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  /** Team Runner 與自己的 Local Runner；Admin 以上可以看到所有 Local Runner。 */
  app.get(API_ROUTES.runners, auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "view");
    const seeAll = authorize("manage_team", { memberId: actor.memberId, role: actor.teamRole }).ok;
    const rows = await db
      .select()
      .from(runners)
      .where(
        and(
          eq(runners.teamId, actor.teamId),
          isNull(runners.revokedAt),
          seeAll ? undefined : or(eq(runners.kind, "team"), eq(runners.memberId, actor.memberId)),
        ),
      )
      .orderBy(asc(runners.createdAt), asc(runners.id));
    const availability =
      rows.length > 0
        ? await db
            .select()
            .from(agentAvailabilities)
            .where(
              inArray(
                agentAvailabilities.runnerId,
                rows.map((r) => r.id),
              ),
            )
            .orderBy(asc(agentAvailabilities.agent))
        : [];
    return c.json(
      rows.map(
        (row): Runner => ({
          id: row.id,
          teamId: row.teamId,
          kind: row.kind,
          memberId: row.memberId,
          name: row.name,
          runnerVersion: row.runnerVersion,
          os: row.os,
          arch: row.arch,
          online: s.hub.isOnline(row.id),
          acceptingDispatches: s.hub.isAcceptingDispatches(row.id),
          lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
          agents: availability
            .filter((a) => a.runnerId === row.id)
            .map((a) => ({
              agent: a.agent,
              // DB 以空字串表示「沒有 Credential」（唯一鍵不能有 null）；API 一律是 null。
              credential: a.credential === "" ? null : a.credential,
              available: a.available,
              maxConcurrency: a.maxConcurrency,
              details: (a.details as Record<string, unknown> | null) ?? null,
            })),
          createdAt: row.createdAt.toISOString(),
        }),
      ),
    );
  });

  app.delete(API_ROUTES.runner, auth, async (c) => {
    const actor = c.get("actor");
    const runnerId = readId(c, "runnerId", "Runner");
    const [runner] = await db
      .select()
      .from(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.teamId, actor.teamId)));
    if (!runner) throw notFound("Runner");
    const own = runner.kind === "local" && runner.memberId === actor.memberId;
    if (!own) requireTeamCapability(actor, "manage_team");
    if (runner.revokedAt) throw conflict("Runner 已經撤銷");
    await revokeRunner(s, runner.id);
    return c.body(null, 204);
  });

  app.post(API_ROUTES.pairingTokens, auth, async (c) => {
    const actor = c.get("actor");
    const input = await readJson(c, CreatePairingTokenInput);
    if (input.kind === "team") requireTeamCapability(actor, "manage_team");
    else {
      const result = authorize("dispatch_local", {
        memberId: actor.memberId,
        role: actor.teamRole,
      });
      if (!result.ok) throw forbidden(result.reason);
    }
    const created = await createPairingToken(db, {
      teamId: actor.teamId,
      kind: input.kind,
      createdByMemberId: actor.memberId,
      createdBySessionId: actor.sessionId,
      now: s.clock.now(),
    });
    return c.json(
      {
        id: created.id,
        kind: input.kind,
        token: created.token,
        expiresAt: created.expiresAt.toISOString(),
      },
      201,
    );
  });

  return app;
}
