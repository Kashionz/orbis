// Desktop 透過 preload 暴露給 Web UI 的 API（使用者核准的決定 D10）。
// Web UI（C 軌）以 `getDesktopBridge()` 偵測是否在 Desktop 中執行，有 bridge 時才在 Run 頁面顯示
// 「用編輯器開啟 Worktree」「在終端機開啟」。這個檔案不依賴 Electron，Web UI 可以直接匯入。

import { NAMES } from "@orbis/api-contract/names";

/** bridge 掛在 `window` 上的名稱。 */
export const DESKTOP_BRIDGE_KEY = `${NAMES.productSlug}Desktop`;

export type DesktopActionResult = { ok: true } | { ok: false; message: string };

export interface DesktopBridge {
  /** Desktop 的版本。 */
  getVersion(): Promise<string>;
  /**
   * 用設定中的編輯器開啟 Run 的 Worktree（API 回傳的 `Run.worktreePath`）。
   * 只接受 Worktree 根目錄底下存在的目錄；失敗時 `message` 是可以直接顯示給人看的說明。
   */
  openWorktreeInEditor(worktreePath: string): Promise<DesktopActionResult>;
  /** 在設定中的終端機開啟 Run 的 Worktree，限制同上。 */
  openWorktreeInTerminal(worktreePath: string): Promise<DesktopActionResult>;
}

/** 在 Desktop 中執行時回傳 bridge，在一般瀏覽器中回傳 null。 */
export function getDesktopBridge(target: object = globalThis): DesktopBridge | null {
  const bridge = (target as Record<string, unknown>)[DESKTOP_BRIDGE_KEY];
  return bridge && typeof bridge === "object" ? (bridge as DesktopBridge) : null;
}

/** preload 與 main 之間的 IPC channel。 */
export const BRIDGE_IPC = {
  getVersion: "desktop:get-version",
  openWorktreeInEditor: "desktop:open-worktree-in-editor",
  openWorktreeInTerminal: "desktop:open-worktree-in-terminal",
} as const;
