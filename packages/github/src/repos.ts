// Repo 登記（Project 新增 Repo 時）與 App 安裝狀態的追蹤。

import type { InstallationToken } from "./auth/installation-tokens";
import { WRITE_ROLES } from "./client/types";
import { connectedRepo, type IntegrationContext } from "./context";
import type {
  InstallationPayload,
  InstallationRepositoriesPayload,
  InstalledRepo,
  WebhookSender,
} from "./webhook/payloads";

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
 * 移除這些 repo 的 installation。只改目前屬於該 installation 的 Repo
 * （不要清掉已經改由另一個 installation 管理的 Repo）。
 */
async function clearInstallation(
  ctx: IntegrationContext,
  repos: readonly InstalledRepo[],
  installationId: number,
): Promise<string[]> {
  const updated: string[] = [];
  for (const { id } of repos) {
    for (const repo of await ctx.domain.listReposByGithubRepoId(id)) {
      if (repo.installationId !== installationId) continue;
      await ctx.domain.updateRepoGitHubInfo(repo.id, { installationId: null });
      updated.push(repo.id);
    }
  }
  return updated;
}

/**
 * App 安裝到這些 repo：已知 repo id 的 Repo 直接更新 installation。
 *
 * App 安裝之前登記的 Repo 還不知道 repo id（private repo 沒安裝 App 讀不到），以 owner/name 比對。
 * 名稱比對有被冒用的風險（別的 Team 先登記同名的 repo，等 repo 的主人安裝 App），所以只在
 * 安裝 App 的人是該 Project 的 Member、而且對 repo 有寫入權限時才綁定，並以 GitHub 的資料補上
 * repo id 與 default branch。
 */
async function setInstallation(
  ctx: IntegrationContext,
  repos: readonly InstalledRepo[],
  installationId: number,
  installer: WebhookSender,
): Promise<string[]> {
  const updated: string[] = [];
  for (const installed of repos) {
    for (const repo of await ctx.domain.listReposByGithubRepoId(installed.id)) {
      if (repo.installationId === installationId) continue;
      await ctx.domain.updateRepoGitHubInfo(repo.id, { installationId });
      updated.push(repo.id);
    }
    const [owner = "", name = ""] = installed.full_name.split("/");
    const unbound = (await ctx.domain.listReposByFullName(owner, name)).filter(
      (repo) => repo.githubRepoId === null,
    );
    if (unbound.length === 0) continue;
    if (!(await installerCanWrite(ctx, installationId, { owner, name }, installer))) continue;
    const github = await ctx.client.getRepo(installationId, { owner, name });
    if (!github || github.id !== installed.id) continue;
    for (const repo of unbound) {
      if (!(await ctx.domain.findMemberByGithubUserId(repo.projectId, installer.id))) {
        ctx.logger.warn(
          { repoId: repo.id, repo: installed.full_name, installer: installer.login },
          "安裝 App 的人不是這個 Project 的 Member，不以名稱綁定 Repo",
        );
        continue;
      }
      await ctx.domain.updateRepoGitHubInfo(repo.id, {
        installationId,
        githubRepoId: github.id,
        defaultBranch: github.defaultBranch,
      });
      updated.push(repo.id);
    }
  }
  return updated;
}

async function installerCanWrite(
  ctx: IntegrationContext,
  installationId: number,
  repo: { owner: string; name: string },
  installer: WebhookSender,
): Promise<boolean> {
  const role = await ctx.client.getCollaboratorRole(installationId, repo, {
    login: installer.login,
    id: installer.id,
  });
  return WRITE_ROLES.has(role);
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
    case "unsuspend": {
      // unsuspend（以及安裝到全部 repo 時的 created）的 payload 不一定列出 repo，這時向 GitHub 查詢。
      const repos = payload.repositories?.length
        ? payload.repositories
        : (await ctx.client.listInstallationRepositories(installationId)).map((r) => ({
            id: r.id,
            full_name: r.fullName,
          }));
      return {
        updatedRepoIds: await setInstallation(ctx, repos, installationId, payload.sender),
      };
    }
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
    payload.repositories_added,
    payload.installation.id,
    payload.sender,
  );
  const removed = await clearInstallation(
    ctx,
    payload.repositories_removed,
    payload.installation.id,
  );
  return { updatedRepoIds: [...added, ...removed] };
}
