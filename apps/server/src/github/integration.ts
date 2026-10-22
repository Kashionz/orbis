// GitHub 整合（D 軌，packages/github）與 Server 之間的介面。
//
// - Server → D 軌：`GitHubIntegration` 的各個介面，由 D 軌實作後在組裝 Server 時傳入。
//   沒有傳入時使用這裡的預設實作（只記 log、不連 GitHub），讓 Server 可以單獨運作與測試。
// - D 軌 → Server：見 domain/github-domain.ts 的 `GitHubDomainService`。

import { NAMES } from "@orbis/api-contract";
import type { Hono } from "hono";
import { z } from "zod";
import type { GitHubUser } from "../auth/github-oauth";
import type { Logger } from "../logger";

/** 依 GitHub login 查出使用者（新增 Member 時用）。找不到時回傳 null。 */
export interface GitHubUserLookup {
  findByLogin(login: string): Promise<GitHubUser | null>;
}

export interface RepoRegistration {
  owner: string;
  name: string;
  defaultBranch: string;
  /** GitHub 的 repository id；查不到時為 null。 */
  githubRepoId: number | null;
}

/**
 * 登記 Repo 前的檢查（D 軌：確認 GitHub App 安裝在該 Repo、讀取 default branch）。
 * 不能登記時丟出 `RepoRegistrationError`。
 */
export interface RepoRegistrar {
  register(input: {
    owner: string;
    name: string;
    defaultBranch: string;
  }): Promise<RepoRegistration>;
}

export class RepoRegistrationError extends Error {
  override name = "RepoRegistrationError";
}

export interface OpenPullRequestInput {
  taskId: string;
  runId: string;
  /** Runner 已 push 的分支。 */
  branch: string;
  /** push 出去的 HEAD commit。 */
  commitSha: string;
}

/** Review Gate 核准、Runner push 完成後開 PR（D 軌實作）。 */
export interface PullRequestOpener {
  openPullRequest(input: OpenPullRequestInput): Promise<void>;
}

/** D 軌掛在 Server 上的 HTTP 路由。 */
export interface GitHubRoutes {
  /** 掛在 `/api/github`（Repo 登記、從 Issue 匯入等）。 */
  routes?: Hono;
  /** 掛在 `/api/webhooks/github`（webhook，不經過登入檢查）。 */
  webhookRoutes?: Hono;
}

export interface GitHubIntegration extends GitHubRoutes {
  userLookup: GitHubUserLookup;
  repoRegistrar: RepoRegistrar;
  pullRequestOpener: PullRequestOpener;
}

const PublicUser = z.object({
  id: z.number().int(),
  login: z.string(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
});

/** 以 GitHub 公開 API（不需 token）查詢使用者。 */
export function createGitHubUserLookup(fetchImpl: typeof fetch = fetch): GitHubUserLookup {
  return {
    async findByLogin(login) {
      const response = await fetchImpl(
        `https://api.github.com/users/${encodeURIComponent(login)}`,
        {
          headers: { accept: "application/vnd.github+json", "user-agent": NAMES.productSlug },
        },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`查詢 GitHub 使用者失敗：HTTP ${response.status}`);
      const user = PublicUser.parse(await response.json());
      return {
        id: user.id,
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatar_url ?? null,
      };
    },
  };
}

/** D 軌接上之前的預設實作：直接採用輸入的 default branch。 */
export const passthroughRepoRegistrar: RepoRegistrar = {
  register: async (input) => ({ ...input, githubRepoId: null }),
};

/** D 軌接上之前的預設實作：只記 log。 */
export function loggingPullRequestOpener(logger: Logger): PullRequestOpener {
  return {
    async openPullRequest(input) {
      logger.warn(input, "尚未接上 GitHub 整合，略過開 PR");
    },
  };
}
