// GitHubStore 的 in-memory 實作：測試與 dev harness 使用。

import type { DeliveryClaim, GitHubStore, IssueLink, PullRequestLink } from "../ports";

interface DeliveryRow {
  event: string;
  claimedAt: Date;
  completedAt: Date | null;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryGitHubStore implements GitHubStore {
  readonly deliveries = new Map<string, DeliveryRow>();
  readonly issueLinks = new Map<string, IssueLink>();
  readonly pullRequestLinks = new Map<string, PullRequestLink>();

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
}
