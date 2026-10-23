// GitHubStore 的契約測試。Server 的 Drizzle 實作也要通過同一組測試：
//
//   import { describeGitHubStoreContract } from "@orbis/github/testing/store-contract";
//   describeGitHubStoreContract("DrizzleGitHubStore", async () => new DrizzleGitHubStore(db));
//
// 傳入的 makeStore 每次都要回傳一個空的 store。

import { describe, expect, it } from "vitest";
import {
  type GitHubStore,
  IssueAlreadyLinkedError,
  type IssueLink,
  type PullRequestLink,
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
