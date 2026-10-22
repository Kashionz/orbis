// contract/db：W2–4 分軌新增的表與欄位（review_comments、run_controls、GitHub 對應、
// Task 的關閉原因、Pairing 與 session 的關聯等）。

import { NAMES } from "@orbis/api-contract";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client";
import {
  dispatches,
  gates,
  githubWebhookDeliveries,
  members,
  projects,
  pullRequests,
  repos,
  reviewComments,
  runControls,
  runnerPairingTokens,
  runners,
  runs,
  sessions,
  taskIssueLinks,
  tasks,
  teams,
} from "../../src/db/schema";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "../helpers/db";

const PG = { uniqueViolation: "23505", checkViolation: "23514" };

async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `預期失敗並得到 ${code}`).not.toBeNull();
  const pgError = (error as { cause?: { code?: string } }).cause ?? error;
  expect((pgError as { code?: string }).code).toBe(code);
}

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("沒有回傳資料");
  return row;
}

describe.skipIf(dbSkipReason !== null)("資料庫 schema：W2–4 契約", () => {
  let database: TestDatabase;
  let db: Database;
  let seq = 0;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
  });

  afterAll(async () => {
    await database?.drop();
  });

  /** 建立 Team → Member → Project → Repo → Task → Run → Runner → Dispatch。 */
  async function chain() {
    seq += 1;
    const team = one(
      await db
        .insert(teams)
        .values({ name: `w2-${seq}` })
        .returning(),
    );
    const member = one(
      await db
        .insert(members)
        .values({
          teamId: team.id,
          githubUserId: 5000 + seq,
          githubLogin: `dev${seq}`,
          role: "member",
        })
        .returning(),
    );
    const project = one(
      await db
        .insert(projects)
        .values({ teamId: team.id, name: `p${seq}`, taskKeyPrefix: `W${seq}` })
        .returning(),
    );
    const repo = one(
      await db
        .insert(repos)
        .values({ projectId: project.id, githubOwner: "Kashionz", githubName: `repo${seq}` })
        .returning(),
    );
    const task = one(
      await db
        .insert(tasks)
        .values({
          projectId: project.id,
          number: 1,
          key: `W${seq}-1`,
          repoId: repo.id,
          title: "W2 測試",
          assigneeMemberId: member.id,
        })
        .returning(),
    );
    const run = one(
      await db
        .insert(runs)
        .values({
          taskId: task.id,
          agent: "claude-code",
          permissionPolicy: "auto",
          target: "local",
        })
        .returning(),
    );
    const session = one(
      await db
        .insert(sessions)
        .values({
          tokenHash: `session-${seq}`,
          githubUserId: member.githubUserId,
          githubLogin: member.githubLogin,
          currentTeamId: team.id,
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning(),
    );
    const runner = one(
      await db
        .insert(runners)
        .values({
          teamId: team.id,
          memberId: member.id,
          kind: "local",
          name: "laptop",
          runnerVersion: "0.1.0",
          os: "windows",
          arch: "x86_64",
          tokenHash: `runner-${seq}`,
          pairedSessionId: session.id,
        })
        .returning(),
    );
    const dispatch = one(
      await db
        .insert(dispatches)
        .values({ runId: run.id, runnerId: runner.id, expiresAt: new Date(Date.now() + 30_000) })
        .returning(),
    );
    return { team, member, project, repo, task, run, session, runner, dispatch };
  }

  it("Project 預設自動建立 Issue；Repo 可以記錄 GitHub App 的 installation id", async () => {
    const { project, repo } = await chain();
    expect(project.autoCreateIssues).toBe(true);
    expect(repo.githubInstallationId).toBeNull();
    const [updated] = await db
      .update(repos)
      .set({ githubInstallationId: 123456 })
      .where(eq(repos.id, repo.id))
      .returning();
    expect(updated?.githubInstallationId).toBe(123456);
  });

  it("Task 的關閉原因只能在 Done 時設定", async () => {
    const { task } = await chain();
    await expectPgError(
      db.update(tasks).set({ doneReason: "not_planned" }).where(eq(tasks.id, task.id)),
      PG.checkViolation,
    );
    const [done] = await db
      .update(tasks)
      .set({ status: "done", doneReason: "not_planned" })
      .where(eq(tasks.id, task.id))
      .returning();
    expect(done?.doneReason).toBe("not_planned");
  });

  it("行內留言存在獨立的表，Gate 刪除時一併刪除，行號從 1 開始", async () => {
    const { task, run, member } = await chain();
    const gate = one(
      await db
        .insert(gates)
        .values({
          taskId: task.id,
          runId: run.id,
          kind: "review",
          assigneeMemberIdAtCreation: member.id,
        })
        .returning(),
    );
    expect(gate.assigneeMemberIdAtCreation).toBe(member.id);
    await db.insert(reviewComments).values([
      {
        gateId: gate.id,
        path: "src/a.ts",
        line: 3,
        side: "new",
        body: "這裡要處理空值",
        authorMemberId: member.id,
      },
      { gateId: gate.id, path: "src/a.ts", line: 1, side: "old", body: "原本的寫法比較好" },
    ]);
    await expectPgError(
      db
        .insert(reviewComments)
        .values({ gateId: gate.id, path: "x", line: 0, side: "new", body: "x" }),
      PG.checkViolation,
    );
    expect(
      await db.select().from(reviewComments).where(eq(reviewComments.gateId, gate.id)),
    ).toHaveLength(2);
    await db.delete(gates).where(eq(gates.id, gate.id));
    expect(
      await db.select().from(reviewComments).where(eq(reviewComments.gateId, gate.id)),
    ).toHaveLength(0);
  });

  it("Gate 建立時的指派對象在 Member 刪除時設為 null", async () => {
    const { task, member } = await chain();
    const gate = one(
      await db
        .insert(gates)
        .values({ taskId: task.id, kind: "review", assigneeMemberIdAtCreation: member.id })
        .returning(),
    );
    await db.update(tasks).set({ assigneeMemberId: null }).where(eq(tasks.id, task.id));
    await db.delete(members).where(eq(members.id, member.id));
    const [after] = await db.select().from(gates).where(eq(gates.id, gate.id));
    expect(after?.assigneeMemberIdAtCreation).toBeNull();
  });

  it("RunControl 的結果與結束時間必須同時有值或同時為 null", async () => {
    const { run, dispatch } = await chain();
    const controlId = crypto.randomUUID();
    await db.insert(runControls).values({
      controlId,
      runId: run.id,
      dispatchId: dispatch.id,
      action: "push_branch",
      payload: { action: "push_branch" },
    });
    await expectPgError(
      db
        .update(runControls)
        .set({ outcome: "applied" })
        .where(eq(runControls.controlId, controlId)),
      PG.checkViolation,
    );
    const [resolved] = await db
      .update(runControls)
      .set({
        outcome: "branch_pushed",
        outcomePayload: { branch: `${NAMES.branchPrefix}W-1-x`, commit_sha: "a".repeat(40) },
        resolvedAt: new Date(),
      })
      .where(eq(runControls.controlId, controlId))
      .returning();
    expect(resolved?.outcome).toBe("branch_pushed");
  });

  it("Pairing 記下 session；session 刪除時 Runner 與 Pairing token 的關聯設為 null", async () => {
    const { team, member, session, runner } = await chain();
    const token = one(
      await db
        .insert(runnerPairingTokens)
        .values({
          teamId: team.id,
          memberId: member.id,
          kind: "local",
          tokenHash: `pairing-${seq}`,
          createdBySessionId: session.id,
          usedByRunnerId: runner.id,
        })
        .returning(),
    );
    const paired = await db.select().from(runners).where(eq(runners.pairedSessionId, session.id));
    expect(paired.map((r) => r.id)).toEqual([runner.id]);

    await db.delete(sessions).where(eq(sessions.id, session.id));
    const [runnerAfter] = await db.select().from(runners).where(eq(runners.id, runner.id));
    const [tokenAfter] = await db
      .select()
      .from(runnerPairingTokens)
      .where(eq(runnerPairingTokens.id, token.id));
    expect(runnerAfter?.pairedSessionId).toBeNull();
    expect(tokenAfter?.createdBySessionId).toBeNull();
  });

  it("GitHub 的 Issue 對應、webhook delivery 與 PR 對應", async () => {
    const { task, run, repo } = await chain();
    await db.insert(taskIssueLinks).values({
      taskId: task.id,
      repoId: repo.id,
      githubRepoId: 9001,
      issueNumber: 12,
      issueId: 777,
      issueUrl: "https://github.com/Kashionz/orbis-sandbox/issues/12",
      snapshot: { title: "W2 測試" },
    });
    // 一個 Task 最多對應一個 Issue
    await expectPgError(
      db.insert(taskIssueLinks).values({
        taskId: task.id,
        repoId: repo.id,
        githubRepoId: 9001,
        issueNumber: 13,
        issueId: 778,
        issueUrl: "https://github.com/Kashionz/orbis-sandbox/issues/13",
        snapshot: {},
      }),
      PG.uniqueViolation,
    );

    await db.insert(githubWebhookDeliveries).values({
      deliveryId: `delivery-${seq}`,
      event: "issues",
      status: "processing",
      claimedAt: new Date(),
    });
    await expectPgError(
      db.insert(githubWebhookDeliveries).values({
        deliveryId: `delivery-${seq}`,
        event: "issues",
        status: "processing",
        claimedAt: new Date(),
      }),
      PG.uniqueViolation,
    );

    const pr = one(
      await db
        .insert(pullRequests)
        .values({
          githubRepoId: 9001,
          number: 34,
          taskId: task.id,
          runId: run.id,
          repoId: repo.id,
          headBranch: `${NAMES.branchPrefix}W-1-x`,
          headSha: "b".repeat(40),
          url: "https://github.com/Kashionz/orbis-sandbox/pull/34",
        })
        .returning(),
    );
    expect(pr.state).toBe("open");
    expect(pr.ciFixCount).toBe(0);
    await expectPgError(
      db.insert(pullRequests).values({
        githubRepoId: 9001,
        number: 34,
        taskId: task.id,
        repoId: repo.id,
        headBranch: `${NAMES.branchPrefix}W-1-y`,
        headSha: "c".repeat(40),
        url: "https://github.com/Kashionz/orbis-sandbox/pull/34",
      }),
      PG.uniqueViolation,
    );
  });
});
