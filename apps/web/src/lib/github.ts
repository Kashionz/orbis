// GitHub 整合在 UI 上的顯示（ARCHITECTURE §11）。

import type { Repo } from "@orbis/api-contract";

/**
 * Repo 還沒安裝 GitHub App 時的安裝連結。網址來自 Server，只接受 https 才當成連結；
 * App 已安裝、或 Server 沒有設定 GitHub App 時是 null。
 */
export function appInstallUrl(repo: Pick<Repo, "github">): string | null {
  // 本機 Repo 沒有 GitHub App 的狀態。
  if (!repo.github) return null;
  const { installed, installUrl } = repo.github;
  if (installed || !installUrl) return null;
  try {
    return new URL(installUrl).protocol === "https:" ? installUrl : null;
  } catch {
    return null;
  }
}

/** Repo 的顯示名稱：GitHub Repo 是 `owner/name`，本機 Repo 只有名稱。 */
export function repoDisplayName(repo: { owner: string | null; name: string }): string {
  return repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
}
