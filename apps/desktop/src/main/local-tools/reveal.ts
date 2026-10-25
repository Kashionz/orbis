// 在檔案總管（macOS 是 Finder）開啟 Run 的 Worktree（後端缺口 reveal-in-explorer）。路徑檢查沿用
// openWorktreeInEditor 的 checkWorktreePath：Worktree 根目錄底下剛好兩層、解析 symlink 後仍在根目錄內。

import type { DesktopActionResult } from "../../bridge";
import type { WorktreePathResult } from "./worktree-path";

export interface RevealDeps {
  /** checkWorktreePath（已帶入平台與家目錄）。 */
  check: (input: unknown) => WorktreePathResult;
  /** Electron 的 shell.openPath：成功時回傳空字串，失敗時回傳錯誤訊息。 */
  openPath: (path: string) => Promise<string>;
}

export async function revealWorktree(
  input: unknown,
  deps: RevealDeps,
): Promise<DesktopActionResult> {
  const checked = deps.check(input);
  if (!checked.ok) return { ok: false, message: checked.message };
  const error = await deps.openPath(checked.path);
  if (error) return { ok: false, message: `無法開啟 ${checked.path}：${error}` };
  return { ok: true };
}
