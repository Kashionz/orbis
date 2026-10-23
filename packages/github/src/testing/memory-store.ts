// GitHubStore 與 FeedbackStore 的 in-memory 實作：測試與 dev harness 使用。

import {
  type DeliveryClaim,
  type FeedbackBatch,
  type FeedbackFix,
  type FeedbackSource,
  type FeedbackStore,
  type GitHubStore,
  IssueAlreadyLinkedError,
  type IssueLink,
  type PullRequestLink,
} from "../ports";

interface DeliveryRow {
  event: string;
  claimedAt: Date;
  completedAt: Date | null;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryGitHubStore implements GitHubStore, FeedbackStore {
  readonly deliveries = new Map<string, DeliveryRow>();
  readonly issueLinks = new Map<string, IssueLink>();
  readonly pullRequestLinks = new Map<string, PullRequestLink>();
  readonly feedbackBatches = new Map<string, FeedbackBatch>();
  readonly feedbackFixes = new Map<string, FeedbackFix>();

  async claimDelivery(input: {
    deliveryId: string;
    event: string;
    now: Date;
    staleAfterMs: number;
  }): Promise<DeliveryClaim> {
    const row = this.deliveries.get(input.deliveryId);
    if (row?.completedAt) return "duplicate";
    if (row && input.now.getTime() - row.claimedAt.getTime() < input.staleAfterMs) {
      return "in_progress";
    }
    this.deliveries.set(input.deliveryId, {
      event: input.event,
      claimedAt: input.now,
      completedAt: null,
    });
    return "claimed";
  }

  async completeDelivery(deliveryId: string, now: Date): Promise<void> {
    const row = this.deliveries.get(deliveryId);
    if (row) row.completedAt = now;
  }

  async releaseDelivery(deliveryId: string): Promise<void> {
    const row = this.deliveries.get(deliveryId);
    if (row && !row.completedAt) this.deliveries.delete(deliveryId);
  }

  async getIssueLinkByTask(taskId: string): Promise<IssueLink | null> {
    const link = this.issueLinks.get(taskId);
    return link ? clone(link) : null;
  }

  async findIssueLinks(githubRepoId: number, issueNumber: number): Promise<IssueLink[]> {
    return [...this.issueLinks.values()]
      .filter((l) => l.githubRepoId === githubRepoId && l.issueNumber === issueNumber)
      .map(clone);
  }

  async saveIssueLink(link: IssueLink): Promise<void> {
    for (const other of this.issueLinks.values()) {
      if (
        other.taskId !== link.taskId &&
        other.repoId === link.repoId &&
        other.issueNumber === link.issueNumber
      ) {
        throw new IssueAlreadyLinkedError(link.repoId, link.issueNumber);
      }
    }
    this.issueLinks.set(link.taskId, clone(link));
  }

  async deleteIssueLink(taskId: string): Promise<void> {
    this.issueLinks.delete(taskId);
  }

  async findPullRequestLink(githubRepoId: number, number: number): Promise<PullRequestLink | null> {
    const link = this.pullRequestLinks.get(`${githubRepoId}#${number}`);
    return link ? clone(link) : null;
  }

  async savePullRequestLink(link: PullRequestLink): Promise<void> {
    this.pullRequestLinks.set(`${link.githubRepoId}#${link.number}`, clone(link));
  }

  async getFeedbackBatch(githubRepoId: number, prNumber: number, source: FeedbackSource) {
    const batch = this.feedbackBatches.get(`${githubRepoId}#${prNumber}#${source}`);
    return batch ? clone(batch) : null;
  }

  async saveFeedbackBatch(batch: FeedbackBatch): Promise<void> {
    this.feedbackBatches.set(
      `${batch.githubRepoId}#${batch.prNumber}#${batch.source}`,
      clone(batch),
    );
  }

  async deleteFeedbackBatch(githubRepoId: number, prNumber: number, source: FeedbackSource) {
    this.feedbackBatches.delete(`${githubRepoId}#${prNumber}#${source}`);
  }

  async listDueFeedbackBatches(now: Date): Promise<FeedbackBatch[]> {
    return [...this.feedbackBatches.values()]
      .filter((b) => b.dueAt.getTime() <= now.getTime())
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .map(clone);
  }

  async saveFeedbackFix(fix: FeedbackFix): Promise<void> {
    this.feedbackFixes.set(fix.id, clone(fix));
  }

  async listFeedbackFixes(githubRepoId: number, prNumber: number): Promise<FeedbackFix[]> {
    return [...this.feedbackFixes.values()]
      .filter((f) => f.githubRepoId === githubRepoId && f.prNumber === prNumber)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async findFeedbackFixByRun(runId: string): Promise<FeedbackFix | null> {
    const fix = [...this.feedbackFixes.values()].find((f) => f.runId === runId);
    return fix ? clone(fix) : null;
  }
}
