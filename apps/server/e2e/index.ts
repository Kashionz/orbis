// 給 Web 與 Desktop 的 Playwright 完整系統 e2e 使用的 helper（`@orbis/server/e2e`）。
// 搭配 e2e:stack 的 ready 行使用，用法見 apps/server/README.md。

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signWebhookBody } from "@orbis/github";
import pg from "pg";
import type { ReadyLine } from "./ready";

export { StackCommander } from "./commands";
export {
  aliveIn,
  aliveProcesses,
  descendants,
  descendantsIn,
  type ProcessEntry,
  parseProcessTable,
  processTable,
  processTree,
} from "./process-tree";
export {
  parseReadyLine,
  parseStackReply,
  type ReadyLine,
  type SeededCheckRun,
  type SeededCheckSuite,
  type StackCommand,
  type StackReply,
} from "./ready";

/**
 * D 軌從測試 repo 錄製的真實 webhook payload（`packages/github/test/fixtures/webhooks/`）。
 * 送出的 payload 以它們為底，只替換 PR、repo、installation 與 sender 的欄位，形狀與 GitHub 送來的一致。
 */
function fixturePath(name: string): string {
  return fileURLToPath(
    new URL(`../../../packages/github/test/fixtures/webhooks/${name}.json`, import.meta.url),
  );
}
const PULL_REQUEST_CLOSED_FIXTURE = fixturePath("pull_request.closed");
const PULL_REQUEST_REVIEW_FIXTURE = fixturePath("pull_request_review.submitted.commented");
const CHECK_SUITE_FAILURE_FIXTURE = fixturePath("check_suite.completed.failure");
const CHECK_RUN_FAILURE_FIXTURE = fixturePath("check_run.completed.failure");

// biome-ignore lint/suspicious/noExplicitAny: fixture 是任意 JSON，直接改寫欄位
type Fixture = Record<string, any>;

export interface MergedPullRequest {
  number: number;
  headBranch: string;
  headSha: string;
  url: string;
  taskId: string;
}

export interface SendMergedWebhookResult {
  /** webhook 端點的 HTTP 狀態（處理成功是 200）。 */
  status: number;
  body: unknown;
  pullRequest: MergedPullRequest;
}

/** 依 PR 號碼或 head branch，從 stack 的資料庫找出以 App 開出的 PR（還沒開出時丟出錯誤，可以重試）。 */
export async function findPullRequest(
  ready: ReadyLine,
  target: { prNumber: number } | { branch: string },
): Promise<MergedPullRequest> {
  const client = new pg.Client({ connectionString: ready.databaseUrl });
  await client.connect();
  try {
    const byNumber = "prNumber" in target;
    const { rows } = await client.query<{
      number: number;
      head_branch: string;
      head_sha: string;
      url: string;
      task_id: string;
    }>(
      `select number, head_branch, head_sha, url, task_id from pull_requests
        where github_repo_id = $1 and ${byNumber ? "number = $2" : "head_branch = $2"}
        order by created_at desc limit 1`,
      [ready.github.repo.id, byNumber ? target.prNumber : target.branch],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(
        `stack 中沒有這個 PR：${JSON.stringify(target)}（Review Gate 核准、push 之後才會開 PR）`,
      );
    }
    return {
      number: row.number,
      headBranch: row.head_branch,
      headSha: row.head_sha,
      url: row.url,
      taskId: row.task_id,
    };
  } finally {
    await client.end();
  }
}

/** 組出 `pull_request` closed（merged = true）的 payload。 */
export function pullRequestMergedPayload(
  ready: ReadyLine,
  pullRequest: Pick<MergedPullRequest, "number" | "headBranch" | "headSha" | "url">,
): Record<string, unknown> {
  const payload = JSON.parse(readFileSync(PULL_REQUEST_CLOSED_FIXTURE, "utf8")) as Fixture;
  const { repo } = ready.github;
  payload.action = "closed";
  payload.number = pullRequest.number;
  payload.pull_request = {
    ...payload.pull_request,
    number: pullRequest.number,
    html_url: pullRequest.url,
    state: "closed",
    merged: true,
    head: { ...payload.pull_request.head, ref: pullRequest.headBranch, sha: pullRequest.headSha },
  };
  payload.repository = {
    ...payload.repository,
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { ...payload.repository.owner, login: repo.owner },
  };
  payload.installation = { ...payload.installation, id: repo.installationId };
  return payload;
}

/**
 * 模擬在 GitHub 上 merge 了 stack 以 App 開出的 PR：送出有正確簽章的 `pull_request` closed、
 * merged = true webhook。Server 收到後 Task 轉為 Done（`doneReason = completed`）。
 *
 * ```ts
 * await sendPullRequestMergedWebhook(ready, { branch: run.branch });
 * await sendPullRequestMergedWebhook(ready, { prNumber: 1 });
 * ```
 */
export async function sendPullRequestMergedWebhook(
  ready: ReadyLine,
  target: { prNumber: number } | { branch: string },
): Promise<SendMergedWebhookResult> {
  const pullRequest = await findPullRequest(ready, target);
  const { status, body } = await postWebhook(
    ready,
    "pull_request",
    pullRequestMergedPayload(ready, pullRequest),
  );
  return { status, body, pullRequest };
}

export interface WebhookResult {
  /** webhook 端點的 HTTP 狀態（處理成功是 200）。 */
  status: number;
  body: unknown;
}

/** 以 stack 的 webhook secret 簽章後送到 stack 的 webhook 端點，`X-GitHub-Delivery` 每次隨機產生。 */
export async function postWebhook(
  ready: ReadyLine,
  event: string,
  payload: Record<string, unknown>,
): Promise<WebhookResult> {
  const body = JSON.stringify(payload);
  const res = await fetch(ready.github.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signWebhookBody(ready.github.webhookSecret, body),
    },
    body,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // 不是 JSON 時原樣回傳。
  }
  return { status: res.status, body: parsed };
}

/** 種子資料的 Member 在 GitHub 上的帳號（review 的 sender 用它，`senderCanWrite` 以 Member 身分放行）。 */
export async function memberGithubUser(
  ready: ReadyLine,
): Promise<{ id: number; login: string; type: "User" }> {
  const client = new pg.Client({ connectionString: ready.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ github_user_id: string; github_login: string }>(
      "select github_user_id, github_login from members where id = $1",
      [ready.memberId],
    );
    const row = rows[0];
    if (!row) throw new Error(`stack 中沒有 Member ${ready.memberId}`);
    return { id: Number(row.github_user_id), login: row.github_login, type: "User" };
  } finally {
    await client.end();
  }
}

/** 把錄製的 payload 中的 repository 與 installation 換成 stack 的種子 Repo。 */
function withStackRepo(ready: ReadyLine, payload: Fixture): Fixture {
  const { repo } = ready.github;
  payload.repository = {
    ...payload.repository,
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { ...payload.repository.owner, login: repo.owner },
  };
  payload.installation = { ...payload.installation, id: repo.installationId };
  return payload;
}

let reviewCounter = 0;

/**
 * 組出 `pull_request_review` submitted 的 payload：`state` 是 `commented`（或 `changes_requested`），
 * review 的內容是 `body`，作者是 `author`（人類；要能觸發 Feedback Loop 得是 Member 或對 repo 有寫入權限）。
 */
export function pullRequestReviewPayload(
  ready: ReadyLine,
  pullRequest: Pick<MergedPullRequest, "number" | "headBranch" | "headSha" | "url">,
  options: {
    author: { id: number; login: string; type: "User" | "Bot" };
    body: string;
    state?: "commented" | "changes_requested";
  },
): Record<string, unknown> {
  const payload = JSON.parse(readFileSync(PULL_REQUEST_REVIEW_FIXTURE, "utf8")) as Fixture;
  const reviewId = 7_000_000 + ++reviewCounter + Math.floor(Math.random() * 1_000);
  const user = {
    ...payload.review.user,
    id: options.author.id,
    login: options.author.login,
    type: options.author.type,
    html_url: `https://github.com/${options.author.login}`,
  };
  payload.action = "submitted";
  payload.review = {
    ...payload.review,
    id: reviewId,
    user,
    body: options.body,
    state: options.state ?? "commented",
    commit_id: pullRequest.headSha,
    html_url: `${pullRequest.url}#pullrequestreview-${reviewId}`,
    submitted_at: new Date().toISOString(),
  };
  payload.pull_request = {
    ...payload.pull_request,
    number: pullRequest.number,
    html_url: pullRequest.url,
    state: "open",
    head: { ...payload.pull_request.head, ref: pullRequest.headBranch, sha: pullRequest.headSha },
  };
  payload.sender = user;
  return withStackRepo(ready, payload);
}

/**
 * 模擬有寫入權限的人在 PR 上送出 review（Feedback Loop 的 review 路徑，§5.2）。
 * 作者預設是種子資料的 Member。review 有內容，所以送出時立刻觸發，不等 2 分鐘。
 */
export async function sendPullRequestReviewWebhook(
  ready: ReadyLine,
  target: { prNumber: number } | { branch: string },
  options: {
    body: string;
    state?: "commented" | "changes_requested";
    author?: { id: number; login: string; type: "User" | "Bot" };
  },
): Promise<WebhookResult & { pullRequest: MergedPullRequest }> {
  const pullRequest = await findPullRequest(ready, target);
  const author = options.author ?? (await memberGithubUser(ready));
  const result = await postWebhook(
    ready,
    "pull_request_review",
    pullRequestReviewPayload(ready, pullRequest, { ...options, author }),
  );
  return { ...result, pullRequest };
}

export interface FailedCheck {
  id: number;
  name: string;
  /** 預設 `failure`。 */
  conclusion?: "failure" | "timed_out";
}

/** 組出 `check_suite` completed（failure）的 payload，head 是 PR 目前的 head commit。 */
export function checkSuiteFailurePayload(
  ready: ReadyLine,
  pullRequest: Pick<MergedPullRequest, "number" | "headBranch" | "headSha">,
  options: { suiteId?: number; checkRuns: number },
): Record<string, unknown> {
  const payload = JSON.parse(readFileSync(CHECK_SUITE_FAILURE_FIXTURE, "utf8")) as Fixture;
  const { repo } = ready.github;
  const prRef = {
    ...payload.check_suite.pull_requests[0],
    number: pullRequest.number,
    head: {
      ...payload.check_suite.pull_requests[0].head,
      ref: pullRequest.headBranch,
      sha: pullRequest.headSha,
      repo: { ...payload.check_suite.pull_requests[0].head.repo, id: repo.id, name: repo.name },
    },
  };
  payload.action = "completed";
  payload.check_suite = {
    ...payload.check_suite,
    id: options.suiteId ?? 1,
    head_branch: pullRequest.headBranch,
    head_sha: pullRequest.headSha,
    status: "completed",
    conclusion: "failure",
    latest_check_runs_count: options.checkRuns,
    pull_requests: [prRef],
  };
  return withStackRepo(ready, payload);
}

/** 組出失敗的 `check_run` completed 的 payload，head 是 PR 目前的 head commit。 */
export function checkRunFailurePayload(
  ready: ReadyLine,
  pullRequest: Pick<MergedPullRequest, "number" | "headBranch" | "headSha">,
  check: FailedCheck,
  options: { suiteId?: number } = {},
): Record<string, unknown> {
  const payload = JSON.parse(readFileSync(CHECK_RUN_FAILURE_FIXTURE, "utf8")) as Fixture;
  payload.action = "completed";
  payload.check_run = {
    ...payload.check_run,
    id: check.id,
    name: check.name,
    head_sha: pullRequest.headSha,
    status: "completed",
    conclusion: check.conclusion ?? "failure",
    check_suite: {
      ...payload.check_run.check_suite,
      id: options.suiteId ?? 1,
      head_branch: pullRequest.headBranch,
      head_sha: pullRequest.headSha,
      pull_requests: [
        { ...payload.check_run.check_suite.pull_requests[0], number: pullRequest.number },
      ],
    },
    pull_requests: [{ number: pullRequest.number }],
  };
  return withStackRepo(ready, payload);
}

/**
 * 模擬 PR 目前 head commit 的 CI 失敗（Feedback Loop 的 CI 路徑，§5.2）：先送每個失敗的 `check_run`，
 * 再送 `check_suite` completed。Server 收到後向 FakeGitHub 查這個 commit 的 check suite 與 check run，
 * 所以**送出前**要先以 stack 的 stdin 指令 `seed_checks` 餵進相同的資料（見 `StackCommander`）。
 */
export async function sendCheckFailedWebhooks(
  ready: ReadyLine,
  target: { prNumber: number } | { branch: string },
  checks: FailedCheck[],
  options: { suiteId?: number; totalCheckRuns?: number } = {},
): Promise<{ statuses: number[]; pullRequest: MergedPullRequest }> {
  const pullRequest = await findPullRequest(ready, target);
  const statuses: number[] = [];
  for (const check of checks) {
    const result = await postWebhook(
      ready,
      "check_run",
      checkRunFailurePayload(ready, pullRequest, check, options),
    );
    statuses.push(result.status);
  }
  const suite = await postWebhook(
    ready,
    "check_suite",
    checkSuiteFailurePayload(ready, pullRequest, {
      suiteId: options.suiteId,
      checkRuns: options.totalCheckRuns ?? checks.length,
    }),
  );
  statuses.push(suite.status);
  return { statuses, pullRequest };
}
