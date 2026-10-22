// Repo 登記（Project 新增 Repo 時）與 App 安裝狀態的追蹤。

import type { InstallationToken } from "./auth/installation-tokens";
import { WRITE_ROLES } from "./client/types";
import { connectedRepo, type IntegrationContext } from "./context";
import type { InstallationPayload, InstallationRepositoriesPayload } from "./webhook/payloads";

export type RepoInspection =
  | {
      installed: true;
      installationId: number;
      githubRepoId: number;
      /** GitHub 上目前的名稱（大小寫、改名後的名稱以 GitHub 為準）。 */
      owner: string;
      name: string;
      defaultBranch: string;
      htmlUrl: string;
    }
  | {
      installed: false;
      /** 讓使用者把 App 安裝到這個 repo 的網址。 */
      installUrl: string;
    };

export function installUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
}

/**
 * 檢查 App 有沒有安裝在這個 repo，並讀取 default branch 與 repo id。
 *
 * 同一個 App 可能安裝在不同 Team 的 repo 上，所以要求提出請求的 Member 本人（以 GitHub 帳號）
 * 對這個 repo 有寫入權限；沒有時的回應與「沒有安裝」相同，不透露 repo 是否存在或安裝狀態。
 */
export async function inspectRepo(
  ctx: IntegrationContext,
  owner: string,
  name: string,
  requesterMemberId: string,
): Promise<RepoInspection> {
  const notInstalled = { installed: false, installUrl: installUrl(ctx.appSlug) } as const;
  const requester = await ctx.domain.getMember(requesterMemberId);
  if (!requester) return notInstalled;
  const installation = await ctx.client.findRepoInstallation({ owner, name });
  if (!installation) return notInstalled;
  const repo = await ctx.client.getRepo(installation.installationId, { owner, name });
  if (!repo) return notInstalled;
  const role = await ctx.client.getCollaboratorRole(
    installation.installationId,
    { owner: repo.owner, name: repo.name },
    { login: requester.githubLogin, id: requester.githubUserId },
  );
  if (!WRITE_ROLES.has(role)) return notInstalled;
  return {
    installed: true,
    installationId: installation.installationId,
    githubRepoId: repo.id,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    htmlUrl: repo.htmlUrl,
  };
}

/** 交給 Team Runner push 的 token 的權限：只能讀寫這個 repo 的內容。 */
export const RUNNER_TOKEN_PERMISSIONS = { contents: "write" } as const;

/**
 * 給 Team Runner push 用的 installation token（ARCHITECTURE §11）。每次另外簽發，只限這個 repo、
 * 只有 contents 的寫入權限，不與 Server 自己快取的 token 共用（token 會離開 Server）。
 */
export async function getInstallationTokenForRepo(
  ctx: IntegrationContext,
  repoId: string,
): Promise<InstallationToken> {
  const record = await ctx.domain.getRepo(repoId);
  const repo = record && connectedRepo(record);
  if (!repo) throw new Error(`Repo ${repoId} 不存在或沒有安裝 GitHub App`);
  return ctx.client.createInstallationToken(repo.installationId, {
    repositoryIds: [repo.githubRepoId],
    permissions: { ...RUNNER_TOKEN_PERMISSIONS },
  });
}

/**
 * 設定這些 repo 的 installation。`onlyFrom` 有值時，只改目前屬於該 installation 的 Repo
 * （移除時不要清掉已經改由另一個 installation 管理的 Repo）。
 */
async function setInstallation(
  ctx: IntegrationContext,
  githubRepoIds: readonly number[],
  installationId: number | null,
  onlyFrom?: number,
): Promise<string[]> {
  const updated: string[] = [];
  for (const githubRepoId of githubRepoIds) {
    for (const repo of await ctx.domain.listReposByGithubRepoId(githubRepoId)) {
      if (repo.installationId === installationId) continue;
      if (onlyFrom !== undefined && repo.installationId !== onlyFrom) continue;
      await ctx.domain.updateRepoGitHubInfo(repo.id, { installationId });
      updated.push(repo.id);
    }
  }
  return updated;
}

export interface InstallationOutcome {
  /** 安裝狀態有變的 Repo（Orbis 的 Repo ID）。 */
  updatedRepoIds: string[];
}

/** `installation`：建立、刪除、停用、恢復。 */
export async function handleInstallationEvent(
  ctx: IntegrationContext,
  payload: InstallationPayload,
): Promise<InstallationOutcome> {
  const installationId = payload.installation.id;
  switch (payload.action) {
    case "created":
    case "unsuspend":
      return {
        updatedRepoIds: await setInstallation(
          ctx,
          (payload.repositories ?? []).map((r) => r.id),
          installationId,
        ),
      };
    case "deleted":
    case "suspend": {
      ctx.client.forgetInstallation(installationId);
      const repos = await ctx.domain.listReposByInstallationId(installationId);
      for (const repo of repos) {
        await ctx.domain.updateRepoGitHubInfo(repo.id, { installationId: null });
      }
      ctx.logger.warn(
        { installationId, action: payload.action, repos: repos.map((r) => r.id) },
        "GitHub App 被移除或停用",
      );
      return { updatedRepoIds: repos.map((r) => r.id) };
    }
    default:
      return { updatedRepoIds: [] };
  }
}

/** `installation_repositories`：安裝的 repo 範圍增減。 */
export async function handleInstallationRepositoriesEvent(
  ctx: IntegrationContext,
  payload: InstallationRepositoriesPayload,
): Promise<InstallationOutcome> {
  const added = await setInstallation(
    ctx,
    payload.repositories_added.map((r) => r.id),
    payload.installation.id,
  );
  const removed = await setInstallation(
    ctx,
    payload.repositories_removed.map((r) => r.id),
    null,
    payload.installation.id,
  );
  return { updatedRepoIds: [...added, ...removed] };
}
