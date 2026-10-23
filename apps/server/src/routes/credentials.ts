// Credential 的並行與用量、Team Runner 的佇列（ARCHITECTURE §7、§12.2）。
//
// - 查詢：Member 以上（Team 層級的 Role）。
// - 覆寫並行上限：Admin 以上。有效上限＝覆寫 ?? Runner 回報（預設 30）。

import {
  API_ROUTES,
  type CredentialListResponse,
  type TeamRunnerQueueResponse,
  UpdateRunnerCredentialInput,
} from "@orbis/api-contract";
import { and, asc, eq, gte, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { authorize, roleAtLeast } from "../authz/capabilities";
import { requireTeamCapability } from "../authz/scope";
import {
  agentAvailabilities,
  projects,
  runnerCredentials,
  runners,
  runs,
  tasks,
} from "../db/schema";
import { forbidden, notFound, readJson } from "../http/errors";
import type { AppEnv } from "../http/session";
import { effectiveMaxConcurrency } from "../runner/capacity";
import { credentialLoad } from "../runner/dispatcher";
import type { Services } from "../services";

const DAY_MS = 24 * 60 * 60 * 1000;

export function createCredentialRoutes(s: Services): Hono<AppEnv> {
  const { db, auth } = s;
  const app = new Hono<AppEnv>();

  const requireMember = (role: Parameters<typeof roleAtLeast>[0]) => {
    if (!roleAtLeast(role, "member")) throw forbidden("需要 member 以上的 Role");
  };

  app.get(API_ROUTES.credentials, auth, async (c) => {
    const actor = c.get("actor");
    requireMember(actor.teamRole);
    const seeAll = authorize("manage_team", { memberId: actor.memberId, role: actor.teamRole }).ok;
    const rows = await db
      .select({ runner: runners, availability: agentAvailabilities })
      .from(agentAvailabilities)
      .innerJoin(runners, eq(runners.id, agentAvailabilities.runnerId))
      .where(
        and(
          eq(runners.teamId, actor.teamId),
          isNull(runners.revokedAt),
          // 與 Runner 清單相同：Admin 以上看得到全部，其他人只看得到 Team Runner 與自己的 Local Runner。
          seeAll ? undefined : or(eq(runners.kind, "team"), eq(runners.memberId, actor.memberId)),
        ),
      )
      .orderBy(asc(runners.createdAt), asc(agentAvailabilities.credential));
    const now = s.clock.now();
    const groups = new Map<
      string,
      {
        runner: (typeof rows)[number]["runner"];
        credential: string;
        reported: number;
        agents: string[];
      }
    >();
    for (const { runner, availability } of rows) {
      // 沒有 Credential 的 Agent 不會出現在任何一組中。
      if (availability.credential === "") continue;
      const key = `${runner.id}\u0000${availability.credential}`;
      const group = groups.get(key) ?? {
        runner,
        credential: availability.credential,
        reported: availability.maxConcurrency,
        agents: [],
      };
      group.agents.push(availability.agent);
      groups.set(key, group);
    }
    // Team 中排隊、而且是因為 Credential 的上限或 rate limit 而等待的 Run。
    const queuedRows = await db
      .select({ run: runs })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(projects.teamId, actor.teamId), eq(runs.status, "queued")));
    const waitingForCredential: (typeof queuedRows)[number]["run"][] = [];
    for (const { run } of queuedRows) {
      const placement = await s.dispatcher.placement(run, now);
      if (
        "reason" in placement &&
        (placement.reason === "concurrency_limit" || placement.reason === "rate_limited")
      ) {
        waitingForCredential.push(run);
      }
    }
    const response: CredentialListResponse = [];
    for (const { runner, credential, reported, agents } of groups.values()) {
      const load = await credentialLoad(db, runner.id, credential, reported);
      const [settings] = await db
        .select()
        .from(runnerCredentials)
        .where(
          and(
            eq(runnerCredentials.runnerId, runner.id),
            eq(runnerCredentials.credential, credential),
          ),
        );
      const waiting = waitingForCredential.filter(
        (run) =>
          agents.includes(run.agent) &&
          run.target === runner.kind &&
          (runner.kind === "team" || run.requestedByMemberId === runner.memberId),
      ).length;
      const recent = await db
        .select({ usage: runs.usage })
        .from(runs)
        .where(
          and(
            eq(runs.runnerId, runner.id),
            eq(runs.credential, credential),
            gte(runs.createdAt, new Date(now.getTime() - DAY_MS)),
          ),
        );
      response.push({
        runnerId: runner.id,
        runnerName: runner.name,
        runnerKind: runner.kind,
        online: s.hub.isOnline(runner.id),
        credential,
        agents,
        reportedMaxConcurrentRuns: reported,
        maxConcurrentRunsOverride: settings?.maxConcurrentRunsOverride ?? null,
        maxConcurrentRuns: effectiveMaxConcurrency(settings?.maxConcurrentRunsOverride, reported),
        activeRuns: load.active,
        queuedRuns: waiting,
        rateLimitedUntil:
          load.rateLimitedUntil && load.rateLimitedUntil > now
            ? load.rateLimitedUntil.toISOString()
            : null,
        usage24h: sumUsage(recent.map((r) => r.usage)),
      });
    }
    return c.json(response);
  });

  app.patch(API_ROUTES.runnerCredential, auth, async (c) => {
    const actor = c.get("actor");
    requireTeamCapability(actor, "manage_team");
    const runnerId = c.req.param("runnerId") ?? "";
    const credential = decodeURIComponent(c.req.param("credential") ?? "");
    const [runner] = await db
      .select({ id: runners.id })
      .from(runners)
      .innerJoin(agentAvailabilities, eq(agentAvailabilities.runnerId, runners.id))
      .where(
        and(
          eq(runners.id, runnerId),
          eq(runners.teamId, actor.teamId),
          eq(agentAvailabilities.credential, credential),
        ),
      )
      .limit(1);
    if (!runner || credential === "") throw notFound("Credential");
    const input = await readJson(c, UpdateRunnerCredentialInput);
    await db
      .insert(runnerCredentials)
      .values({ runnerId, credential, maxConcurrentRunsOverride: input.maxConcurrentRuns })
      .onConflictDoUpdate({
        target: [runnerCredentials.runnerId, runnerCredentials.credential],
        set: { maxConcurrentRunsOverride: input.maxConcurrentRuns, updatedAt: s.clock.now() },
      });
    // 上限提高時，排隊中的 Run 可能可以派了。
    void s.dispatcher.kick();
    return c.body(null, 204);
  });

  app.get(API_ROUTES.teamRunnerQueue, auth, async (c) => {
    const actor = c.get("actor");
    requireMember(actor.teamRole);
    const rows = await db
      .select({ run: runs, taskKey: tasks.key })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(eq(projects.teamId, actor.teamId), eq(runs.target, "team"), eq(runs.status, "queued")),
      )
      .orderBy(asc(runs.createdAt), asc(runs.id));
    const now = s.clock.now();
    const response: TeamRunnerQueueResponse = [];
    for (const [index, { run, taskKey }] of rows.entries()) {
      const placement = await s.dispatcher.placement(run, now);
      response.push({
        runId: run.id,
        taskId: run.taskId,
        taskKey,
        agent: run.agent,
        credential: run.credential,
        position: index + 1,
        // 剛好有空位、下一輪就會派出的 Run 視為還在等 Runner。
        waitingReason: "reason" in placement ? placement.reason : "no_runner",
        queuedAt: run.createdAt.toISOString(),
      });
    }
    return c.json(response);
  });

  return app;
}

/** 多個 Run 的累計用量；沒有任何 Run 回報的項目為 null。 */
function sumUsage(usages: unknown[]): CredentialListResponse[number]["usage24h"] {
  let input: number | null = null;
  let output: number | null = null;
  let cost = null as { amount: number; currency: string } | null;
  for (const raw of usages) {
    const u = raw as {
      inputTokens?: number | null;
      outputTokens?: number | null;
      cost?: { amount: number; currency: string } | null;
    };
    if (typeof u.inputTokens === "number") input = (input ?? 0) + u.inputTokens;
    if (typeof u.outputTokens === "number") output = (output ?? 0) + u.outputTokens;
    // 幣別不同的費用無法相加，只累計第一個幣別。
    if (u.cost && (cost === null || cost.currency === u.cost.currency)) {
      cost = { amount: (cost?.amount ?? 0) + u.cost.amount, currency: u.cost.currency };
    }
  }
  return { runs: usages.length, inputTokens: input, outputTokens: output, cost };
}
