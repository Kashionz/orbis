// GitHub 整合與 Server 之間的介面。
//
// - GitHub App 整合（D 軌，packages/github 的 createGitHubIntegration）由 github/app.ts 組裝：
//   Server 提供 DomainService（domain/github-domain.ts）、GitHubStore（github/store.ts）、Notifier。
//   沒有設定 GitHub App 時 `app` 為 null，Server 照常運作，只是不連 GitHub。
// - GitHub 使用者查詢（新增 Member 時以 login 查數字 user id）用公開 API，與 App 無關。

import { NAMES } from "@orbis/api-contract";
import type { GitHubIntegration as GitHubAppIntegration } from "@orbis/github";
import { z } from "zod";
import type { GitHubUser } from "../auth/github-oauth";
import type { Logger } from "../logger";

/** 依 GitHub login 查出使用者（新增 Member 時用）。找不到時回傳 null。 */
export interface GitHubUserLookup {
  findByLogin(login: string): Promise<GitHubUser | null>;
}

/** Server 用到的 GitHub App 整合介面。 */
export type GitHubApp = Pick<
  GitHubAppIntegration,
  | "handleWebhook"
  | "onTaskChanged"
  | "onBranchPushed"
  | "inspectRepo"
  | "listImportableIssues"
  | "importIssues"
>;

export interface OpenPullRequestInput {
  taskId: string;
  runId: string;
  /** Runner 已 push 的分支。 */
  branch: string;
  /** push 出去的 HEAD commit。 */
  commitSha: string;
}

export type OpenPullRequestOutcome =
  /** `url` 為 null：GitHub 整合停用，沒有開 PR。 */
  { ok: true; url: string | null } | { ok: false; message: string };

/** Review Gate 核准、Runner push 完成後開 PR。 */
export interface PullRequestOpener {
  openPullRequest(input: OpenPullRequestInput): Promise<OpenPullRequestOutcome>;
}

export interface GitHubIntegration {
  userLookup: GitHubUserLookup;
  /** GitHub App 整合；沒有設定 GitHub App 時為 null。 */
  app: GitHubApp | null;
  /** 安裝 GitHub App 的網址（Repo 資源的 `github.installUrl`）；app 為 null 時為 null。 */
  installUrl: string | null;
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

/** 以 GitHub App 整合開 PR；整合停用時只記 log。 */
export function createPullRequestOpener(app: GitHubApp | null, logger: Logger): PullRequestOpener {
  return {
    async openPullRequest(input) {
      if (!app) {
        logger.warn(input, "沒有設定 GitHub App，略過開 PR");
        return { ok: true, url: null };
      }
      const result = await app.onBranchPushed(input);
      return result.ok ? { ok: true, url: result.url } : { ok: false, message: result.message };
    },
  };
}
