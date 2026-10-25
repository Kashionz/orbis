// Desktop 透過 preload 暴露給 Web UI 的 API（使用者核准的決定 D10）。
// Web UI（C 軌）以 `getDesktopBridge()` 偵測是否在 Desktop 中執行，有 bridge 時才在 Run 頁面顯示
// 「用編輯器開啟 Worktree」「在終端機開啟」，登出前呼叫 beforeLogout()。這個檔案不依賴 Electron，
// Web UI 可以直接匯入。

import { NAMES } from "@orbis/api-contract/names";

/** bridge 掛在 `window` 上的名稱。 */
export const DESKTOP_BRIDGE_KEY = `${NAMES.productSlug}Desktop`;

export type DesktopActionResult = { ok: true } | { ok: false; message: string };

/** Preview 在主視窗中的位置（CSS 像素，相對於 Web UI 的 viewport）。 */
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 內嵌瀏覽器開的是哪一種網址（ARCHITECTURE §13）：
 * - `local`：這台 Desktop 的 Local Runner 跑的 Run，直接開 `localhost:<port>`。
 * - `share`：別人的 Run（或 Team Runner），開 Preview 網址。
 */
export type PreviewMode = "local" | "share";

export type PreviewShowResult =
  | { ok: true; mode: PreviewMode; url: string }
  | { ok: false; message: string };

/** 內嵌瀏覽器目前的狀態，給 Web UI 的網址列與按鈕使用。 */
export interface PreviewNavState {
  runId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** 在 Preview 上選取的元素（Preview 留言的附件）。 */
export interface PreviewPick {
  /** 在頁面中唯一的 CSS selector。 */
  selector: string;
  /** 選取時頁面的網址。 */
  url: string;
  /** 元素在 Preview viewport 中的位置（CSS 像素）。 */
  rect: PreviewBounds;
  /** 元素的標籤名稱（小寫）與開頭的文字，給留言框顯示。 */
  tagName: string;
  text: string;
  /** Preview viewport 的截圖（PNG），選取的元素以外框標示。 */
  screenshot: Uint8Array;
}

/** 內嵌瀏覽器（只在 Desktop 中提供）。一次只顯示一個 Run 的 Preview。 */
export interface DesktopPreviewBridge {
  /** 在 `bounds` 的位置顯示 Run 的 Preview；開哪個網址由 Desktop 依 Run 決定。 */
  show(runId: string, bounds: PreviewBounds): Promise<PreviewShowResult>;
  /** Web UI 的版面改變時更新位置。 */
  setBounds(bounds: PreviewBounds): Promise<void>;
  /** 隱藏（離開 Preview 分頁，或 Web UI 要顯示會被蓋住的對話框時）。 */
  hide(): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  /** 網址列：只能前往同一個 Preview 的網址，其他網址用外部瀏覽器開啟。 */
  navigate(url: string): Promise<DesktopActionResult>;
  openDevTools(): Promise<void>;
  /**
   * 進入選取模式：滑鼠移到元素上時以外框標示，點擊選取，Esc 取消（回傳 null）。
   * 選取後截下 Preview 的畫面。
   */
  pickElement(): Promise<PreviewPick | null>;
  /** 訂閱內嵌瀏覽器的狀態；回傳取消訂閱的函式。 */
  onNavState(listener: (state: PreviewNavState) => void): () => void;
}

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
  /**
   * Web UI 送出登出之前呼叫（ARCHITECTURE §16）。還有 Run 在跑時 Desktop 會先詢問使用者；
   * 確認後撤銷這台 Local Runner、停止 Runner、刪除本機狀態。
   * 回傳 `proceed: false`（使用者取消）時不要登出。
   */
  beforeLogout(): Promise<{ proceed: boolean }>;
  /**
   * Preview 的內嵌瀏覽器（ARCHITECTURE §13、§16.1）。Web UI 由 Server 提供，可能比 Desktop 新，
   * 所以是選填：舊版 Desktop 沒有時，Web UI 改用瀏覽器版本的 Preview。
   */
  preview?: DesktopPreviewBridge;

  // 以下是新工作區介面後端缺口的方法，型別先在契約 PR 中定好（實作由 Runner＋Desktop worker 加上）。
  // 都是選填：還沒有這些方法的 Desktop，Web UI 顯示「尚未開放」或改用其他做法。

  /**
   * 在這台電腦上執行 Runner 的登入子指令（`<Runner> login <agent>`，後端缺口 `agent-relogin`），
   * 只用於模型目錄的 `loginHint.kind` 是 `runner` 的 Agent。瀏覽器由 Agent 自己開啟；完成後 Runner 重新回報
   * 可用性。逾時或失敗時 `ok: false`，`message` 可以直接顯示給人看。
   */
  loginAgent?(agentId: string): Promise<DesktopActionResult>;
  /**
   * 在檔案總管（macOS 是 Finder）開啟 Run 的 Worktree（後端缺口 `reveal-in-explorer`），
   * 路徑限制同 `openWorktreeInEditor`。
   */
  revealWorktree?(worktreePath: string): Promise<DesktopActionResult>;
  /**
   * 桌面通知總開關（後端缺口 `desktop-notify-toggle`），存在這台電腦的 Desktop 設定檔。
   * 關閉時 Desktop 照常輪詢 Needs You，但不發原生通知。
   */
  getNotificationsEnabled?(): Promise<boolean>;
  setNotificationsEnabled?(enabled: boolean): Promise<void>;
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
  beforeLogout: "desktop:before-logout",
  previewShow: "desktop:preview-show",
  previewSetBounds: "desktop:preview-set-bounds",
  previewHide: "desktop:preview-hide",
  previewReload: "desktop:preview-reload",
  previewGoBack: "desktop:preview-go-back",
  previewGoForward: "desktop:preview-go-forward",
  previewNavigate: "desktop:preview-navigate",
  previewOpenDevTools: "desktop:preview-open-dev-tools",
  previewPickElement: "desktop:preview-pick-element",
  /** main → 主視窗：內嵌瀏覽器的狀態（PreviewNavState）。 */
  previewNavState: "desktop:preview-nav-state",
} as const;
