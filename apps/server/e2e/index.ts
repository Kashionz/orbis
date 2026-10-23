// 給 Web 與 Desktop 的 Playwright 完整系統 e2e 使用的 helper（`@orbis/server/e2e`）。
// 搭配 e2e:stack 的 ready 行使用，用法見 apps/server/README.md。

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signWebhookBody } from "@orbis/github";
import pg from "pg";
import type { ReadyLine } from "./ready";

export { parseReadyLine, type ReadyLine } from "./ready";

/**
 * D 軌從測試 repo 錄製的真實 `pull_request.closed` payload。送出的 payload 以它為底，
 * 只替換 PR、repo、installation 的欄位，形狀與 GitHub 送來的一致。
 */
const PULL_REQUEST_CLOSED_FIXTURE = fileURLToPath(
  new URL(
    "../../../packages/github/test/fixtures/webhooks/pull_request.closed.json",
    import.meta.url,
  ),
);

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

/** 依 PR 號碼或 head branch，從 stack 的資料庫找出以 App 開出的 PR。 */
async function findPullRequest(
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
  const body = JSON.stringify(pullRequestMergedPayload(ready, pullRequest));
  const res = await fetch(ready.github.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
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
  return { status: res.status, body: parsed, pullRequest };
}
