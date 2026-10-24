// 自動更新的來源：public GitHub Releases（使用者核准的 91 決定）。electron-builder 的 publish 設定
// 與 Desktop 開下載頁用的網址都從這裡取得，兩邊才不會不一致。

export const RELEASE_SOURCE = {
  provider: "github",
  owner: "Kashionz",
  repo: "orbis",
} as const;

/** 某個版本的 Release 頁面（macOS 不自動更新，提示後用瀏覽器開這一頁下載）。 */
export function releasePageUrl(version: string): string {
  const { owner, repo } = RELEASE_SOURCE;
  return `https://github.com/${owner}/${repo}/releases/tag/v${version}`;
}

/** Git tag 與 App 版本的對應：tag `v<version>`。 */
export function releaseTag(version: string): string {
  return `v${version}`;
}
