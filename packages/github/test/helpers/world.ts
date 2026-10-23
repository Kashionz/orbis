// 測試共用的環境：FakeGitHub、FakeDomainService、in-memory store，以及以錄製的真實 payload
// （test/fixtures/webhooks）為底組出 webhook 的輔助函式。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  GitHubCheckRun,
  GitHubIssue,
  GitHubReviewComment,
  GitHubUserRef,
} from "../../src/client/types";
import { createGitHubIntegration, type GitHubIntegration } from "../../src/integration";
import type { MemberRecord, TaskRecord } from "../../src/ports";
import {
  FakeDomainService,
  FakeFeedbackRuns,
  FakeGitHub,
  type FakeRepo,
  FakeRepoSpecs,
  InMemoryGitHubStore,
  MemoryLogger,
  RecordingNotifier,
  TestClock,
} from "../../src/testing";
import { signWebhookBody } from "../../src/webhook/verify";

export const WEBHOOK_SECRET = "test-webhook-secret";
export const APP_SLUG = "acme-pm";
export const PROJECT_ID = "project-1";
export const REPO_ID = "repo-1";
/** 以 onBranchPushed 開出的 PR 的 head commit。 */
export const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/webhooks/", import.meta.url));

/** 讀取錄製的 webhook payload。每次回傳新的物件。 */
// biome-ignore lint/suspicious/noExplicitAny: fixture 是任意 JSON，測試中直接改寫欄位
export function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8"));
}

/** webhook payload 中的使用者物件（以 fixture 的欄位為底）。 */
function userObject(base: Record<string, unknown>, user: GitHubUserRef): Record<string, unknown> {
  return {
    ...base,
    id: user.id,
    login: user.login,
    type: user.type,
    html_url: `https://github.com/${user.login}`,
  };
}

export interface World {
  clock: TestClock;
  github: FakeGitHub;
  domain: FakeDomainService;
  store: InMemoryGitHubStore;
  notifier: RecordingNotifier;
  logger: MemoryLogger;
  integration: GitHubIntegration;
  repo: FakeRepo;
  bot: GitHubUserRef;
  alice: MemberRecord;
  bob: MemberRecord;
  /** 不是 Team 成員的 GitHub 帳號。 */
  outsider: GitHubUserRef;
  addTask(overrides?: Partial<TaskRecord>): TaskRecord;
  /** 簽名後送出 webhook。 */
  deliver(
    event: string,
    payload: unknown,
    options?: { deliveryId?: string },
  ): ReturnType<GitHubIntegration["handleWebhook"]>;
  /**
   * 以錄製的 `issues.<action>` 為底組出 payload。`edited` 的 `changes` 預設是 title 與 body，
   * 可以用 `changes` 指定（GitHub 只列出真的被改的欄位）。
   */
  issuePayload(
    action: string,
    issue: GitHubIssue,
    sender: GitHubUserRef,
    options?: { changes?: ("title" | "body")[] },
  ): unknown;
  pullRequestPayload(
    action: "closed" | "reopened" | "opened",
    number: number,
    options: { merged: boolean; sender: GitHubUserRef },
  ): unknown;
  userRef(member: MemberRecord): GitHubUserRef;

  // ── Repo Spec ──
  repoSpecs: FakeRepoSpecs;

  // ── Feedback Loop ──
  feedbackRuns: FakeFeedbackRuns;
  /** Project 的 bot 白名單。 */
  botAllowlist: string[];
  /** 寫下的 Task note。 */
  taskNotes: { taskId: string; runId: string | null; body: string; url: string | null }[];
  /** 以 App 開出一個 PR（Review Gate 核准後 push 完成）。 */
  openPullRequest(overrides?: Partial<TaskRecord>): Promise<{ task: TaskRecord; number: number }>;
  /** 以錄製的 `pull_request_review.submitted` 為底；行內留言放進 FakeGitHub。 */
  reviewPayload(
    number: number,
    options: {
      author: GitHubUserRef;
      state?: string;
      body?: string | null;
      comments?: Partial<GitHubReviewComment>[];
    },
  ): Record<string, unknown>;
  /** 以錄製的 `issue_comment.created`（PR 上的留言）為底。 */
  prCommentPayload(number: number, options: { author: GitHubUserRef; body: string }): unknown;
  /** 以錄製的 `check_suite.completed` 為底。 */
  checkSuitePayload(number: number, options?: { sha?: string; conclusion?: string }): unknown;
  /** 以錄製的 `check_run.completed` 為底。 */
  checkRunPayload(
    number: number,
    run: Pick<GitHubCheckRun, "id" | "name" | "conclusion">,
    options?: { sha?: string },
  ): unknown;
  /** 設定 commit 的 CI 狀態：一個 GitHub Actions 的 suite，加上沒有 check run 的部署服務 suite。 */
  setChecks(
    sha: string,
    runs: Partial<GitHubCheckRun>[],
    options?: { suiteStatus?: string; extraSuites?: { status: string; runs: number }[] },
  ): void;
}

let deliveryCounter = 0;
let idCounter = 50_000;

export function createWorld(options: { feedback?: boolean; repoSpecs?: boolean } = {}): World {
  const clock = new TestClock();
  const bot: GitHubUserRef = { id: 9_000_001, login: `${APP_SLUG}[bot]`, type: "Bot" };
  const github = new FakeGitHub(clock, bot);
  // 與 fixture 中的 repository 相同，讓錄製的 payload 原樣也對得上。
  const base = fixture("issues.edited").repository as {
    id: number;
    name: string;
    owner: { login: string };
  };
  const repo = github.addRepo({
    id: base.id,
    owner: base.owner.login,
    name: base.name,
    defaultBranch: "main",
    installationId: 2_311_213,
  });
  const domain = new FakeDomainService(clock);
  domain.addRepo({
    id: REPO_ID,
    projectId: PROJECT_ID,
    owner: repo.owner,
    name: repo.name,
    githubRepoId: repo.id,
    defaultBranch: "main",
    installationId: repo.installationId,
  });
  const alice = domain.addMember(
    { id: "member-alice", githubUserId: 21_031_067, githubLogin: "Codertocat" },
    [PROJECT_ID],
  );
  const bob = domain.addMember({ id: "member-bob", githubUserId: 2002, githubLogin: "bob" }, [
    PROJECT_ID,
  ]);
  const outsider: GitHubUserRef = { id: 3003, login: "outsider", type: "User" };
  for (const m of [alice, bob])
    github.addUser({ id: m.githubUserId, login: m.githubLogin, type: "User" });
  github.addUser(outsider);
  // Team 成員對 repo 有寫入權限；outsider 沒有
  github.roles.set(alice.githubLogin, "write");
  github.roles.set(bob.githubLogin, "admin");

  const store = new InMemoryGitHubStore();
  const notifier = new RecordingNotifier();
  const logger = new MemoryLogger();
  const feedbackRuns = new FakeFeedbackRuns();
  const repoSpecs = new FakeRepoSpecs();
  const botAllowlist: string[] = [];
  const taskNotes: World["taskNotes"] = [];
  const integration = createGitHubIntegration({
    ...(options.repoSpecs === false
      ? {}
      : {
          repoSpecs: {
            store,
            getRepoSpec: (id: string) => repoSpecs.getRepoSpec(id),
            recordRepoSpecMerged: (
              id: string,
              merged: { commitSha: string; blobSha: string | null; pullRequestUrl: string },
            ) => repoSpecs.recordRepoSpecMerged(id, merged),
          },
        }),
    ...(options.feedback === false
      ? {}
      : {
          feedback: {
            store,
            runs: feedbackRuns,
            botAllowlist: async (projectId: string) =>
              projectId === PROJECT_ID ? [...botAllowlist] : [],
            addTaskNote: async (note: World["taskNotes"][number]) => {
              taskNotes.push(structuredClone(note));
            },
          },
        }),
    config: { appId: 1, privateKey: "unused", webhookSecret: WEBHOOK_SECRET, slug: APP_SLUG },
    client: github,
    domain,
    store,
    notifier,
    logger,
    taskUrl: (task) => `https://pm.test/tasks/${task.key}`,
    now: () => clock.now(),
  });

  const userRef = (member: MemberRecord): GitHubUserRef => ({
    id: member.githubUserId,
    login: member.githubLogin,
    type: "User",
  });

  // biome-ignore lint/suspicious/noExplicitAny: fixture 是任意 JSON
  const sandboxRepository = (payload: Record<string, any>) => ({
    ...payload.repository,
    id: repo.id,
    name: repo.name,
    owner: { ...payload.repository.owner, login: repo.owner },
  });

  return {
    repoSpecs,
    feedbackRuns,
    botAllowlist,
    taskNotes,

    async openPullRequest(overrides = {}) {
      const task = domain.addTask({
        projectId: PROJECT_ID,
        repoId: REPO_ID,
        title: "修正 README 的錯字",
        description: "README 第 3 行拼錯了。",
        createdByMemberId: alice.id,
        status: "pr_open",
        assigneeMemberId: alice.id,
        ...overrides,
      });
      const result = await integration.onBranchPushed({
        taskId: task.id,
        runId: "run-1",
        branch: `feature/${task.key}`,
        commitSha: HEAD_SHA,
      });
      if (!result.ok) throw new Error(result.message);
      return { task, number: result.number };
    },

    reviewPayload(number, opts) {
      const payload = fixture("pull_request_review.submitted.commented");
      const reviewId = ++idCounter;
      const author = userObject(payload.review.user, opts.author);
      payload.review = {
        ...payload.review,
        id: reviewId,
        user: author,
        body: opts.body === undefined ? "" : opts.body,
        state: opts.state ?? "commented",
        html_url: `${repo.htmlUrl}/pull/${number}#pullrequestreview-${reviewId}`,
      };
      payload.pull_request = {
        ...payload.pull_request,
        number,
        html_url: `${repo.htmlUrl}/pull/${number}`,
      };
      payload.repository = sandboxRepository(payload);
      payload.sender = author;
      github.reviewComments.set(
        reviewId,
        (opts.comments ?? []).map((c) => {
          const id = c.id ?? ++idCounter;
          return {
            id,
            reviewId,
            user: opts.author,
            body: "請修正",
            path: "src/calculator.html",
            line: 7,
            startLine: null,
            side: "RIGHT" as const,
            diffHunk:
              "@@ -3,7 +3,8 @@\n <head>\n-  <title>計算機</title>\n+  <title>計算機（D2 測試）</title>",
            htmlUrl: `${repo.htmlUrl}/pull/${number}#discussion_r${id}`,
            ...c,
          };
        }),
      );
      return payload;
    },

    prCommentPayload(number, opts) {
      const payload = fixture("issue_comment.created.pr");
      const id = ++idCounter;
      const author = userObject(payload.comment.user, opts.author);
      payload.issue = { ...payload.issue, number };
      payload.comment = {
        ...payload.comment,
        id,
        body: opts.body,
        user: author,
        html_url: `${repo.htmlUrl}/pull/${number}#issuecomment-${id}`,
      };
      payload.repository = sandboxRepository(payload);
      payload.sender = author;
      return payload;
    },

    checkSuitePayload(number, opts = {}) {
      const payload = fixture("check_suite.completed.failure");
      payload.check_suite = {
        ...payload.check_suite,
        head_sha: opts.sha ?? HEAD_SHA,
        conclusion: opts.conclusion ?? "failure",
        pull_requests: [{ ...payload.check_suite.pull_requests[0], number }],
      };
      payload.repository = sandboxRepository(payload);
      return payload;
    },

    checkRunPayload(number, run, opts = {}) {
      const payload = fixture("check_run.completed.failure");
      payload.check_run = {
        ...payload.check_run,
        id: run.id,
        name: run.name,
        conclusion: run.conclusion,
        head_sha: opts.sha ?? HEAD_SHA,
        pull_requests: [{ ...payload.check_run.pull_requests[0], number }],
      };
      payload.repository = sandboxRepository(payload);
      return payload;
    },

    setChecks(sha, runs, opts = {}) {
      github.checkSuites.set(sha, [
        {
          id: 1,
          appSlug: "github-actions",
          status: opts.suiteStatus ?? "completed",
          conclusion: runs.some((r) => r.conclusion === "failure") ? "failure" : "success",
          latestCheckRunsCount: runs.length,
        },
        // 安裝了但沒有在跑 check 的 App：一直是 queued、沒有 check run
        { id: 2, appSlug: "vercel", status: "queued", conclusion: null, latestCheckRunsCount: 0 },
        ...(opts.extraSuites ?? []).map((extra, i) => ({
          id: 10 + i,
          appSlug: `ci-${i}`,
          status: extra.status,
          conclusion: null,
          latestCheckRunsCount: extra.runs,
        })),
      ]);
      github.checkRuns.set(
        sha,
        runs.map((r, i) => ({
          id: r.id ?? 9000 + i,
          name: r.name ?? `job-${i}`,
          status: r.status ?? "completed",
          conclusion: r.conclusion ?? "success",
          appSlug: r.appSlug ?? "github-actions",
          htmlUrl: r.htmlUrl ?? `${repo.htmlUrl}/actions/runs/1/job/${r.id ?? 9000 + i}`,
          outputTitle: r.outputTitle ?? null,
          outputSummary: r.outputSummary ?? null,
        })),
      );
    },

    clock,
    github,
    domain,
    store,
    notifier,
    logger,
    integration,
    repo,
    bot,
    alice,
    bob,
    outsider,
    userRef,

    addTask(overrides = {}) {
      return domain.addTask({
        projectId: PROJECT_ID,
        repoId: REPO_ID,
        title: "修正 README 的錯字",
        description: "README 第 3 行拼錯了。",
        createdByMemberId: alice.id,
        ...overrides,
      });
    },

    deliver(event, payload, options = {}) {
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const headers = new Headers({
        "x-github-event": event,
        "x-github-delivery": options.deliveryId ?? `delivery-${++deliveryCounter}`,
        "x-hub-signature-256": signWebhookBody(WEBHOOK_SECRET, body),
        "content-type": "application/json",
      });
      return integration.handleWebhook({ headers, body });
    },

    issuePayload(action, issue, sender, options = {}) {
      const payload = fixture(`issues.${action}`);
      if (action === "edited") {
        payload.changes = Object.fromEntries(
          (options.changes ?? ["title", "body"]).map((field) => [field, { from: "（修改前）" }]),
        );
      }
      const userBase = payload.sender as Record<string, unknown>;
      const labelBase = (payload.issue.labels?.[0] ?? { id: 1, color: "ededed" }) as Record<
        string,
        unknown
      >;
      const assignees = issue.assignees.map((a) => userObject(userBase, a));
      payload.issue = {
        ...payload.issue,
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body === "" ? null : issue.body,
        state: issue.state,
        state_reason: issue.stateReason,
        assignee: assignees[0] ?? null,
        assignees,
        labels: issue.labels.map((name) => ({ ...labelBase, name })),
        updated_at: issue.updatedAt,
        html_url: issue.htmlUrl,
      };
      payload.repository = {
        ...payload.repository,
        id: repo.id,
        name: repo.name,
        owner: { ...payload.repository.owner, login: repo.owner },
      };
      payload.sender = userObject(userBase, sender);
      return payload;
    },

    pullRequestPayload(action, number, options) {
      const payload = fixture(`pull_request.${action}`);
      const pull = github.pulls.get(repo.id)?.find((p) => p.number === number);
      payload.number = number;
      payload.pull_request = {
        ...payload.pull_request,
        number,
        html_url: `${repo.htmlUrl}/pull/${number}`,
        state: action === "reopened" || action === "opened" ? "open" : "closed",
        merged: options.merged,
        head: { ...payload.pull_request.head, ref: pull?.headRef ?? "feature", sha: pull?.headSha },
      };
      payload.repository = { ...payload.repository, id: repo.id, name: repo.name };
      payload.sender = userObject(payload.sender as Record<string, unknown>, options.sender);
      return payload;
    },
  };
}
