// 並行與佇列（ARCHITECTURE §7）：Credential 的並行上限（預設 30）、Admin 的覆寫、rate limit 期間不派工。

import { CredentialListResponse, TeamRunnerQueueResponse } from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentAvailabilities, runnerCredentials } from "../src/db/schema";
import {
  credentialCapacity,
  DEFAULT_CREDENTIAL_CONCURRENCY,
  effectiveMaxConcurrency,
} from "../src/runner/capacity";
import { expectContract, resetDatabase, seedReadyTask } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import { type Flow, runRow, startFlow } from "./helpers/flow";
import { type MockRunner, waitUntil } from "./helpers/runner-harness";

const now = new Date("2026-10-23T08:00:00Z");

describe("Credential 的並行上限", () => {
  it("有效上限＝Admin 的覆寫 ?? Runner 回報 ?? 預設 30", () => {
    expect(DEFAULT_CREDENTIAL_CONCURRENCY).toBe(30);
    expect(effectiveMaxConcurrency(5, 30)).toBe(5);
    expect(effectiveMaxConcurrency(null, 12)).toBe(12);
    expect(effectiveMaxConcurrency(null, null)).toBe(30);
  });

  it("進行中的 Run 達到上限時排隊", () => {
    const load = { maxConcurrency: 2, rateLimitedUntil: null };
    expect(credentialCapacity({ ...load, active: 1 }, now)).toEqual({ ok: true });
    expect(credentialCapacity({ ...load, active: 2 }, now)).toEqual({
      ok: false,
      reason: "concurrency_limit",
    });
  });

  it("rate limit 恢復前不派新的 Run，恢復後照常", () => {
    const limited = {
      maxConcurrency: 30,
      active: 0,
      rateLimitedUntil: new Date("2026-10-23T08:05:00Z"),
    };
    expect(credentialCapacity(limited, now)).toEqual({ ok: false, reason: "rate_limited" });
    expect(credentialCapacity(limited, new Date("2026-10-23T08:05:00Z"))).toEqual({ ok: true });
  });
});

describe.skipIf(dbSkipReason !== null)("並行佇列（Team Runner）", () => {
  let database: TestDatabase;
  let flow: Flow;
  let runner: MockRunner;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    flow = await startFlow(database.db);
    runner = await flow.h.pairRunner(flow.team.members.admin, "team");
    // 這台 Team Runner 的 Credential `default` 回報並行上限 2。
    runner.send({
      type: "agent_availability",
      agents: [
        {
          id: "claude-code",
          version: "1.0.0",
          available: true,
          unavailable_reason: null,
          capabilities: ["load_session"],
          models: [],
          permission_gaps: [],
          credential: "default",
          display_name: "Claude Code",
          vendor: null,
          cli: null,
          signed_in: null,
          login_hint: null,
        },
      ],
      credentials: [{ label: "default", max_concurrent_runs: 2, active_runs: 0 }],
      mapped_repos: [],
    });
    await waitUntil(async () => {
      const [row] = await database.db
        .select()
        .from(agentAvailabilities)
        .where(eq(agentAvailabilities.runnerId, runner.runnerId));
      return row?.maxConcurrency === 2;
    });
  });

  afterEach(async () => {
    await flow.close();
  });

  /** 派一個 Team Runner 的 Run，回傳 Run id。 */
  async function dispatchTeamRun() {
    const task = await seedReadyTask(database.db, flow.project, flow.repoId);
    const res = await flow.as("member").post<{ id: string }>(`/api/tasks/${task.id}/runs`, {
      agent: "claude-code",
      runnerKind: "team",
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  const kick = () => flow.h.ctx.services.dispatcher.kick();
  const credentials = async () =>
    expectContract(CredentialListResponse, (await flow.as("member").get("/api/credentials")).body);
  const queue = async () =>
    expectContract(
      TeamRunnerQueueResponse,
      (await flow.as("member").get("/api/team-runner-queue")).body,
    );

  it("進行中的 Run 達到 Credential 的上限時排隊；Offer 帶選定的 Credential", async () => {
    const first = await dispatchTeamRun();
    const second = await dispatchTeamRun();
    const third = await dispatchTeamRun();
    await kick();
    const offer = await runner.next("dispatch_offer", (o) => o.run_id === first);
    expect(offer.credential).toBe("default");
    await runner.next("dispatch_offer", (o) => o.run_id === second);
    expect((await runRow(database.db, third))?.status).toBe("queued");
    expect((await runRow(database.db, first))?.credential).toBe("default");

    expect(await credentials()).toMatchObject([
      {
        runnerId: runner.runnerId,
        runnerKind: "team",
        online: true,
        credential: "default",
        agents: ["claude-code"],
        reportedMaxConcurrentRuns: 2,
        maxConcurrentRunsOverride: null,
        maxConcurrentRuns: 2,
        activeRuns: 2,
        queuedRuns: 1,
        rateLimitedUntil: null,
      },
    ]);
    expect(await queue()).toMatchObject([
      { runId: third, position: 1, waitingReason: "concurrency_limit" },
    ]);
  });

  it("Admin 覆寫並行上限後，排隊的 Run 接著派出；Member 不能覆寫", async () => {
    await dispatchTeamRun();
    await dispatchTeamRun();
    const third = await dispatchTeamRun();
    await kick();
    expect((await runRow(database.db, third))?.status).toBe("queued");
    const path = `/api/runners/${runner.runnerId}/credentials/default`;
    expect((await flow.as("member").patch(path, { maxConcurrentRuns: 3 })).status).toBe(403);
    expect((await flow.as("admin").patch(path, { maxConcurrentRuns: 3 })).status).toBe(204);
    await kick();
    await runner.next("dispatch_offer", (o) => o.run_id === third);
    expect((await credentials())[0]).toMatchObject({
      maxConcurrentRunsOverride: 3,
      maxConcurrentRuns: 3,
      activeRuns: 3,
    });
    expect((await flow.as("admin").patch(path, { maxConcurrentRuns: null })).status).toBe(204);
    expect((await credentials())[0]?.maxConcurrentRuns).toBe(2);
    expect(
      (
        await flow.as("admin").patch(`/api/runners/${runner.runnerId}/credentials/none`, {
          maxConcurrentRuns: 3,
        })
      ).status,
    ).toBe(404);
  });

  it("rate limit：恢復前不派新的 Run（不改用其他 Agent），恢復後照常派工", async () => {
    const first = await dispatchTeamRun();
    await kick();
    const offer = await runner.next("dispatch_offer", (o) => o.run_id === first);
    runner.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
    await waitUntil(async () => (await runRow(database.db, first))?.status === "starting");
    const resetsAt = new Date(flow.h.ctx.clock.now().getTime() + 10 * 60_000);
    await runner.eventAcked(offer.dispatch_id, first, {
      kind: "rate_limited",
      resets_at: resetsAt.toISOString(),
      message: "usage limit reached",
    });
    const second = await dispatchTeamRun();
    await kick();
    expect((await runRow(database.db, second))?.status).toBe("queued");
    expect((await credentials())[0]?.rateLimitedUntil).toBe(resetsAt.toISOString());
    expect(await queue()).toMatchObject([{ runId: second, waitingReason: "rate_limited" }]);

    // 額度恢復（推進時鐘會讓 Runner 被判定心跳逾時，所以直接把恢復時間改成過去）。
    await database.db
      .update(runnerCredentials)
      .set({ rateLimitedUntil: new Date(flow.h.ctx.clock.now().getTime() - 1000) });
    await kick();
    await runner.next("dispatch_offer", (o) => o.run_id === second);
  });

  it("Member 只看得到 Team Runner 與自己的 Local Runner 的 Credential", async () => {
    await flow.h.pairRunner(flow.team.members.owner, "local");
    const own = await flow.h.pairRunner(flow.team.members.member, "local");
    const visible = (await credentials()).map((c) => c.runnerId).sort();
    expect(visible).toEqual([runner.runnerId, own.runnerId].sort());
    const all = expectContract(
      CredentialListResponse,
      (await flow.as("admin").get("/api/credentials")).body,
    );
    expect(all).toHaveLength(3);
  });

  it("沒有在線的 Runner 時，佇列顯示等待 Runner", async () => {
    runner.close();
    await waitUntil(() => !flow.h.ctx.services.hub.isOnline(runner.runnerId));
    const id = await dispatchTeamRun();
    expect(await queue()).toMatchObject([{ runId: id, waitingReason: "no_runner" }]);
    expect((await flow.as("viewer").get("/api/team-runner-queue")).status).toBe(403);
  });
});
