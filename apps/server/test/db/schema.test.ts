import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, runMigrations } from "../../src/db/client";
import {
  acceptanceCriteria,
  agentAvailabilities,
  blobs,
  childQuestions,
  collabDocuments,
  dispatches,
  draftTasks,
  feedbackAttempts,
  gates,
  members,
  mentions,
  needsYouItems,
  notificationPreferences,
  notifications,
  orbisToolCalls,
  projectMemberRoles,
  projects,
  repoSpecs,
  repos,
  reviewComments,
  runEvents,
  runnerCredentials,
  runners,
  runs,
  taskComments,
  taskDependencies,
  taskNotes,
  tasks,
  teams,
  verificationResults,
  verifications,
} from "../../src/db/schema";
import {
  createEmptyTestDatabase,
  createTestDatabase,
  dbSkipReason,
  type TestDatabase,
} from "../helpers/db";

/** Postgres 的錯誤代碼。 */
const PG = { uniqueViolation: "23505", foreignKeyViolation: "23503", checkViolation: "23514" };

/** 驗證 promise 以指定的 Postgres 錯誤代碼失敗（drizzle 把 pg 的錯誤放在 cause）。 */
async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `預期失敗並得到 ${code}`).not.toBeNull();
  const pgError = (error as { cause?: { code?: string } }).cause ?? error;
  expect((pgError as { code?: string }).code).toBe(code);
}

describe.skipIf(dbSkipReason !== null)("資料庫 schema", () => {
  describe("migration", () => {
    it("可以從空資料庫跑完，並建立所有表", async () => {
      const database = await createEmptyTestDatabase();
      try {
        await runMigrations(database.db);
        // 再跑一次不應重複套用
        await runMigrations(database.db);
        const result = await database.pool.query<{ table_name: string }>(
          "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
        );
        expect(result.rows.map((r) => r.table_name)).toEqual([
          "acceptance_criteria",
          "agent_availabilities",
          "blobs",
          "child_questions",
          "collab_documents",
          "dispatches",
          "draft_tasks",
          "feedback_attempts",
          "feedback_batches",
          "gates",
          "github_webhook_deliveries",
          "members",
          "mentions",
          "needs_you_items",
          "notification_preferences",
          "notifications",
          "orbis_tool_calls",
          "project_member_roles",
          "projects",
          "pull_requests",
          "repo_spec_pull_requests",
          "repo_specs",
          "repos",
          "review_comments",
          "run_controls",
          "run_events",
          "runner_credentials",
          "runner_pairing_tokens",
          "runners",
          "runs",
          "sessions",
          "task_comments",
          "task_dependencies",
          "task_issue_links",
          "task_notes",
          "tasks",
          "teams",
          "verification_results",
          "verifications",
        ]);
      } finally {
        await database.drop();
      }
    });
  });

  describe("資料鏈與限制", () => {
    let database: TestDatabase;
    let db: Database;

    beforeAll(async () => {
      database = await createTestDatabase();
      db = database.db;
    });

    afterAll(async () => {
      await database?.drop();
    });

    async function createTeamAndProject(prefix: string) {
      const [team] = await db
        .insert(teams)
        .values({ name: `team-${prefix}` })
        .returning();
      if (!team) throw new Error("unreachable");
      const [project] = await db
        .insert(projects)
        .values({ teamId: team.id, name: `project-${prefix}`, taskKeyPrefix: prefix })
        .returning();
      if (!project) throw new Error("unreachable");
      return { team, project };
    }

    it("可以插入完整的資料鏈：Team → Member → Project → Repo → Task → Run → Child Run → Dispatch → Event 等", async () => {
      const [team] = await db.insert(teams).values({ name: "Core" }).returning();
      if (!team) throw new Error("unreachable");
      const [owner, dev] = await db
        .insert(members)
        .values([
          { teamId: team.id, githubUserId: 1001, githubLogin: "owner", role: "owner" },
          { teamId: team.id, githubUserId: 1002, githubLogin: "dev", role: "member" },
        ])
        .returning();
      if (!owner || !dev) throw new Error("unreachable");

      const [project] = await db
        .insert(projects)
        .values({
          teamId: team.id,
          name: "Core",
          taskKeyPrefix: "ORB",
          forbidSelfApproval: true,
          delegationAllowedAgents: ["claude-code", "codex"],
        })
        .returning();
      if (!project) throw new Error("unreachable");
      expect(project.nextTaskNumber).toBe(1);
      expect(project.planGateEnabled).toBe(true);
      expect(project.defaultPermissionPolicy).toBe("auto");
      expect(project.verificationMaxRetries).toBe(3);

      await db
        .insert(projectMemberRoles)
        .values({ projectId: project.id, memberId: dev.id, role: "viewer" });

      const [repo] = await db
        .insert(repos)
        .values({
          projectId: project.id,
          githubOwner: "acme",
          githubName: "app",
          defaultBranch: "main",
        })
        .returning();
      if (!repo) throw new Error("unreachable");
      const [spec] = await db
        .insert(repoSpecs)
        .values({ repoId: repo.id, path: "docs/specs/login.md" })
        .returning();
      if (!spec) throw new Error("unreachable");

      const [task1, task2] = await db
        .insert(tasks)
        .values([
          {
            projectId: project.id,
            number: 1,
            key: "ORB-1",
            repoId: repo.id,
            repoSpecId: spec.id,
            title: "登入頁",
            assigneeMemberId: dev.id,
            createdByMemberId: owner.id,
            labels: ["frontend"],
          },
          { projectId: project.id, number: 2, key: "ORB-2", repoId: repo.id, title: "登出" },
        ])
        .returning();
      if (!task1 || !task2) throw new Error("unreachable");
      expect(task1.status).toBe("backlog");
      expect(task2.labels).toEqual([]);

      await db.insert(taskDependencies).values({ taskId: task2.id, dependsOnTaskId: task1.id });
      await db.insert(acceptanceCriteria).values([
        {
          taskId: task1.id,
          position: 0,
          kind: "command",
          description: "測試通過",
          command: "pnpm test",
        },
        { taskId: task1.id, position: 1, kind: "manual", description: "設計確認" },
      ]);

      const [runner] = await db
        .insert(runners)
        .values({
          teamId: team.id,
          memberId: dev.id,
          kind: "local",
          name: "dev-desktop",
          runnerVersion: "0.1.0",
          os: "windows",
          arch: "x86_64",
          tokenHash: "hash-1",
        })
        .returning();
      if (!runner) throw new Error("unreachable");
      await db.insert(agentAvailabilities).values({
        runnerId: runner.id,
        agent: "claude-code",
        credential: "default",
        maxConcurrency: 2,
      });

      const [run] = await db
        .insert(runs)
        .values({
          taskId: task1.id,
          agent: "claude-code",
          model: "claude-opus-5-5",
          permissionPolicy: "auto",
          target: "local",
          requestedByMemberId: dev.id,
          runnerId: runner.id,
          worktreePath: "D:\\work\\ORB-1",
          branch: "feature/ORB-1",
          baseCommit: "abc123",
        })
        .returning();
      if (!run) throw new Error("unreachable");
      expect(run.status).toBe("queued");
      expect(run.usage).toEqual({});

      const [child] = await db
        .insert(runs)
        .values({
          taskId: task1.id,
          parentRunId: run.id,
          delegationMode: "consult",
          agent: "codex",
          permissionPolicy: "manual",
          target: "local",
        })
        .returning();
      if (!child) throw new Error("unreachable");

      const [dispatch] = await db
        .insert(dispatches)
        .values({ runId: run.id, runnerId: runner.id, expiresAt: new Date(Date.now() + 60_000) })
        .returning();
      expect(dispatch?.status).toBe("offered");

      await db.insert(runEvents).values([
        { runId: run.id, seq: 1, ts: new Date(), kind: "message_chunk", payload: { text: "hi" } },
        {
          runId: run.id,
          seq: 2,
          ts: new Date(),
          kind: "status_changed",
          payload: { status: "running" },
        },
        {
          runId: child.id,
          seq: 1,
          ts: new Date(),
          kind: "message_chunk",
          payload: { text: "child" },
        },
      ]);

      const [blob] = await db
        .insert(blobs)
        .values({
          sha256: "0".repeat(64),
          size: 1234,
          mediaType: "image/png",
          storageKey: "blobs/aa/bb",
          runId: run.id,
        })
        .returning();
      if (!blob) throw new Error("unreachable");
      const retentionDays = (blob.expiresAt.getTime() - blob.createdAt.getTime()) / 86_400_000;
      expect(Math.round(retentionDays)).toBe(90);

      await db.insert(draftTasks).values({
        projectId: project.id,
        proposedByRunId: run.id,
        repoId: repo.id,
        title: "補上忘記密碼",
        acceptanceCriteria: [{ kind: "manual", description: "流程可用" }],
      });

      const [gate] = await db
        .insert(gates)
        .values({ taskId: task1.id, runId: run.id, kind: "plan", subject: { plan: "1. 做登入頁" } })
        .returning();
      if (!gate) throw new Error("unreachable");
      await db.insert(needsYouItems).values([
        {
          projectId: project.id,
          memberId: owner.id,
          kind: "gate",
          taskId: task1.id,
          gateId: gate.id,
        },
        {
          projectId: project.id,
          memberId: dev.id,
          kind: "permission_request",
          taskId: task1.id,
          runId: run.id,
          payload: { tool_call_id: "tc-1" },
        },
      ]);

      // 讀回：Child Run 與 Event 的順序
      const children = await db.select().from(runs).where(eq(runs.parentRunId, run.id));
      expect(children.map((r) => r.id)).toEqual([child.id]);
      const events = await db
        .select({ seq: runEvents.seq })
        .from(runEvents)
        .where(eq(runEvents.runId, run.id))
        .orderBy(asc(runEvents.seq));
      expect(events.map((e) => e.seq)).toEqual([1, 2]);
    });

    it("同一個 Project 內 Task Key 與流水號唯一，不同 Project 可以重複", async () => {
      const a = await createTeamAndProject("AAA");
      const b = await createTeamAndProject("BBB");
      await db.insert(tasks).values({ projectId: a.project.id, number: 1, key: "K-1", title: "a" });
      await expectPgError(
        db
          .insert(tasks)
          .values({ projectId: a.project.id, number: 2, key: "K-1", title: "dup key" }),
        PG.uniqueViolation,
      );
      await expectPgError(
        db
          .insert(tasks)
          .values({ projectId: a.project.id, number: 1, key: "K-9", title: "dup no" }),
        PG.uniqueViolation,
      );
      await db.insert(tasks).values({ projectId: b.project.id, number: 1, key: "K-1", title: "b" });
    });

    it("同一個 Team 內 Task Key 前綴唯一", async () => {
      const { team } = await createTeamAndProject("PRE");
      await expectPgError(
        db.insert(projects).values({ teamId: team.id, name: "again", taskKeyPrefix: "PRE" }),
        PG.uniqueViolation,
      );
    });

    it("run_events 的 (run_id, seq) 唯一", async () => {
      const { project } = await createTeamAndProject("EVT");
      const [task] = await db
        .insert(tasks)
        .values({ projectId: project.id, number: 1, key: "EVT-1", title: "t" })
        .returning();
      if (!task) throw new Error("unreachable");
      const [run] = await db
        .insert(runs)
        .values({ taskId: task.id, agent: "claude-code", permissionPolicy: "auto", target: "team" })
        .returning();
      if (!run) throw new Error("unreachable");
      const event = { runId: run.id, seq: 1, ts: new Date(), kind: "message_chunk", payload: {} };
      await db.insert(runEvents).values(event);
      await expectPgError(db.insert(runEvents).values(event), PG.uniqueViolation);
      // 去除重複的寫法：重送同一個 seq 時忽略
      await db.insert(runEvents).values(event).onConflictDoNothing();
      await expectPgError(db.insert(runEvents).values({ ...event, seq: 0 }), PG.checkViolation);
    });

    it("同一個 Team 內 GitHub 帳號唯一，不同 Team 可以各有一筆 Member", async () => {
      const a = await createTeamAndProject("MEA");
      const b = await createTeamAndProject("MEB");
      const member = { githubUserId: 4242, githubLogin: "someone", role: "member" as const };
      await db.insert(members).values({ ...member, teamId: a.team.id });
      await expectPgError(
        db.insert(members).values({ ...member, teamId: a.team.id }),
        PG.uniqueViolation,
      );
      await db.insert(members).values({ ...member, teamId: b.team.id });
    });

    it("外鍵限制：不存在的 Project、Run 與 Task 會被拒絕", async () => {
      const missing = "0192f3a0-0000-7000-8000-000000000000";
      await expectPgError(
        db.insert(tasks).values({ projectId: missing, number: 1, key: "X-1", title: "x" }),
        PG.foreignKeyViolation,
      );
      await expectPgError(
        db
          .insert(runEvents)
          .values({ runId: missing, seq: 1, ts: new Date(), kind: "k", payload: {} }),
        PG.foreignKeyViolation,
      );
      await expectPgError(
        db.insert(taskDependencies).values({ taskId: missing, dependsOnTaskId: missing }),
        PG.checkViolation,
      );
    });

    it("刪除 Project 會一併刪除 Task、Run 與 Event", async () => {
      const { project } = await createTeamAndProject("DEL");
      const [repo] = await db
        .insert(repos)
        .values({ projectId: project.id, githubOwner: "acme", githubName: "del" })
        .returning();
      if (!repo) throw new Error("unreachable");
      const [task] = await db
        .insert(tasks)
        .values({ projectId: project.id, number: 1, key: "DEL-1", title: "t", repoId: repo.id })
        .returning();
      if (!task) throw new Error("unreachable");
      const [run] = await db
        .insert(runs)
        .values({ taskId: task.id, agent: "claude-code", permissionPolicy: "auto", target: "team" })
        .returning();
      if (!run) throw new Error("unreachable");
      await db
        .insert(runEvents)
        .values({ runId: run.id, seq: 1, ts: new Date(), kind: "k", payload: {} });

      // 還有 Task 使用的 Repo 不能單獨刪除
      await expectPgError(db.delete(repos).where(eq(repos.id, repo.id)), PG.foreignKeyViolation);

      await db.delete(projects).where(eq(projects.id, project.id));
      const [{ count }] = (await db
        .select({ count: sql<number>`count(*)::int` })
        .from(runEvents)
        .where(eq(runEvents.runId, run.id))) as [{ count: number }];
      expect(count).toBe(0);
    });

    it("CHECK 限制：Child Run 必須有 Delegation 模式、Runner 種類與綁定對象一致、只有 command 類型可以有指令", async () => {
      const { team, project } = await createTeamAndProject("CHK");
      const [task] = await db
        .insert(tasks)
        .values({ projectId: project.id, number: 1, key: "CHK-1", title: "t" })
        .returning();
      if (!task) throw new Error("unreachable");
      const [parent] = await db
        .insert(runs)
        .values({ taskId: task.id, agent: "claude-code", permissionPolicy: "auto", target: "team" })
        .returning();
      if (!parent) throw new Error("unreachable");
      await expectPgError(
        db.insert(runs).values({
          taskId: task.id,
          parentRunId: parent.id,
          agent: "codex",
          permissionPolicy: "auto",
          target: "team",
        }),
        PG.checkViolation,
      );
      await expectPgError(
        db.insert(runners).values({
          teamId: team.id,
          kind: "local",
          name: "n",
          runnerVersion: "0",
          os: "linux",
          arch: "x86_64",
          tokenHash: "hash-chk",
        }),
        PG.checkViolation,
      );
      await expectPgError(
        db.insert(acceptanceCriteria).values({
          taskId: task.id,
          position: 0,
          kind: "manual",
          description: "manual 類型不能有指令",
          command: "pnpm test",
        }),
        PG.checkViolation,
      );
      // command 類型沒有指令時沿用 Repo 設定檔的 verify（ARCHITECTURE §5.1）
      await db.insert(acceptanceCriteria).values({
        taskId: task.id,
        position: 1,
        kind: "command",
        description: "沿用 verify",
      });
    });

    it("W5–7 的資料表：可以寫入，CHECK 限制擋下不合法的資料", async () => {
      const { team, project } = await createTeamAndProject("W5");
      const [member] = await db
        .insert(members)
        .values({ teamId: team.id, githubUserId: 5001, githubLogin: "w5", role: "member" })
        .returning();
      const [task] = await db
        .insert(tasks)
        .values({ projectId: project.id, number: 1, key: "W5-1", title: "t" })
        .returning();
      if (!member || !task) throw new Error("unreachable");
      const [criterion] = await db
        .insert(acceptanceCriteria)
        .values({ taskId: task.id, position: 0, kind: "command", description: "測試通過" })
        .returning();
      const [parent] = await db
        .insert(runs)
        .values({ taskId: task.id, agent: "claude-code", permissionPolicy: "auto", target: "team" })
        .returning();
      if (!criterion || !parent) throw new Error("unreachable");
      expect(parent.origin).toBe("dispatch");
      const [child] = await db
        .insert(runs)
        .values({
          taskId: task.id,
          parentRunId: parent.id,
          delegationMode: "consult",
          origin: "verification",
          agent: "codex",
          permissionPolicy: "auto",
          target: "team",
        })
        .returning();
      const [fix] = await db
        .insert(runs)
        .values({
          taskId: task.id,
          origin: "feedback_loop",
          resumesRunId: parent.id,
          agent: "claude-code",
          permissionPolicy: "auto",
          target: "team",
          status: "verifying",
        })
        .returning();
      if (!child || !fix) throw new Error("unreachable");

      // Verification
      const [verification] = await db
        .insert(verifications)
        .values({ runId: parent.id, taskId: task.id, attempt: 1 })
        .returning();
      if (!verification) throw new Error("unreachable");
      expect(verification.status).toBe("running");
      await db.insert(verificationResults).values({
        verificationId: verification.id,
        criterionId: criterion.id,
        outcome: "failed",
        summary: "pnpm test 失敗",
        evidence: [{ type: "text", text: "x" }],
        judgedByRunId: child.id,
      });
      await expectPgError(
        db.insert(verificationResults).values({
          verificationId: verification.id,
          criterionId: criterion.id,
          outcome: "passed",
          summary: "重複",
        }),
        PG.uniqueViolation,
      );

      // Orbis MCP 工具呼叫與 Child Run 的問題
      await expectPgError(
        db.insert(orbisToolCalls).values({
          callId: "0195f0a0-0000-7000-8000-000000000101",
          runId: parent.id,
          tool: "list_runs",
          input: { tool: "list_runs" },
          result: { outcome: "ok" },
        }),
        PG.checkViolation,
      );
      const [question] = await db
        .insert(childQuestions)
        .values({ childRunId: child.id, parentRunId: parent.id, question: "存在哪裡？" })
        .returning();
      if (!question) throw new Error("unreachable");
      await expectPgError(
        db.insert(needsYouItems).values({
          projectId: project.id,
          kind: "child_question",
          taskId: task.id,
          runId: parent.id,
        }),
        PG.checkViolation,
      );
      await db.insert(needsYouItems).values({
        projectId: project.id,
        kind: "child_question",
        taskId: task.id,
        runId: parent.id,
        childQuestionId: question.id,
      });

      // Review Gate 的留言：diff 與 preview 各自的欄位
      const [gate] = await db.insert(gates).values({ taskId: task.id, kind: "review" }).returning();
      if (!gate) throw new Error("unreachable");
      await db.insert(reviewComments).values([
        { gateId: gate.id, path: "a.ts", line: 1, side: "new", body: "diff" },
        { gateId: gate.id, kind: "preview", url: "https://x.example.com/", body: "preview" },
      ]);
      await expectPgError(
        db.insert(reviewComments).values({ gateId: gate.id, kind: "diff", body: "沒有路徑" }),
        PG.checkViolation,
      );
      await expectPgError(
        db.insert(reviewComments).values({
          gateId: gate.id,
          kind: "preview",
          url: "https://x.example.com/",
          path: "a.ts",
          body: "preview 不能有路徑",
        }),
        PG.checkViolation,
      );

      // 留言、Task note、@mention
      const [comment] = await db
        .insert(taskComments)
        .values({
          taskId: task.id,
          authorMemberId: member.id,
          body: "@[claude](agent:claude-code)",
        })
        .returning();
      if (!comment) throw new Error("unreachable");
      await expectPgError(
        db.insert(taskComments).values({
          taskId: task.id,
          authorMemberId: member.id,
          authorRunId: parent.id,
          body: "兩個作者",
        }),
        PG.checkViolation,
      );
      await db
        .insert(taskNotes)
        .values({ taskId: task.id, runId: fix.id, source: "feedback_loop", body: "第 1 次" });
      await db.insert(mentions).values({
        taskId: task.id,
        sourceKind: "task_comment",
        sourceId: comment.id,
        nodeId: "0",
        agent: "claude-code",
        consultRunId: child.id,
      });
      await expectPgError(
        db.insert(mentions).values({
          taskId: task.id,
          sourceKind: "task_comment",
          sourceId: comment.id,
          nodeId: "0",
          memberId: member.id,
        }),
        PG.uniqueViolation,
      );
      await expectPgError(
        db.insert(mentions).values({
          taskId: task.id,
          sourceKind: "task_comment",
          sourceId: comment.id,
          nodeId: "1",
          memberId: member.id,
          agent: "codex",
        }),
        PG.checkViolation,
      );

      // 通知與設定
      await db
        .insert(notifications)
        .values({ memberId: member.id, kind: "feedback_limit_reached", title: "x", desktop: true });
      await db.insert(notificationPreferences).values({
        memberId: member.id,
        disabledKinds: ["task_assigned"],
        quietHoursStartMinute: 22 * 60,
        quietHoursEndMinute: 8 * 60,
        timeZone: "Asia/Taipei",
      });
      const [prefs] = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.memberId, member.id));
      expect(prefs?.disabledKinds).toEqual(["task_assigned"]);
      await expectPgError(
        db
          .update(notificationPreferences)
          .set({ quietHoursEndMinute: null })
          .where(eq(notificationPreferences.memberId, member.id)),
        PG.checkViolation,
      );

      // 共同編輯的文件只屬於一個對象
      await db.insert(collabDocuments).values({
        name: `task-description:${task.id}`,
        taskId: task.id,
        state: new Uint8Array([1, 2, 3]),
      });
      const [doc] = await db
        .select()
        .from(collabDocuments)
        .where(eq(collabDocuments.taskId, task.id));
      expect(Array.from(doc?.state ?? [])).toEqual([1, 2, 3]);
      await expectPgError(
        db.insert(collabDocuments).values({
          name: `acceptance-criterion:${criterion.id}`,
          taskId: task.id,
          acceptanceCriterionId: criterion.id,
          state: new Uint8Array(),
        }),
        PG.checkViolation,
      );

      // Credential 的覆寫
      const [runner] = await db
        .insert(runners)
        .values({
          teamId: team.id,
          kind: "team",
          name: "team-1",
          runnerVersion: "0",
          os: "linux",
          arch: "x86_64",
          tokenHash: "hash-w5",
        })
        .returning();
      if (!runner) throw new Error("unreachable");
      await db
        .insert(runnerCredentials)
        .values({ runnerId: runner.id, credential: "default", maxConcurrentRunsOverride: 10 });
      await expectPgError(
        db
          .insert(runnerCredentials)
          .values({ runnerId: runner.id, credential: "other", maxConcurrentRunsOverride: 0 }),
        PG.checkViolation,
      );

      // Feedback Loop 的紀錄連到修正用的 Run
      await db.insert(feedbackAttempts).values({
        taskId: task.id,
        runId: fix.id,
        githubRepoId: 1,
        prNumber: 3,
        source: "ci",
        seq: 1,
        trigger: { checks: ["test"] },
        status: "sent",
      });
    });
  });
});
