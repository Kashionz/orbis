// Feedback Loop（ARCHITECTURE §5.2）的 Server 端：Drizzle 版的 FeedbackStore／RepoSpecStore 跑 packages/github 的
// 契約測試；FeedbackRunPort 開新的 Run 接續原本的 session，修正通過 Verification 後直接 push。
//
// 契約測試用 `task-1`、`run-a`、`fix-1` 這類字串 ID，資料表是 UUID 外鍵：以一層轉換把字串 ID 對應到
// 真實的資料列（需要時才建立 Run、Member、Repo Spec），讀出時轉回去。

import { randomUUID } from "node:crypto";
import type {
  FeedbackBatch,
  FeedbackFix,
  FeedbackSource,
  FeedbackStore,
  RepoSpecPullRequest,
  RepoSpecStore,
} from "@orbis/github";
import {
  describeFeedbackStoreContract,
  describeRepoSpecStoreContract,
} from "@orbis/github/testing/store-contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { members, repoSpecs, runs, tasks } from "../src/db/schema";
import { DrizzleFeedbackStore, DrizzleRepoSpecStore } from "../src/github/feedback-store";
import { resetDatabase, seedProject, seedReadyTask, seedTeam } from "./helpers/api";
import type { TestDatabase } from "./helpers/db";
import { createTestDatabase, dbSkipReason } from "./helpers/db";
import {
  AWAITING_REVIEW,
  control,
  type Flow,
  RUN_DIFF,
  RUNNING,
  runRow,
  startFlow,
  startRun,
  taskRow,
} from "./helpers/flow";
import { waitUntil } from "./helpers/runner-harness";

/** 契約測試的字串 ID ↔ 真實的 UUID；需要時呼叫 create 建立資料列。 */
class IdMap {
  private readonly ids = new Map<string, string>();

  constructor(private readonly create: (fake: string) => Promise<string>) {}

  async to(fake: string): Promise<string> {
    let real = this.ids.get(fake);
    if (!real) {
      real = await this.create(fake);
      this.ids.set(fake, real);
    }
    return real;
  }

  peek(fake: string): string | undefined {
    return this.ids.get(fake);
  }

  from(real: string): string {
    for (const [fake, value] of this.ids) if (value === real) return fake;
    throw new Error(`找不到 ${real} 對應的契約 ID`);
  }
}

class MappedFeedbackStore implements FeedbackStore {
  constructor(
    private readonly inner: FeedbackStore,
    private readonly ids: { task: IdMap; run: IdMap; fix: IdMap },
  ) {}

  getFeedbackBatch(githubRepoId: number, prNumber: number, source: FeedbackSource) {
    return this.inner.getFeedbackBatch(githubRepoId, prNumber, source);
  }
  saveFeedbackBatch(batch: FeedbackBatch) {
    return this.inner.saveFeedbackBatch(batch);
  }
  deleteFeedbackBatch(githubRepoId: number, prNumber: number, source: FeedbackSource) {
    return this.inner.deleteFeedbackBatch(githubRepoId, prNumber, source);
  }
  listDueFeedbackBatches(now: Date) {
    return this.inner.listDueFeedbackBatches(now);
  }

  async saveFeedbackFix(fix: FeedbackFix) {
    await this.inner.saveFeedbackFix({
      ...fix,
      id: await this.ids.fix.to(fix.id),
      taskId: await this.ids.task.to(fix.taskId),
      previousRunId: fix.previousRunId && (await this.ids.run.to(fix.previousRunId)),
      runId: fix.runId && (await this.ids.run.to(fix.runId)),
    });
  }

  private back = (fix: FeedbackFix): FeedbackFix => ({
    ...fix,
    id: this.ids.fix.from(fix.id),
    taskId: this.ids.task.from(fix.taskId),
    previousRunId: fix.previousRunId && this.ids.run.from(fix.previousRunId),
    runId: fix.runId && this.ids.run.from(fix.runId),
  });

  async listFeedbackFixes(githubRepoId: number, prNumber: number) {
    return (await this.inner.listFeedbackFixes(githubRepoId, prNumber)).map(this.back);
  }

  async findFeedbackFixByRun(runId: string) {
    const real = this.ids.run.peek(runId);
    if (!real) return null;
    const fix = await this.inner.findFeedbackFixByRun(real);
    return fix && this.back(fix);
  }
}

class MappedRepoSpecStore implements RepoSpecStore {
  constructor(
    private readonly inner: RepoSpecStore,
    private readonly ids: { spec: IdMap; member: IdMap },
  ) {}

  private back = (pr: RepoSpecPullRequest): RepoSpecPullRequest => ({
    ...pr,
    repoSpecId: this.ids.spec.from(pr.repoSpecId),
    createdByMemberId: pr.createdByMemberId && this.ids.member.from(pr.createdByMemberId),
  });

  async findRepoSpecPullRequest(githubRepoId: number, number: number) {
    const pr = await this.inner.findRepoSpecPullRequest(githubRepoId, number);
    return pr && this.back(pr);
  }

  async findOpenRepoSpecPullRequest(repoSpecId: string) {
    const pr = await this.inner.findOpenRepoSpecPullRequest(await this.ids.spec.to(repoSpecId));
    return pr && this.back(pr);
  }

  async saveRepoSpecPullRequest(pr: RepoSpecPullRequest) {
    await this.inner.saveRepoSpecPullRequest({
      ...pr,
      repoSpecId: await this.ids.spec.to(pr.repoSpecId),
      createdByMemberId: pr.createdByMemberId && (await this.ids.member.to(pr.createdByMemberId)),
    });
  }
}

describe.skipIf(dbSkipReason !== null)("Feedback Loop", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  /** 契約測試用的 Team、Project、Task。 */
  async function fixtures() {
    const db = database.db;
    await resetDatabase(db);
    const team = await seedTeam(db);
    const { project, repo } = await seedProject(db, team.teamId);
    const task = await seedReadyTask(db, project, repo.id);
    return { db, team, task, repoId: repo.id };
  }

  describeFeedbackStoreContract("DrizzleFeedbackStore", async () => {
    const { db, task } = await fixtures();
    return new MappedFeedbackStore(new DrizzleFeedbackStore(db), {
      task: new IdMap(async () => task.id),
      run: new IdMap(async () => {
        const [run] = await db
          .insert(runs)
          .values({
            taskId: task.id,
            agent: "claude-code",
            permissionPolicy: "auto",
            target: "local",
          })
          .returning({ id: runs.id });
        if (!run) throw new Error("建立 Run 失敗");
        return run.id;
      }),
      fix: new IdMap(async () => randomUUID()),
    });
  });

  describeRepoSpecStoreContract("DrizzleRepoSpecStore", async () => {
    const { db, team, repoId } = await fixtures();
    return new MappedRepoSpecStore(new DrizzleRepoSpecStore(db), {
      spec: new IdMap(async (fake) => {
        const [spec] = await db
          .insert(repoSpecs)
          .values({ repoId, path: `docs/${fake}.md` })
          .returning({ id: repoSpecs.id });
        if (!spec) throw new Error("建立 Repo Spec 失敗");
        return spec.id;
      }),
      member: new IdMap(async () => {
        const [member] = await db
          .select({ id: members.id })
          .from(members)
          .where(eq(members.id, team.members.member.id));
        if (!member) throw new Error("Member 不存在");
        return member.id;
      }),
    });
  });

  describe("FeedbackRunPort", () => {
    let flow: Flow;

    beforeEach(async () => {
      await resetDatabase(database.db);
      flow = await startFlow(database.db);
    });

    afterEach(async () => {
      await flow.close();
    });

    /** 走到 PR Open：主 Run 回報 Worktree 與 session、通過 Review Gate、push 完成。 */
    async function prOpen() {
      const started = await startRun(flow, {
        criteria: [{ kind: "command", description: "測試通過", command: "pnpm test" }],
      });
      await started.send({
        kind: "worktree_ready",
        worktree_path: "C:/w/ORB-1-1",
        branch: started.run.branch,
        base_commit: "a".repeat(40),
      });
      await started.send({ kind: "agent_session", session_id: "session-1" });
      await started.send(RUN_DIFF);
      await started.send(AWAITING_REVIEW);
      await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
      await database.db
        .update(tasks)
        .set({ status: "pr_open" })
        .where(eq(tasks.id, started.task.id));
      return started;
    }

    const port = () => flow.h.ctx.services.feedbackRuns;

    it("開新的 Run 接續原本的 session：同一台 Runner、同一個分支，Task 回到 Running", async () => {
      const started = await prOpen();
      const result = await port().requestFix({
        taskId: started.task.id,
        previousRunId: started.run.id,
        source: "ci",
        prompt: "CI 的 test 失敗了",
        pullRequestUrl: "https://github.com/acme/app/pull/1",
      });
      if (!result.ok) throw new Error(result.message);
      expect(await runRow(database.db, result.runId)).toMatchObject({
        origin: "feedback_loop",
        resumesRunId: started.run.id,
        branch: started.run.branch,
        promptSource: "feedback_ci",
      });
      expect((await taskRow(database.db, started.task.id)).status).toBe("running");
      await flow.h.ctx.services.dispatcher.kick();
      const offer = await started.mine.next("dispatch_offer", (o) => o.run_id === result.runId);
      expect(offer).toMatchObject({
        origin: "feedback_loop",
        plan_gate: false,
        prompt_source: "feedback_ci",
        prompt: [{ type: "text", text: "CI 的 test 失敗了" }],
        continuation: {
          previous_run_id: started.run.id,
          session_id: "session-1",
          base_commit: "a".repeat(40),
        },
      });
    });

    it("修正通過 Verification 後直接 push，不經過 Review Gate，Task 回到 PR Open", async () => {
      const started = await prOpen();
      const result = await port().requestFix({
        taskId: started.task.id,
        previousRunId: started.run.id,
        source: "review",
        prompt: "請處理 review",
        pullRequestUrl: "https://github.com/acme/app/pull/1",
      });
      if (!result.ok) throw new Error(result.message);
      await flow.h.ctx.services.dispatcher.kick();
      const offer = await started.mine.next("dispatch_offer", (o) => o.run_id === result.runId);
      started.mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await waitUntil(async () => (await runRow(database.db, result.runId))?.status === "starting");
      const send = (kind: Parameters<typeof started.send>[0]) =>
        started.mine.eventAcked(offer.dispatch_id, result.runId, kind);
      await send(RUNNING);
      await send(RUN_DIFF);
      await send(AWAITING_REVIEW);
      await started.mine.answerVerification(offer.dispatch_id, result.runId);
      expect((await taskRow(database.db, started.task.id)).status).toBe("pr_open");
      expect(await control(started.mine, "gate_result", {}).then((f) => f.run_id)).toBe(
        result.runId,
      );
      await control(started.mine, "push_branch", {
        outcome: "branch_pushed",
        branch: started.run.branch,
        commit_sha: "e".repeat(40),
      });
      const gates = (await flow.as("viewer").get<unknown[]>(`/api/tasks/${started.task.id}/gates`))
        .body;
      // 只有主 Run 第一次的 Review Gate，修正沒有新的 Gate。
      expect(gates).toHaveLength(1);
    });

    it("修正 Run 沒有 push 就結束：Task 回到 PR Open", async () => {
      const started = await prOpen();
      const result = await port().requestFix({
        taskId: started.task.id,
        previousRunId: started.run.id,
        source: "ci",
        prompt: "修正",
        pullRequestUrl: "https://github.com/acme/app/pull/1",
      });
      if (!result.ok) throw new Error(result.message);
      await flow.h.ctx.services.dispatcher.kick();
      const offer = await started.mine.next("dispatch_offer", (o) => o.run_id === result.runId);
      started.mine.send({ type: "dispatch_accept", dispatch_id: offer.dispatch_id });
      await waitUntil(async () => (await runRow(database.db, result.runId))?.status === "starting");
      await started.mine.eventAcked(offer.dispatch_id, result.runId, {
        kind: "status_changed",
        status: "failed",
        gate: null,
        message: "Agent 當掉",
      });
      expect((await taskRow(database.db, started.task.id)).status).toBe("pr_open");
    });

    it("前一個 Run 不存在、Runner 不在線上、Task 不在 PR Open 時回對應的原因", async () => {
      const started = await prOpen();
      const request = {
        taskId: started.task.id,
        previousRunId: started.run.id,
        source: "ci" as const,
        prompt: "x",
        pullRequestUrl: "https://github.com/acme/app/pull/1",
      };
      expect(await port().requestFix({ ...request, previousRunId: randomUUID() })).toMatchObject({
        ok: false,
        reason: "run_not_found",
      });
      await database.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, started.task.id));
      expect(await port().requestFix(request)).toMatchObject({
        ok: false,
        reason: "invalid_state",
      });
      await database.db
        .update(tasks)
        .set({ status: "pr_open" })
        .where(eq(tasks.id, started.task.id));
      started.mine.close();
      await waitUntil(() => !flow.h.ctx.services.hub.isOnline(started.mine.runnerId));
      expect(await port().requestFix(request)).toMatchObject({
        ok: false,
        reason: "run_not_resumable",
      });
    });
  });
});
