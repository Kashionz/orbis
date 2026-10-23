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
/** `duplicate` 是 GitHub 後來加入的關閉原因，同步時視為 `not_planned`。 */
export type IssueStateReason = "completed" | "not_planned" | "duplicate" | "reopened";

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

/** PR 的行內留言（review comment）。 */
export interface GitHubReviewComment {
  id: number;
  reviewId: number | null;
  user: GitHubUserRef;
  body: string;
  path: string;
  /** 留言所在的行（新版本或舊版本，依 `side`）；留言所在的行已經不在 diff 中時是 null。 */
  line: number | null;
  /** 多行留言的起始行；單行留言是 null。 */
  startLine: number | null;
  side: "LEFT" | "RIGHT" | null;
  /** 留言位置附近的 diff 片段。 */
  diffHunk: string;
  htmlUrl: string;
}

/** check suite 的狀態（`GET /commits/{ref}/check-suites`）。 */
export interface GitHubCheckSuite {
  id: number;
  /** 建立這個 suite 的 App，例如 `github-actions`。 */
  appSlug: string;
  status: string;
  conclusion: string | null;
  /**
   * suite 中的 check run 數。安裝了 App 但沒有在跑 check 的（例如部署服務）會留下一個一直是 `queued`、
   * 沒有 check run 的 suite。
   */
  latestCheckRunsCount: number;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  appSlug: string;
  htmlUrl: string;
  /** output 的 title、summary；GitHub Actions 的 check run 通常是 null（錯誤只在 job log 中）。 */
  outputTitle: string | null;
  outputSummary: string | null;
}

export interface TokenScope {
  repositoryIds: number[];
  permissions: Record<string, "read" | "write">;
}

export type RepoRole = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/** 有寫入權限的角色。 */
export const WRITE_ROLES: ReadonlySet<RepoRole> = new Set(["admin", "maintain", "write"]);

export interface GitHubClient {
  /** 以 App 身分查詢 App 是否安裝在這個 repo；沒有安裝（或 repo 不存在）時回傳 null。 */
  findRepoInstallation(repo: RepoRef): Promise<{ installationId: number } | null>;
  /**
   * 換一個新的 installation token（不經過快取）。指定 scope 時 token 只能存取這些 repo、只有這些權限，
   * 用來交給 Team Runner push（最小權限）。
   */
  createInstallationToken(installationId: number, scope?: TokenScope): Promise<InstallationToken>;
  /** 取得 installation token（經過快取）。 */
  installationToken(installationId: number): Promise<string>;
  /** 丟掉某個 installation 的 token 快取。 */
  forgetInstallation(installationId: number): void;
  /** 這個 installation 能存取的 repo（`GET /installation/repositories`）。 */
  listInstallationRepositories(installationId: number): Promise<{ id: number; fullName: string }[]>;
  /**
   * 使用者對 repo 的角色（`GET /repos/{owner}/{repo}/collaborators/{username}/permission` 的 `role_name`）。
   * 不是 collaborator 時回傳 `none`。查詢用 login，但回應的 user id 必須等於 `user.id`，否則也回傳 `none`
   * （login 可以改名，舊名稱可能被別人註冊；Member 的 login 只是登入時的快照）。
   */
  getCollaboratorRole(
    installationId: number,
    repo: RepoRef,
    user: { login: string; id: number },
  ): Promise<RepoRole>;

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

  /** 一份 review 中的行內留言。 */
  listReviewComments(
    installationId: number,
    repo: RepoRef,
    pullNumber: number,
    reviewId: number,
  ): Promise<GitHubReviewComment[]>;
  /** 這個 commit 的所有 check suite。 */
  listCheckSuites(installationId: number, repo: RepoRef, sha: string): Promise<GitHubCheckSuite[]>;
  /** 這個 commit 最新一輪的 check run（重新執行過的只取最新的）。 */
  listCheckRuns(installationId: number, repo: RepoRef, sha: string): Promise<GitHubCheckRun[]>;
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
