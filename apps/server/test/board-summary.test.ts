// 看板摘要（後端缺口 `board-summary`）：每個 Task 的最新主 Run（不算 Child Run）、等待中的 Gate 與驗收進度；
// 看不到的 Task 不出現。

import { API_ROUTES, apiPath, BoardSummaryResponse } from "@orbis/api-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acceptanceCriteria, gates, type projects, runs } from "../src/db/schema";
import {
  client,
  createTestContext,
  expectContract,
  resetDatabase,
  type SeededTeam,
  seedProject,
  seedReadyTask,
  seedTeam,
  type TestContext,
} from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

describe.skipIf(dbSkipReason !== null)("看板摘要", () => {
  let database: TestDatabase;
  let ctx: TestContext;
  let team: SeededTeam;
  let project: typeof projects.$inferSelect;
  let repoId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    await resetDatabase(database.db);
    ctx = createTestContext(database.db);
    team = await seedTeam(database.db);
    ({
      project,
      repo: { id: repoId },
    } = await seedProject(database.db, team.teamId));
  });

  async function run(taskId: string, values: Partial<typeof runs.$inferInsert> = {}) {
    const [row] = await database.db
      .insert(runs)
      .values({
        taskId,
        agent: "claude-code",
        permissionPolicy: "auto",
        target: "local",
        status: "running",
        ...values,
      })
      .returning();
    if (!row) throw new Error("建立 Run 失敗");
    return row;
  }

  async function summary(role: "member" | "viewer" | "admin" = "member") {
    const res = await client(ctx.app, team.members[role].cookie).get(
      apiPath(API_ROUTES.projectBoardSummary, { projectId: project.id }),
    );
    expect(res.status).toBe(200);
    return expectContract(BoardSummaryResponse, res.body).tasks;
  }

  it("最新的主 Run 與等待中的 Gate；Child Run 不算；驗收進度含還沒判定的", async () => {
    const empty = await seedReadyTask(database.db, project, repoId);
    const task = await seedReadyTask(database.db, project, repoId);
    await database.db.insert(acceptanceCriteria).values([
      { taskId: task.id, position: 1, kind: "manual", description: "b", passed: true },
      { taskId: task.id, position: 2, kind: "manual", description: "c", passed: false },
    ]);
    await run(task.id, { status: "failed", createdAt: new Date("2026-10-20T00:00:00Z") });
    const latest = await run(task.id, {
      status: "awaiting_gate",
      agent: "codex",
      createdAt: new Date("2026-10-21T00:00:00Z"),
    });
    await run(task.id, {
      parentRunId: latest.id,
      delegationMode: "consult",
      origin: "delegation",
      createdAt: new Date("2026-10-22T00:00:00Z"),
    });
    await database.db.insert(gates).values({ taskId: task.id, runId: latest.id, kind: "review" });

    const items = await summary();
    expect(items.find((i) => i.taskId === empty.id)).toMatchObject({
      latestRun: null,
      acceptance: { passed: 0, failed: 0, total: 1 },
    });
    expect(items.find((i) => i.taskId === task.id)).toEqual({
      taskId: task.id,
      latestRun: { id: latest.id, status: "awaiting_gate", gate: "review", agent: "codex" },
      acceptance: { passed: 1, failed: 1, total: 3 },
    });
  });

  it("看不到的 Task 不出現；Admin 都看得到", async () => {
    const hidden = await seedReadyTask(database.db, project, repoId, { generalAccess: "invited" });
    await seedReadyTask(database.db, project, repoId);
    expect((await summary("member")).map((i) => i.taskId)).not.toContain(hidden.id);
    expect((await summary("admin")).map((i) => i.taskId)).toContain(hidden.id);
  });
});
