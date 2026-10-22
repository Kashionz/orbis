// 呼叫 GitHub REST API 的介面。只放這個套件用得到的操作；測試用 FakeGitHub 替換，不連到真的 GitHub。

import type { InstallationToken } from "../auth/installation-tokens";

export interface RepoRef {
  owner: string;
  name: string;
}

export interface GitHubUserRef {
  id: number;
  login: string;
  /** `User`、`Bot` 或 `Organization`。 */
  type: string;
}

export interface GitHubRepository {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  htmlUrl: string;
}

export type IssueState = "open" | "closed";
export type IssueStateReason = "completed" | "not_planned" | "reopened";

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  /** GitHub 上沒有內容時是空字串（API 回 null）。 */
  body: string;
  state: IssueState;
  stateReason: IssueStateReason | null;
  assignees: GitHubUserRef[];
  /** label 名稱。 */
  labels: string[];
  /** ISO 8601。 */
  updatedAt: string;
  htmlUrl: string;
  /** Issues API 也會回傳 PR；匯入時要排除。 */
  isPullRequest: boolean;
}

export interface IssueInput {
  title: string;
  body: string;
  /** GitHub login。 */
  assignees: string[];
  labels: string[];
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: IssueState;
  stateReason?: IssueStateReason;
  assignees?: string[];
  labels?: string[];
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  htmlUrl: string;
  state: IssueState;
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
}

export interface PullRequestInput {
  title: string;
  body: string;
  /** 分支名稱（同一個 repo）。 */
  head: string;
  base: string;
}

export interface GitHubClient {
  /** 以 App 身分查詢 App 是否安裝在這個 repo；沒有安裝（或 repo 不存在）時回傳 null。 */
  findRepoInstallation(repo: RepoRef): Promise<{ installationId: number } | null>;
  /** 換一個新的 installation token（不經過快取）。 */
  createInstallationToken(installationId: number): Promise<InstallationToken>;
  /** 取得 installation token（經過快取）。 */
  installationToken(installationId: number): Promise<string>;
  /** 丟掉某個 installation 的 token 快取。 */
  forgetInstallation(installationId: number): void;

  getRepo(installationId: number, repo: RepoRef): Promise<GitHubRepository | null>;
  getIssue(installationId: number, repo: RepoRef, number: number): Promise<GitHubIssue | null>;
  /** 列出所有 open 的 Issue（不含 PR）。 */
  listOpenIssues(installationId: number, repo: RepoRef): Promise<GitHubIssue[]>;
  createIssue(installationId: number, repo: RepoRef, input: IssueInput): Promise<GitHubIssue>;
  updateIssue(
    installationId: number,
    repo: RepoRef,
    number: number,
    patch: IssuePatch,
  ): Promise<GitHubIssue>;
  createIssueComment(
    installationId: number,
    repo: RepoRef,
    issueNumber: number,
    body: string,
  ): Promise<{ id: number }>;
  /** 留言已被刪除時回傳 null。 */
  updateIssueComment(
    installationId: number,
    repo: RepoRef,
    commentId: number,
    body: string,
  ): Promise<{ id: number } | null>;

  /** 找出 head 是這個分支、還開著的 PR。 */
  findOpenPullRequest(
    installationId: number,
    repo: RepoRef,
    head: string,
  ): Promise<GitHubPullRequest | null>;
  createPullRequest(
    installationId: number,
    repo: RepoRef,
    input: PullRequestInput,
  ): Promise<GitHubPullRequest>;
}

export class GitHubApiError extends Error {
  override name = "GitHubApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
