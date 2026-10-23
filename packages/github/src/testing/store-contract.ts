// GitHubStore 的契約測試。Server 的 Drizzle 實作也要通過同一組測試：
//
//   import { describeGitHubStoreContract } from "@orbis/github/testing/store-contract";
//   describeGitHubStoreContract("DrizzleGitHubStore", async () => new DrizzleGitHubStore(db));
//
// 傳入的 makeStore 每次都要回傳一個空的 store。Feedback Loop 的資料另外以
// describeFeedbackStoreContract 測試。

import { describe, expect, it } from "vitest";
import {
  type FeedbackBatch,
  type FeedbackFix,
  type FeedbackStore,
  type GitHubStore,
  IssueAlreadyLinkedError,
  type IssueLink,
  type PullRequestLink,
  type RepoSpecPullRequest,
  type RepoSpecStore,
} from "../ports";

const T0 = new Date("2026-10-23T08:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const STALE = 60_000;

function issueLink(overrides: Partial<IssueLink> = {}): IssueLink {
  const at = "2026-10-23T08:00:00Z";
  return {
    taskId: "task-1",
    repoId: "repo-1",
    githubRepoId: 100,
    issueNumber: 7,
    issueId: 7007,
    issueUrl: "https://github.com/acme/app/issues/7",
    summaryCommentId: null,
    summaryHash: null,
    snapshot: {
      title: "標題",
      body: "內容",
      state: "open",
      assignee: null,
      labels: ["bug"],
      syncedAt: { title: at, body: at, state: at, assignee: at, labels: at },
    },
    ...overrides,
  };
}

function pullRequestLink(overrides: Partial<PullRequestLink> = {}): PullRequestLink {
  return {
    taskId: "task-1",
    runId: "run-1",
    repoId: "repo-1",
    githubRepoId: 100,
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    headBranch: "feature/x",
    headSha: "a".repeat(40),
    state: "open",
    ...overrides,
  };
}

function reviewBatch(overrides: Partial<FeedbackBatch> = {}): FeedbackBatch {
  return {
    source: "review",
    githubRepoId: 100,
    prNumber: 12,
    dueAt: later(120_000),
    items: [
      {
        kind: "review_comment",
        id: 501,
        reviewId: 40,
        author: "alice",
        body: "這裡要處理 null",
        url: "https://github.com/acme/app/pull/12#discussion_r501",
        path: "src/a.ts",
        line: 3,
        startLine: null,
        diffHunk: "@@ -1,3 +1,3 @@\n-a\n+b",
      },
    ],
    ...overrides,
  } as FeedbackBatch;
}

function ciBatch(overrides: Partial<FeedbackBatch> = {}): FeedbackBatch {
  return {
    source: "ci",
    githubRepoId: 100,
    prNumber: 12,
    dueAt: T0,
    headSha: "b".repeat(40),
    items: [
      {
        checkRunId: 9001,
        name: "test",
        conclusion: "failure",
        appSlug: "github-actions",
        url: "https://github.com/acme/app/runs/9001",
        outputTitle: null,
        outputSummary: null,
      },
    ],
    ...overrides,
  } as FeedbackBatch;
}

function feedbackFix(overrides: Partial<FeedbackFix> = {}): FeedbackFix {
  return {
    id: "fix-1",
    taskId: "task-1",
    githubRepoId: 100,
    prNumber: 12,
    source: "ci",
    previousRunId: "run-1",
    runId: "run-2",
    trigger: ciBatch(),
    status: "sent",
    commitSha: null,
    prCommentId: null,
    message: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function describeGitHubStoreContract(
  name: string,
  makeStore: () => Promise<GitHubStore>,
): void {
  describe(`GitHubStore 契約：${name}`, () => {
    describe("webhook delivery 去重", () => {
      it("第一次 claim 成功，完成後再 claim 是 duplicate", async () => {
        const store = await makeStore();
        const claim = { deliveryId: "d-1", event: "issues", now: T0, staleAfterMs: STALE };
        expect(await store.claimDelivery(claim)).toBe("claimed");
        await store.completeDelivery("d-1", later(10));
        expect(await store.claimDelivery({ ...claim, now: later(20) })).toBe("duplicate");
        // 完成的紀錄不會因為時間過去而變成可以重新處理
        expect(await store.claimDelivery({ ...claim, now: later(STALE * 10) })).toBe("duplicate");
      });

      it("處理中再 claim 是 in_progress；超過 staleAfterMs 可以重新 claim", async () => {
        const store = await makeStore();
        const claim = { deliveryId: "d-2", event: "issues", now: T0, staleAfterMs: STALE };
        expect(await store.claimDelivery(claim)).toBe("claimed");
        expect(await store.claimDelivery({ ...claim, now: later(STALE - 1) })).toBe("in_progress");
        expect(await store.claimDelivery({ ...claim, now: later(STALE + 1) })).toBe("claimed");
      });

      it("release 之後可以重新 claim", async () => {
        const store = await makeStore();
        const claim = { deliveryId: "d-3", event: "issues", now: T0, staleAfterMs: STALE };
        expect(await store.claimDelivery(claim)).toBe("claimed");
        await store.releaseDelivery("d-3");
        expect(await store.claimDelivery({ ...claim, now: later(1) })).toBe("claimed");
      });

      it("同時 claim 同一個 delivery 只有一個成功", async () => {
        const store = await makeStore();
        const claim = { deliveryId: "d-4", event: "issues", now: T0, staleAfterMs: STALE };
        const results = await Promise.all([1, 2, 3, 4].map(() => store.claimDelivery(claim)));
        expect(results.filter((r) => r === "claimed")).toHaveLength(1);
      });

      it("不同的 delivery 互不影響", async () => {
        const store = await makeStore();
        const base = { event: "issues", now: T0, staleAfterMs: STALE };
        expect(await store.claimDelivery({ ...base, deliveryId: "d-5" })).toBe("claimed");
        expect(await store.claimDelivery({ ...base, deliveryId: "d-6" })).toBe("claimed");
      });
    });

    describe("Issue 對應", () => {
      it("存入後可以用 Task 與 Issue 查到，內容完整保留", async () => {
        const store = await makeStore();
        const link = issueLink({ summaryCommentId: 55, summaryHash: "abc" });
        await store.saveIssueLink(link);
        expect(await store.getIssueLinkByTask("task-1")).toEqual(link);
        expect(await store.findIssueLinks(100, 7)).toEqual([link]);
        expect(await store.findIssueLinks(100, 8)).toEqual([]);
        expect(await store.findIssueLinks(101, 7)).toEqual([]);
      });

      it("以 taskId 覆蓋", async () => {
        const store = await makeStore();
        await store.saveIssueLink(issueLink());
        const updated = issueLink({
          summaryCommentId: 9,
          snapshot: { ...issueLink().snapshot, title: "新" },
        });
        await store.saveIssueLink(updated);
        expect(await store.getIssueLinkByTask("task-1")).toEqual(updated);
        expect(await store.findIssueLinks(100, 7)).toHaveLength(1);
      });

      it("同一個 Issue 可以對應不同 Project 的 Task", async () => {
        const store = await makeStore();
        await store.saveIssueLink(issueLink());
        await store.saveIssueLink(issueLink({ taskId: "task-2", repoId: "repo-2" }));
        const links = await store.findIssueLinks(100, 7);
        expect(links.map((l) => l.taskId).sort()).toEqual(["task-1", "task-2"]);
      });

      it("同一個 Repo 中一個 Issue 只能對應一個 Task", async () => {
        const store = await makeStore();
        await store.saveIssueLink(issueLink());
        await expect(store.saveIssueLink(issueLink({ taskId: "task-2" }))).rejects.toBeInstanceOf(
          IssueAlreadyLinkedError,
        );
        expect((await store.findIssueLinks(100, 7)).map((l) => l.taskId)).toEqual(["task-1"]);
      });

      it("刪除後查不到", async () => {
        const store = await makeStore();
        await store.saveIssueLink(issueLink());
        await store.deleteIssueLink("task-1");
        expect(await store.getIssueLinkByTask("task-1")).toBeNull();
        expect(await store.findIssueLinks(100, 7)).toEqual([]);
      });

      it("回傳的物件被修改不影響存著的資料", async () => {
        const store = await makeStore();
        await store.saveIssueLink(issueLink());
        const read = await store.getIssueLinkByTask("task-1");
        read?.snapshot.labels.push("mutated");
        expect((await store.getIssueLinkByTask("task-1"))?.snapshot.labels).toEqual(["bug"]);
      });
    });

    describe("PR 對應", () => {
      it("存入後可以用 repo 與 PR 編號查到；以 (repo, 編號) 覆蓋", async () => {
        const store = await makeStore();
        await store.savePullRequestLink(pullRequestLink());
        expect(await store.findPullRequestLink(100, 12)).toEqual(pullRequestLink());
        expect(await store.findPullRequestLink(100, 13)).toBeNull();
        await store.savePullRequestLink(pullRequestLink({ state: "merged" }));
        expect((await store.findPullRequestLink(100, 12))?.state).toBe("merged");
      });
    });
  });
}

/**
 * FeedbackStore 的契約測試。Server 的 Drizzle 實作也要通過：
 *
 *   describeFeedbackStoreContract("DrizzleFeedbackStore", async () => new DrizzleFeedbackStore(db));
 */
export function describeFeedbackStoreContract(
  name: string,
  makeStore: () => Promise<FeedbackStore>,
): void {
  describe(`FeedbackStore 契約：${name}`, () => {
    describe("Feedback Loop 的待送批次", () => {
      it("每個 PR 每種來源一批：以 (repo, PR, 來源) 覆蓋，內容完整保留", async () => {
        const store = await makeStore();
        await store.saveFeedbackBatch(reviewBatch());
        await store.saveFeedbackBatch(ciBatch());
        expect(await store.getFeedbackBatch(100, 12, "review")).toEqual(reviewBatch());
        expect(await store.getFeedbackBatch(100, 12, "ci")).toEqual(ciBatch());
        expect(await store.getFeedbackBatch(100, 13, "review")).toBeNull();
        const updated = reviewBatch({ dueAt: later(240_000) });
        await store.saveFeedbackBatch(updated);
        expect(await store.getFeedbackBatch(100, 12, "review")).toEqual(updated);
      });

      it("只列出到期的批次，依到期時間排序", async () => {
        const store = await makeStore();
        await store.saveFeedbackBatch(reviewBatch({ prNumber: 1, dueAt: later(5_000) }));
        await store.saveFeedbackBatch(reviewBatch({ prNumber: 2, dueAt: later(1_000) }));
        await store.saveFeedbackBatch(reviewBatch({ prNumber: 3, dueAt: later(60_000) }));
        const due = await store.listDueFeedbackBatches(later(5_000));
        expect(due.map((b) => b.prNumber)).toEqual([2, 1]);
      });

      it("刪除後查不到，不影響另一種來源", async () => {
        const store = await makeStore();
        await store.saveFeedbackBatch(reviewBatch());
        await store.saveFeedbackBatch(ciBatch());
        await store.deleteFeedbackBatch(100, 12, "review");
        expect(await store.getFeedbackBatch(100, 12, "review")).toBeNull();
        expect(await store.getFeedbackBatch(100, 12, "ci")).not.toBeNull();
      });
    });

    describe("自動修正紀錄", () => {
      it("以 id 覆蓋；依 PR 列出時依建立時間排序；可以用 Run 查到", async () => {
        const store = await makeStore();
        await store.saveFeedbackFix(
          feedbackFix({ id: "fix-b", runId: "run-b", createdAt: later(10) }),
        );
        await store.saveFeedbackFix(feedbackFix({ id: "fix-a", runId: "run-a", createdAt: T0 }));
        await store.saveFeedbackFix(feedbackFix({ id: "fix-c", prNumber: 13, runId: "run-c" }));
        expect((await store.listFeedbackFixes(100, 12)).map((f) => f.id)).toEqual([
          "fix-a",
          "fix-b",
        ]);
        const pushed = feedbackFix({
          id: "fix-a",
          runId: "run-a",
          status: "pushed",
          commitSha: "c".repeat(40),
          prCommentId: 777,
          updatedAt: later(20),
        });
        await store.saveFeedbackFix(pushed);
        expect(await store.findFeedbackFixByRun("run-a")).toEqual(pushed);
        expect(await store.findFeedbackFixByRun("run-x")).toBeNull();
      });

      it("沒有開成 Run 的紀錄（runId 為 null）也能保存", async () => {
        const store = await makeStore();
        const failed = feedbackFix({ runId: null, status: "failed", message: "Runner 離線" });
        await store.saveFeedbackFix(failed);
        expect(await store.listFeedbackFixes(100, 12)).toEqual([failed]);
      });
    });
  });
}

function repoSpecPullRequest(overrides: Partial<RepoSpecPullRequest> = {}): RepoSpecPullRequest {
  return {
    repoSpecId: "spec-1",
    githubRepoId: 100,
    number: 30,
    url: "https://github.com/acme/app/pull/30",
    headBranch: "spec/design-abc123",
    state: "open",
    createdByMemberId: "member-1",
    ...overrides,
  };
}

/**
 * RepoSpecStore 的契約測試。Server 的 Drizzle 實作也要通過：
 *
 *   describeRepoSpecStoreContract("DrizzleRepoSpecStore", async () => new DrizzleRepoSpecStore(db));
 */
export function describeRepoSpecStoreContract(
  name: string,
  makeStore: () => Promise<RepoSpecStore>,
): void {
  describe(`RepoSpecStore 契約：${name}`, () => {
    it("存入後可以用 repo 與 PR 編號查到；以 (repo, 編號) 覆蓋", async () => {
      const store = await makeStore();
      await store.saveRepoSpecPullRequest(repoSpecPullRequest());
      expect(await store.findRepoSpecPullRequest(100, 30)).toEqual(repoSpecPullRequest());
      expect(await store.findRepoSpecPullRequest(100, 31)).toBeNull();
      await store.saveRepoSpecPullRequest(repoSpecPullRequest({ state: "merged" }));
      expect((await store.findRepoSpecPullRequest(100, 30))?.state).toBe("merged");
    });

    it("只回傳這份 Spec 還開著的 PR", async () => {
      const store = await makeStore();
      await store.saveRepoSpecPullRequest(repoSpecPullRequest({ number: 30, state: "merged" }));
      await store.saveRepoSpecPullRequest(repoSpecPullRequest({ number: 31, state: "closed" }));
      expect(await store.findOpenRepoSpecPullRequest("spec-1")).toBeNull();
      await store.saveRepoSpecPullRequest(repoSpecPullRequest({ number: 32 }));
      await store.saveRepoSpecPullRequest(
        repoSpecPullRequest({ number: 33, repoSpecId: "spec-2", createdByMemberId: null }),
      );
      expect((await store.findOpenRepoSpecPullRequest("spec-1"))?.number).toBe(32);
      expect(await store.findOpenRepoSpecPullRequest("spec-2")).toEqual(
        repoSpecPullRequest({ number: 33, repoSpecId: "spec-2", createdByMemberId: null }),
      );
    });
  });
}
