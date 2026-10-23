// GitHub 整合在 UI 上的顯示（ARCHITECTURE §11）。

import type { Repo } from "@orbis/api-contract";

/**
 * Repo 還沒安裝 GitHub App 時的安裝連結。網址來自 Server，只接受 https 才當成連結；
 * App 已安裝、或 Server 沒有設定 GitHub App 時是 null。
 */
export function appInstallUrl(repo: Pick<Repo, "github">): string | null {
  const { installed, installUrl } = repo.github;
  if (installed || !installUrl) return null;
  try {
    return new URL(installUrl).protocol === "https:" ? installUrl : null;
  } catch {
    return null;
  }
}
