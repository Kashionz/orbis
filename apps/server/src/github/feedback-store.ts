// packages/github 的 FeedbackStore 與 RepoSpecStore 的 Drizzle 實作（ARCHITECTURE §5.2、§12.1）。
// 格式由 packages/github 定義（批次的 items、修正的 trigger 原樣存 JSONB），這裡只負責讀寫。

import type {
  FeedbackBatch,
  FeedbackFix,
  FeedbackSource,
  FeedbackStore,
  RepoSpecPullRequest,
  RepoSpecStore,
} from "@orbis/github";
import { and, asc, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { feedbackBatches, feedbackFixes, repoSpecPullRequests } from "../db/schema";

type BatchRow = typeof feedbackBatches.$inferSelect;
type FixRow = typeof feedbackFixes.$inferSelect;
type SpecPullRow = typeof repoSpecPullRequests.$inferSelect;

function toBatch(row: BatchRow): FeedbackBatch {
  const base = { githubRepoId: row.githubRepoId, prNumber: row.prNumber, dueAt: row.dueAt };
  return row.source === "ci"
    ? {
        ...base,
        source: "ci",
        headSha: row.headSha ?? "",
        items: row.items as Extract<FeedbackBatch, { source: "ci" }>["items"],
      }
    : {
        ...base,
        source: "review",
        items: row.items as Extract<FeedbackBatch, { source: "review" }>["items"],
      };
}

/** JSONB 中的批次（trigger）：Date 存成字串，讀出時轉回 Date。 */
function toTrigger(value: unknown): FeedbackBatch {
  const batch = value as FeedbackBatch & { dueAt: string | Date };
  return { ...batch, dueAt: new Date(batch.dueAt) } as FeedbackBatch;
}

function toFix(row: FixRow): FeedbackFix {
  return {
    id: row.id,
    taskId: row.taskId,
    githubRepoId: row.githubRepoId,
    prNumber: row.prNumber,
    source: row.source,
    previousRunId: row.previousRunId,
    runId: row.runId,
    trigger: toTrigger(row.trigger),
    status: row.status,
    commitSha: row.commitSha,
    prCommentId: row.prCommentId,
    message: row.message,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleFeedbackStore implements FeedbackStore {
  constructor(private readonly db: Database) {}

  async getFeedbackBatch(
    githubRepoId: number,
    prNumber: number,
    source: FeedbackSource,
  ): Promise<FeedbackBatch | null> {
    const [row] = await this.db
      .select()
      .from(feedbackBatches)
      .where(
        and(
          eq(feedbackBatches.githubRepoId, githubRepoId),
          eq(feedbackBatches.prNumber, prNumber),
          eq(feedbackBatches.source, source),
        ),
      );
    return row ? toBatch(row) : null;
  }

  async saveFeedbackBatch(batch: FeedbackBatch): Promise<void> {
    const values = {
      githubRepoId: batch.githubRepoId,
      prNumber: batch.prNumber,
      source: batch.source,
      headSha: batch.source === "ci" ? batch.headSha : null,
      items: batch.items,
      dueAt: batch.dueAt,
    };
    await this.db
      .insert(feedbackBatches)
      .values(values)
      .onConflictDoUpdate({
        target: [feedbackBatches.githubRepoId, feedbackBatches.prNumber, feedbackBatches.source],
        set: { headSha: values.headSha, items: values.items, dueAt: values.dueAt },
      });
  }

  async deleteFeedbackBatch(
    githubRepoId: number,
    prNumber: number,
    source: FeedbackSource,
  ): Promise<void> {
    await this.db
      .delete(feedbackBatches)
      .where(
        and(
          eq(feedbackBatches.githubRepoId, githubRepoId),
          eq(feedbackBatches.prNumber, prNumber),
          eq(feedbackBatches.source, source),
        ),
      );
  }

  async listDueFeedbackBatches(now: Date): Promise<FeedbackBatch[]> {
    const rows = await this.db
      .select()
      .from(feedbackBatches)
      .where(lte(feedbackBatches.dueAt, now))
      .orderBy(asc(feedbackBatches.dueAt), asc(feedbackBatches.id));
    return rows.map(toBatch);
  }

  async saveFeedbackFix(fix: FeedbackFix): Promise<void> {
    const values = {
      id: fix.id,
      taskId: fix.taskId,
      githubRepoId: fix.githubRepoId,
      prNumber: fix.prNumber,
      source: fix.source,
      previousRunId: fix.previousRunId,
      runId: fix.runId,
      trigger: fix.trigger,
      status: fix.status,
      commitSha: fix.commitSha,
      prCommentId: fix.prCommentId,
      message: fix.message,
      createdAt: fix.createdAt,
      updatedAt: fix.updatedAt,
    };
    const { id: _id, createdAt: _createdAt, ...set } = values;
    await this.db
      .insert(feedbackFixes)
      .values(values)
      .onConflictDoUpdate({ target: feedbackFixes.id, set });
  }

  async listFeedbackFixes(githubRepoId: number, prNumber: number): Promise<FeedbackFix[]> {
    const rows = await this.db
      .select()
      .from(feedbackFixes)
      .where(
        and(eq(feedbackFixes.githubRepoId, githubRepoId), eq(feedbackFixes.prNumber, prNumber)),
      )
      .orderBy(asc(feedbackFixes.createdAt), asc(feedbackFixes.id));
    return rows.map(toFix);
  }

  async findFeedbackFixByRun(runId: string): Promise<FeedbackFix | null> {
    const [row] = await this.db.select().from(feedbackFixes).where(eq(feedbackFixes.runId, runId));
    return row ? toFix(row) : null;
  }
}

function toSpecPull(row: SpecPullRow): RepoSpecPullRequest {
  return {
    repoSpecId: row.repoSpecId,
    githubRepoId: row.githubRepoId,
    number: row.number,
    url: row.url,
    headBranch: row.headBranch,
    state: row.state,
    createdByMemberId: row.createdByMemberId,
  };
}

export class DrizzleRepoSpecStore implements RepoSpecStore {
  constructor(private readonly db: Database) {}

  async findRepoSpecPullRequest(
    githubRepoId: number,
    number: number,
  ): Promise<RepoSpecPullRequest | null> {
    const [row] = await this.db
      .select()
      .from(repoSpecPullRequests)
      .where(
        and(
          eq(repoSpecPullRequests.githubRepoId, githubRepoId),
          eq(repoSpecPullRequests.number, number),
        ),
      );
    return row ? toSpecPull(row) : null;
  }

  async findOpenRepoSpecPullRequest(repoSpecId: string): Promise<RepoSpecPullRequest | null> {
    const [row] = await this.db
      .select()
      .from(repoSpecPullRequests)
      .where(
        and(
          eq(repoSpecPullRequests.repoSpecId, repoSpecId),
          eq(repoSpecPullRequests.state, "open"),
        ),
      )
      .orderBy(asc(repoSpecPullRequests.createdAt))
      .limit(1);
    return row ? toSpecPull(row) : null;
  }

  async saveRepoSpecPullRequest(pr: RepoSpecPullRequest): Promise<void> {
    const values = {
      githubRepoId: pr.githubRepoId,
      number: pr.number,
      repoSpecId: pr.repoSpecId,
      headBranch: pr.headBranch,
      url: pr.url,
      state: pr.state,
      createdByMemberId: pr.createdByMemberId,
    };
    await this.db
      .insert(repoSpecPullRequests)
      .values(values)
      .onConflictDoUpdate({
        target: [repoSpecPullRequests.githubRepoId, repoSpecPullRequests.number],
        set: {
          repoSpecId: values.repoSpecId,
          headBranch: values.headBranch,
          url: values.url,
          state: values.state,
          createdByMemberId: values.createdByMemberId,
          updatedAt: new Date(),
        },
      });
  }
}
