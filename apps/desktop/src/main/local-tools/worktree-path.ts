// 只允許開啟 Worktree 根目錄底下的路徑（使用者核准的決定 D11），避免網頁要求 Desktop 開啟任意位置。
// 依 §6.2 的配置 `<根目錄>/<repo>/<task-key>-<run-seq>`，只接受剛好兩層的目錄，不接受 Worktree 裡的子目錄
// （子目錄的名稱由 Agent 決定，可能含有特殊字元）。

import { posix, win32 } from "node:path";
import { NAMES } from "@orbis/api-contract/names";

export function worktreeRoot(platform: NodeJS.Platform, home: string): string {
  if (platform === "win32") return NAMES.worktreeRootWindows;
  return NAMES.worktreeRootUnix.replace(/^~(?=\/|$)/, home);
}

export type WorktreePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: "invalid_path" | "outside_worktree_root" | "not_found"; message: string };

export interface WorktreePathEnv {
  platform: NodeJS.Platform;
  home: string;
  /** 路徑存在而且是目錄。 */
  isDirectory: (path: string) => boolean;
  /** 解析 symlink 後的真實路徑，用來防止經由 symlink 跳出根目錄。 */
  realpath: (path: string) => string;
}

/** Windows 的路徑比較不分大小寫，並統一磁碟代號與斜線。 */
function normalizeFor(platform: NodeJS.Platform, path: string): string {
  if (platform !== "win32") return posix.normalize(path);
  const normalized = win32.normalize(path.replaceAll("/", "\\"));
  return normalized.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

/** Worktree 在根目錄底下的層數：`<repo>/<task-key>-<run-seq>`。 */
const WORKTREE_DEPTH = 2;

function isWorktreeUnder(platform: NodeJS.Platform, root: string, path: string): boolean {
  const lib = platform === "win32" ? win32 : posix;
  const fold = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const relative = lib.relative(fold(root), fold(path));
  if (relative === "" || relative.startsWith("..") || lib.isAbsolute(relative)) return false;
  return relative.split(lib.sep).length === WORKTREE_DEPTH;
}

export function checkWorktreePath(input: unknown, env: WorktreePathEnv): WorktreePathResult {
  const lib = env.platform === "win32" ? win32 : posix;
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) {
    return { ok: false, reason: "invalid_path", message: "Worktree 路徑不合法" };
  }
  const path = normalizeFor(env.platform, input.trim());
  if (!lib.isAbsolute(path)) {
    return { ok: false, reason: "invalid_path", message: "Worktree 路徑必須是絕對路徑" };
  }
  const root = normalizeFor(env.platform, worktreeRoot(env.platform, env.home));
  const outside: WorktreePathResult = {
    ok: false,
    reason: "outside_worktree_root",
    message: `只能開啟 ${root} 底下的 Worktree`,
  };
  if (!isWorktreeUnder(env.platform, root, path)) return outside;
  if (!env.isDirectory(path)) {
    return { ok: false, reason: "not_found", message: `找不到 Worktree：${path}` };
  }
  let realRoot = root;
  try {
    realRoot = normalizeFor(env.platform, env.realpath(root));
  } catch {
    // 根目錄本身解析失敗時用原本的路徑比較
  }
  const realPath = normalizeFor(env.platform, env.realpath(path));
  if (!isWorktreeUnder(env.platform, realRoot, realPath)) return outside;
  return { ok: true, path };
}
