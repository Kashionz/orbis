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
const RepoId = z.object({ id: z.number() });

export const IssuesPayload = z.object({
  action: z.string(),
  issue: IssueResponse,
  repository: Repository,
  sender: Sender,
  installation: Installation.optional(),
});
export type IssuesPayload = z.infer<typeof IssuesPayload>;

export const IssueCommentPayload = z.object({
  action: z.string(),
  comment: z.object({ id: z.number() }),
  issue: z.object({ number: z.number() }),
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
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
  repository: Repository,
  sender: Sender,
});
export type PullRequestPayload = z.infer<typeof PullRequestPayload>;

export const InstallationPayload = z.object({
  action: z.string(),
  installation: Installation,
  repositories: z.array(RepoId).optional(),
  sender: Sender,
});
export type InstallationPayload = z.infer<typeof InstallationPayload>;

export const InstallationRepositoriesPayload = z.object({
  action: z.string(),
  installation: Installation,
  repositories_added: z.array(RepoId),
  repositories_removed: z.array(RepoId),
  sender: Sender,
});
export type InstallationRepositoriesPayload = z.infer<typeof InstallationRepositoriesPayload>;

export type WebhookSender = z.infer<typeof Sender>;
