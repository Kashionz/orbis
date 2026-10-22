// in-memory 的 GitHub：實作 GitHubClient，並提供「有人在 GitHub 上操作」的輔助方法。
// 每次寫入時鐘前進 1 秒，讓 updated_at 嚴格遞增。

import type { InstallationToken } from "../auth/installation-tokens";
import {
  GitHubApiError,
  type GitHubClient,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubRepository,
  type GitHubUserRef,
  type IssuePatch,
  type RepoRef,
  type RepoRole,
  type TokenScope,
} from "../client/types";
import type { TestClock } from "./clock";

export interface FakeRepo extends GitHubRepository {
  installationId: number | null;
}

export interface FakeComment {
  id: number;
  issueNumber: number;
  body: string;
  author: string;
}

export interface FakeCall {
  method: keyof GitHubClient;
  args: unknown[];
}

const clone = <T>(value: T): T => structuredClone(value);

export class FakeGitHub implements GitHubClient {
  readonly repos: FakeRepo[] = [];
  readonly issues = new Map<number, GitHubIssue[]>();
  readonly comments = new Map<number, FakeComment[]>();
  readonly pulls = new Map<number, GitHubPullRequest[]>();
  readonly calls: FakeCall[] = [];
  /** GitHub 帳號（assignee 只能指派這些人）。 */
  readonly users = new Map<string, GitHubUserRef>();
  readonly forgotten: number[] = [];
  /** 各帳號對 repo 的角色；沒有設定的是 `none`。 */
  readonly roles = new Map<string, RepoRole>();
  #nextId = 1000;
  #failures: { method: keyof GitHubClient; error: Error }[] = [];

  constructor(
    readonly clock: TestClock,
    /** App 的 bot 帳號（App 寫入的 sender）。 */
    readonly bot: GitHubUserRef,
  ) {}

  addRepo(repo: Omit<FakeRepo, "htmlUrl"> & { htmlUrl?: string }): FakeRepo {
    const full: FakeRepo = { htmlUrl: `https://github.com/${repo.owner}/${repo.name}`, ...repo };
    this.repos.push(full);
    this.issues.set(full.id, []);
    this.comments.set(full.id, []);
    this.pulls.set(full.id, []);
    return full;
  }

  addUser(user: GitHubUserRef): void {
    this.users.set(user.login, user);
  }

  /** 讓下一次呼叫 `method` 丟出錯誤。 */
  failNext(
    method: keyof GitHubClient,
    error: Error = new GitHubApiError(502, "Bad Gateway"),
  ): void {
    this.#failures.push({ method, error });
  }

  callsTo(method: keyof GitHubClient): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  #record(method: keyof GitHubClient, args: unknown[]): void {
    this.calls.push({ method, args: clone(args) });
    const index = this.#failures.findIndex((f) => f.method === method);
    if (index >= 0) {
      const [failure] = this.#failures.splice(index, 1);
      throw failure?.error;
    }
  }

  #repo(ref: RepoRef, installationId?: number): FakeRepo {
    const repo = this.repos.find(
      (r) =>
        r.owner.toLowerCase() === ref.owner.toLowerCase() &&
        r.name.toLowerCase() === ref.name.toLowerCase(),
    );
    if (!repo || (installationId !== undefined && repo.installationId !== installationId)) {
      throw new GitHubApiError(404, "Not Found");
    }
    return repo;
  }

  repoById(id: number): FakeRepo {
    const repo = this.repos.find((r) => r.id === id);
    if (!repo) throw new Error(`沒有 repo ${id}`);
    return repo;
  }

  issue(repoId: number, number: number): GitHubIssue {
    const issue = this.issues.get(repoId)?.find((i) => i.number === number);
    if (!issue) throw new GitHubApiError(404, "Not Found");
    return issue;
  }

  #nextNumber(repoId: number): number {
    const issues = this.issues.get(repoId) ?? [];
    const pulls = this.pulls.get(repoId) ?? [];
    return issues.length + pulls.length + 1;
  }

  #tick(): string {
    this.clock.advance(1000);
    return this.clock.githubTimestamp();
  }

  #assignees(logins: readonly string[]): GitHubUserRef[] {
    // GitHub 會默默略過不能被指派的帳號。
    return logins.flatMap((login) => {
      const user = this.users.get(login);
      return user ? [clone(user)] : [];
    });
  }

  #applyPatch(issue: GitHubIssue, patch: IssuePatch): void {
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) {
      issue.state = patch.state;
      issue.stateReason =
        patch.stateReason ?? (patch.state === "closed" ? "completed" : "reopened");
    }
    if (patch.assignees !== undefined) issue.assignees = this.#assignees(patch.assignees);
    if (patch.labels !== undefined) issue.labels = [...patch.labels];
    issue.updatedAt = this.#tick();
  }

  // ── GitHubClient ─────────────────────────────────────────────

  async findRepoInstallation(repo: RepoRef) {
    this.#record("findRepoInstallation", [repo]);
    const found = this.repos.find(
      (r) =>
        r.owner.toLowerCase() === repo.owner.toLowerCase() &&
        r.name.toLowerCase() === repo.name.toLowerCase(),
    );
    return found?.installationId ? { installationId: found.installationId } : null;
  }

  async createInstallationToken(
    installationId: number,
    scope?: TokenScope,
  ): Promise<InstallationToken> {
    this.#record("createInstallationToken", scope ? [installationId, scope] : [installationId]);
    return {
      token: scope
        ? `ghs_scoped_${installationId}_${scope.repositoryIds.join("-")}`
        : `ghs_fake_${installationId}`,
      expiresAt: new Date(this.clock.now().getTime() + 3600_000),
    };
  }

  async installationToken(installationId: number): Promise<string> {
    this.#record("installationToken", [installationId]);
    return `ghs_fake_${installationId}`;
  }

  forgetInstallation(installationId: number): void {
    this.forgotten.push(installationId);
  }

  async getCollaboratorRole(
    installationId: number,
    ref: RepoRef,
    username: string,
  ): Promise<RepoRole> {
    this.#record("getCollaboratorRole", [installationId, ref, username]);
    this.#repo(ref, installationId);
    return this.roles.get(username) ?? "none";
  }

  async getRepo(installationId: number, ref: RepoRef) {
    this.#record("getRepo", [installationId, ref]);
    try {
      const { installationId: _ignored, ...repo } = this.#repo(ref, installationId);
      return clone(repo);
    } catch {
      return null;
    }
  }

  async getIssue(installationId: number, ref: RepoRef, number: number) {
    this.#record("getIssue", [installationId, ref, number]);
    const repo = this.#repo(ref, installationId);
    const issue = this.issues.get(repo.id)?.find((i) => i.number === number);
    if (issue) return clone(issue);
    const pull = this.pulls.get(repo.id)?.find((p) => p.number === number);
    if (pull) {
      return { ...this.#issueShell(number, `PR ${number}`, repo), isPullRequest: true };
    }
    return null;
  }

  async listOpenIssues(installationId: number, ref: RepoRef) {
    this.#record("listOpenIssues", [installationId, ref]);
    const repo = this.#repo(ref, installationId);
    return (this.issues.get(repo.id) ?? []).filter((i) => i.state === "open").map(clone);
  }

  #issueShell(number: number, title: string, repo: FakeRepo): GitHubIssue {
    return {
      id: this.#nextId++,
      number,
      title,
      body: "",
      state: "open",
      stateReason: null,
      assignees: [],
      labels: [],
      updatedAt: this.clock.githubTimestamp(),
      htmlUrl: `${repo.htmlUrl}/issues/${number}`,
      isPullRequest: false,
    };
  }

  async createIssue(
    installationId: number,
    ref: RepoRef,
    input: { title: string; body: string; assignees: string[]; labels: string[] },
  ) {
    this.#record("createIssue", [installationId, ref, input]);
    const repo = this.#repo(ref, installationId);
    const issue = this.#issueShell(this.#nextNumber(repo.id), input.title, repo);
    issue.body = input.body;
    issue.assignees = this.#assignees(input.assignees);
    issue.labels = [...input.labels];
    issue.updatedAt = this.#tick();
    this.issues.get(repo.id)?.push(issue);
    return clone(issue);
  }

  async updateIssue(installationId: number, ref: RepoRef, number: number, patch: IssuePatch) {
    this.#record("updateIssue", [installationId, ref, number, patch]);
    const repo = this.#repo(ref, installationId);
    const issue = this.issue(repo.id, number);
    this.#applyPatch(issue, patch);
    return clone(issue);
  }

  async createIssueComment(
    installationId: number,
    ref: RepoRef,
    issueNumber: number,
    body: string,
  ) {
    this.#record("createIssueComment", [installationId, ref, issueNumber, body]);
    const repo = this.#repo(ref, installationId);
    this.issue(repo.id, issueNumber);
    const comment = { id: this.#nextId++, issueNumber, body, author: this.bot.login };
    this.comments.get(repo.id)?.push(comment);
    return { id: comment.id };
  }

  async updateIssueComment(installationId: number, ref: RepoRef, commentId: number, body: string) {
    this.#record("updateIssueComment", [installationId, ref, commentId, body]);
    const repo = this.#repo(ref, installationId);
    const comment = this.comments.get(repo.id)?.find((c) => c.id === commentId);
    if (!comment) return null;
    comment.body = body;
    return { id: comment.id };
  }

  async findOpenPullRequest(installationId: number, ref: RepoRef, head: string) {
    this.#record("findOpenPullRequest", [installationId, ref, head]);
    const repo = this.#repo(ref, installationId);
    const pull = this.pulls.get(repo.id)?.find((p) => p.headRef === head && p.state === "open");
    return pull ? clone(pull) : null;
  }

  async createPullRequest(
    installationId: number,
    ref: RepoRef,
    input: { title: string; body: string; head: string; base: string },
  ) {
    this.#record("createPullRequest", [installationId, ref, input]);
    const repo = this.#repo(ref, installationId);
    const number = this.#nextNumber(repo.id);
    const pull: GitHubPullRequest & { title: string; body: string } = {
      id: this.#nextId++,
      number,
      htmlUrl: `${repo.htmlUrl}/pull/${number}`,
      state: "open",
      merged: false,
      headRef: input.head,
      headSha: "f".repeat(40),
      baseRef: input.base,
      title: input.title,
      body: input.body,
    };
    this.#tick();
    this.pulls.get(repo.id)?.push(pull);
    return clone(pull);
  }

  // ── 模擬有人在 GitHub 上操作 ──────────────────────────────────

  /** 有人在 GitHub 上修改 Issue；回傳修改後的 Issue（用來組 webhook payload）。 */
  humanEdit(repoId: number, number: number, patch: IssuePatch): GitHubIssue {
    const issue = this.issue(repoId, number);
    this.#applyPatch(issue, patch);
    return clone(issue);
  }

  /** 有人在 GitHub 上開 Issue。 */
  humanOpenIssue(
    repoId: number,
    input: Partial<Pick<GitHubIssue, "title" | "body" | "labels">> & { assignees?: string[] },
  ): GitHubIssue {
    const repo = this.repoById(repoId);
    const issue = this.#issueShell(this.#nextNumber(repoId), input.title ?? "Issue", repo);
    issue.body = input.body ?? "";
    issue.labels = input.labels ?? [];
    issue.assignees = this.#assignees(input.assignees ?? []);
    issue.updatedAt = this.#tick();
    this.issues.get(repoId)?.push(issue);
    return clone(issue);
  }

  /** 有人刪掉一則留言。 */
  humanDeleteComment(repoId: number, commentId: number): void {
    const list = this.comments.get(repoId) ?? [];
    const index = list.findIndex((c) => c.id === commentId);
    if (index >= 0) list.splice(index, 1);
  }

  commentsOn(repoId: number, issueNumber: number): FakeComment[] {
    return (this.comments.get(repoId) ?? []).filter((c) => c.issueNumber === issueNumber);
  }
}
