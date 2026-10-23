// packages/github 的 GitHubStore 的 Drizzle 實作：Issue 對應與同步快照、webhook delivery 去重、PR 對應。
// 行為以 @orbis/github/testing/store-contract 的契約測試為準（test/github-store.test.ts）。

import {
  type DeliveryClaim,
  type GitHubStore,
  IssueAlreadyLinkedError,
  type IssueLink,
  type IssueSnapshot,
  type PullRequestLink,
} from "@orbis/github";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { githubWebhookDeliveries, pullRequests, taskIssueLinks } from "../db/schema";

type IssueLinkRow = typeof taskIssueLinks.$inferSelect;
type PullRequestRow = typeof pullRequests.$inferSelect;

const toIssueLink = (row: IssueLinkRow): IssueLink => ({
  taskId: row.taskId,
  repoId: row.repoId,
  githubRepoId: row.githubRepoId,
  issueNumber: row.issueNumber,
  issueId: row.issueId,
  issueUrl: row.issueUrl,
  summaryCommentId: row.summaryCommentId,
  summaryHash: row.summaryHash,
  snapshot: row.snapshot as IssueSnapshot,
});

const toPullRequestLink = (row: PullRequestRow): PullRequestLink => ({
  taskId: row.taskId,
  runId: row.runId,
  repoId: row.repoId,
  githubRepoId: row.githubRepoId,
  number: row.number,
  url: row.url,
  headBranch: row.headBranch,
  headSha: row.headSha,
  state: row.state,
});

export class DrizzleGitHubStore implements GitHubStore {
  constructor(private readonly db: Database) {}

  async claimDelivery(input: {
    deliveryId: string;
    event: string;
    now: Date;
    staleAfterMs: number;
  }): Promise<DeliveryClaim> {
    const staleBefore = new Date(input.now.getTime() - input.staleAfterMs);
    // 一個 INSERT … ON CONFLICT DO UPDATE 完成搶處理權：只有沒有紀錄、或處理中但已逾時的才搶得到，
    // 同時送達的請求由資料列鎖決定唯一的勝者。
    const [claimed] = await this.db
      .insert(githubWebhookDeliveries)
      .values({
        deliveryId: input.deliveryId,
        event: input.event,
        status: "processing",
        claimedAt: input.now,
      })
      .onConflictDoUpdate({
        target: githubWebhookDeliveries.deliveryId,
        set: { event: input.event, status: "processing", claimedAt: input.now, completedAt: null },
        setWhere: and(
          eq(githubWebhookDeliveries.status, "processing"),
          or(
            lte(githubWebhookDeliveries.claimedAt, staleBefore),
            isNull(githubWebhookDeliveries.claimedAt),
          ),
        ),
      })
      .returning({ deliveryId: githubWebhookDeliveries.deliveryId });
    if (claimed) return "claimed";
    const [existing] = await this.db
      .select({ status: githubWebhookDeliveries.status })
      .from(githubWebhookDeliveries)
      .where(eq(githubWebhookDeliveries.deliveryId, input.deliveryId));
    return existing?.status === "completed" ? "duplicate" : "in_progress";
  }

  async completeDelivery(deliveryId: string, now: Date): Promise<void> {
    await this.db
      .update(githubWebhookDeliveries)
      .set({ status: "completed", completedAt: now })
      .where(eq(githubWebhookDeliveries.deliveryId, deliveryId));
  }

  async releaseDelivery(deliveryId: string): Promise<void> {
    await this.db
      .delete(githubWebhookDeliveries)
      .where(
        and(
          eq(githubWebhookDeliveries.deliveryId, deliveryId),
          eq(githubWebhookDeliveries.status, "processing"),
        ),
      );
  }

  async getIssueLinkByTask(taskId: string): Promise<IssueLink | null> {
    const [row] = await this.db
      .select()
      .from(taskIssueLinks)
      .where(eq(taskIssueLinks.taskId, taskId));
    return row ? toIssueLink(row) : null;
  }

  async findIssueLinks(githubRepoId: number, issueNumber: number): Promise<IssueLink[]> {
    const rows = await this.db
      .select()
      .from(taskIssueLinks)
      .where(
        and(
          eq(taskIssueLinks.githubRepoId, githubRepoId),
          eq(taskIssueLinks.issueNumber, issueNumber),
        ),
      )
      .orderBy(taskIssueLinks.createdAt, taskIssueLinks.taskId);
    return rows.map(toIssueLink);
  }

  async saveIssueLink(link: IssueLink): Promise<void> {
    const values = {
      repoId: link.repoId,
      githubRepoId: link.githubRepoId,
      issueNumber: link.issueNumber,
      issueId: link.issueId,
      issueUrl: link.issueUrl,
      summaryCommentId: link.summaryCommentId,
      summaryHash: link.summaryHash,
      snapshot: link.snapshot,
    };
    try {
      await this.db
        .insert(taskIssueLinks)
        .values({ taskId: link.taskId, ...values })
        .onConflictDoUpdate({ target: taskIssueLinks.taskId, set: values });
    } catch (error) {
      // 主鍵（taskId）衝突已由 ON CONFLICT 處理，剩下的唯一鍵只有 (repo_id, issue_number)。
      if (isUniqueViolation(error))
        throw new IssueAlreadyLinkedError(link.repoId, link.issueNumber);
      throw error;
    }
  }

  async deleteIssueLink(taskId: string): Promise<void> {
    await this.db.delete(taskIssueLinks).where(eq(taskIssueLinks.taskId, taskId));
  }

  async findPullRequestLink(githubRepoId: number, number: number): Promise<PullRequestLink | null> {
    const [row] = await this.db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.githubRepoId, githubRepoId), eq(pullRequests.number, number)));
    return row ? toPullRequestLink(row) : null;
  }

  async savePullRequestLink(link: PullRequestLink): Promise<void> {
    const values = {
      taskId: link.taskId,
      runId: link.runId,
      repoId: link.repoId,
      url: link.url,
      headBranch: link.headBranch,
      headSha: link.headSha,
      state: link.state,
    };
    await this.db
      .insert(pullRequests)
      .values({ githubRepoId: link.githubRepoId, number: link.number, ...values })
      .onConflictDoUpdate({
        target: [pullRequests.githubRepoId, pullRequests.number],
        set: values,
      });
  }
}
