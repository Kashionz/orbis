// webhook payload 中這個套件用到的欄位。只驗證用得到的部分，其餘欄位原樣忽略。

import { z } from "zod";
import { IssueResponse } from "../client/http";

const Sender = z.object({ id: z.number(), login: z.string(), type: z.string() });
const Repository = z.object({
  id: z.number(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
});
const Installation = z.object({ id: z.number() });
/** installation 事件中的 repo：只有 id 與名稱。 */
const InstalledRepo = z.object({ id: z.number(), full_name: z.string() });

export const IssuesPayload = z.object({
  action: z.string(),
  issue: IssueResponse,
  /** `edited` 時被修改的欄位（`title`、`body`）與修改前的值。 */
  changes: z.record(z.string(), z.unknown()).optional(),
  repository: Repository,
  sender: Sender,
  installation: Installation.optional(),
});
export type IssuesPayload = z.infer<typeof IssuesPayload>;

export const IssueCommentPayload = z.object({
  action: z.string(),
  comment: z.object({
    id: z.number(),
    body: z.string().nullable().optional(),
    user: Sender.optional(),
    html_url: z.string().optional(),
  }),
  /** PR 的對話串也是 Issue 的留言，這時 `issue.pull_request` 有值。 */
  issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }),
  repository: Repository,
  sender: Sender,
});
export type IssueCommentPayload = z.infer<typeof IssueCommentPayload>;

export const PullRequestPayload = z.object({
  action: z.string(),
  number: z.number(),
  pull_request: z.object({
    number: z.number(),
    html_url: z.string(),
    merged: z.boolean().nullable().optional(),
    /** merge 之後 base 分支上的 commit。 */
    merge_commit_sha: z.string().nullable().optional(),
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
  repository: Repository,
  sender: Sender,
});
export type PullRequestPayload = z.infer<typeof PullRequestPayload>;

export const PullRequestReviewPayload = z.object({
  action: z.string(),
  review: z.object({
    id: z.number(),
    user: Sender,
    body: z.string().nullable(),
    /** `commented`、`changes_requested`、`approved`、`dismissed`。 */
    state: z.string(),
    html_url: z.string(),
  }),
  pull_request: z.object({ number: z.number(), html_url: z.string() }),
  repository: Repository,
  sender: Sender,
});
export type PullRequestReviewPayload = z.infer<typeof PullRequestReviewPayload>;

/** check suite／check run 關聯的 PR（只有同一個 repo 的分支才會列出）。 */
const CheckPullRequests = z.array(z.object({ number: z.number() }));

export const CheckSuitePayload = z.object({
  action: z.string(),
  check_suite: z.object({
    id: z.number(),
    head_sha: z.string(),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    pull_requests: CheckPullRequests,
  }),
  repository: Repository,
  sender: Sender,
});
export type CheckSuitePayload = z.infer<typeof CheckSuitePayload>;

export const CheckRunPayload = z.object({
  action: z.string(),
  check_run: z.object({
    id: z.number(),
    name: z.string(),
    head_sha: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    pull_requests: CheckPullRequests,
  }),
  repository: Repository,
  sender: Sender,
});
export type CheckRunPayload = z.infer<typeof CheckRunPayload>;

export const InstallationPayload = z.object({
  action: z.string(),
  installation: Installation,
  repositories: z.array(InstalledRepo).optional(),
  sender: Sender,
});
export type InstallationPayload = z.infer<typeof InstallationPayload>;

export const InstallationRepositoriesPayload = z.object({
  action: z.string(),
  installation: Installation,
  repositories_added: z.array(InstalledRepo),
  repositories_removed: z.array(InstalledRepo),
  sender: Sender,
});
export type InstallationRepositoriesPayload = z.infer<typeof InstallationRepositoriesPayload>;

export type WebhookSender = z.infer<typeof Sender>;
export type InstalledRepo = z.infer<typeof InstalledRepo>;
