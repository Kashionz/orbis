// 主視窗中的內嵌瀏覽器（WebContentsView）：顯示 Run 的 Preview，提供網址列、上一頁、重新整理、
// DevTools 與元素選取（ARCHITECTURE §13、§16.1）。
// - 位置由 Web UI 決定（Preview 分頁的區塊），以 setBounds 疊在主視窗的 Web UI 上。
// - 沒有 preload、啟用 sandbox；導覽限制在這個 Preview 的 origin（target.ts）。
// - 和主視窗共用預設的 session：開 Preview 網址時要帶 Web UI 的 session 經過 authorize 換票。
//   Web UI 的 cookie 是 host-only，Preview 的頁面讀不到。

import { type BaseWindow, shell, WebContentsView } from "electron";
import type { PreviewBounds, PreviewNavState, PreviewPick } from "../../bridge";
import { parseRawPick, removeOverlayScript, startPickingScript } from "./picker";
import { createRateLimiter, decidePreviewNavigation, type PreviewTarget } from "./target";

type OpenTarget = Extract<PreviewTarget, { origins: string[] }>;

/**
 * 頁面自己觸發的外部開啟（連結、window.open、轉址）的最短間隔。Preview 是 Agent 寫的程式，
 * 不能讓它不斷叫出外部瀏覽器；超過的直接丟棄。網址列（使用者操作）不受限制。
 */
const PAGE_EXTERNAL_OPEN_INTERVAL_MS = 3000;

/** 元素選取用的 isolated world ID（Electron 要求 >= 1000 以免和內建的衝突）。 */
const PICKER_WORLD_ID = 1999;

export interface PreviewViewOptions {
  window: BaseWindow;
  /** Web UI 的 origin（authorize 換票時經過）。 */
  serverOrigin: () => string | null;
  /** Web UI 的縮放比例：Web UI 給的是 CSS 像素，WebContentsView 用的是 DIP。 */
  zoomFactor: () => number;
  /** 狀態改變時通知 Web UI。 */
  onNavState: (state: PreviewNavState) => void;
  openExternal?: (url: string) => void;
}

export class PreviewView {
  private view: WebContentsView | null = null;
  private target: OpenTarget | null = null;
  private readonly pageMayOpenExternal = createRateLimiter(PAGE_EXTERNAL_OPEN_INTERVAL_MS);

  constructor(private readonly options: PreviewViewOptions) {}

  /** 目前的 webContents（測試用）。 */
  get webContents(): Electron.WebContents | null {
    return this.view?.webContents ?? null;
  }

  async show(target: OpenTarget, bounds: PreviewBounds): Promise<void> {
    const sameRun = this.target?.runId === target.runId && this.target.url === target.url;
    this.target = target;
    const view = this.ensureView();
    this.setBounds(bounds);
    view.setVisible(true);
    if (!sameRun) await view.webContents.loadURL(target.url).catch(() => {});
  }

  setBounds(bounds: PreviewBounds): void {
    if (!this.view) return;
    const zoom = this.options.zoomFactor();
    const round = (n: number) => Math.max(0, Math.round(n * zoom));
    this.view.setBounds({
      x: round(bounds.x),
      y: round(bounds.y),
      width: round(bounds.width),
      height: round(bounds.height),
    });
  }

  hide(): void {
    this.view?.setVisible(false);
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  goBack(): void {
    this.view?.webContents.navigationHistory.goBack();
  }

  goForward(): void {
    this.view?.webContents.navigationHistory.goForward();
  }

  /** 網址列：同一個 Preview 的網址在內嵌瀏覽器中開，其他網址交給外部瀏覽器。 */
  navigate(url: string): { ok: true } | { ok: false; message: string } {
    if (!this.view || !this.target) return { ok: false, message: "Preview 尚未開啟" };
    const decision = decidePreviewNavigation(url, this.target, this.options.serverOrigin());
    if (decision === "allow") {
      void this.view.webContents.loadURL(url).catch(() => {});
      return { ok: true };
    }
    if (decision === "external") {
      this.openExternal(url);
      return { ok: true };
    }
    return { ok: false, message: "不支援這個網址" };
  }

  openDevTools(): void {
    this.view?.webContents.openDevTools({ mode: "detach" });
  }

  /** 進入選取模式，選取後截下 Preview 的畫面；Esc 取消時回傳 null。 */
  async pickElement(): Promise<PreviewPick | null> {
    const contents = this.view?.webContents;
    if (!contents) return null;
    contents.focus();
    const raw = parseRawPick(
      await contents.executeJavaScriptInIsolatedWorld(PICKER_WORLD_ID, [
        { code: startPickingScript() },
      ]),
    );
    if (!raw) return null;
    try {
      // 等外框畫上去之後再截圖
      await contents.executeJavaScriptInIsolatedWorld(PICKER_WORLD_ID, [
        { code: "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))" },
      ]);
      const image = await contents.capturePage();
      return { ...raw, screenshot: new Uint8Array(image.toPNG()) };
    } finally {
      await contents
        .executeJavaScriptInIsolatedWorld(PICKER_WORLD_ID, [{ code: removeOverlayScript() }])
        .catch(() => {});
    }
  }

  /** 主視窗關閉或登出時移除。 */
  destroy(): void {
    if (!this.view) return;
    this.options.window.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
    this.target = null;
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    this.harden(view.webContents);
    const notify = () => this.notifyNavState();
    view.webContents.on("did-navigate", notify);
    view.webContents.on("did-navigate-in-page", notify);
    view.webContents.on("did-start-loading", notify);
    view.webContents.on("did-stop-loading", notify);
    view.webContents.on("page-title-updated", notify);
    this.options.window.contentView.addChildView(view);
    this.view = view;
    return view;
  }

  private harden(contents: Electron.WebContents): void {
    const guard = (event: Electron.Event, url: string) => {
      const decision = this.target
        ? decidePreviewNavigation(url, this.target, this.options.serverOrigin())
        : "deny";
      if (decision === "allow") return;
      event.preventDefault();
      if (decision === "external") this.openExternalFromPage(url);
    };
    // 只限制主 frame；頁面內的 iframe 不限制
    contents.on("will-frame-navigate", (details) => {
      if (details.isMainFrame) guard(details, details.url);
    });
    contents.on("will-redirect", (details) => {
      if (details.isMainFrame) guard(details, details.url);
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    // 不開新視窗：同一個 Preview 的網址在內嵌瀏覽器中開，其他交給外部瀏覽器
    contents.setWindowOpenHandler(({ url }) => {
      const decision = this.target
        ? decidePreviewNavigation(url, this.target, this.options.serverOrigin())
        : "deny";
      if (decision === "allow") void contents.loadURL(url).catch(() => {});
      else if (decision === "external") this.openExternalFromPage(url);
      return { action: "deny" };
    });
  }

  private openExternalFromPage(url: string): void {
    if (this.pageMayOpenExternal()) this.openExternal(url);
  }

  private openExternal(url: string): void {
    (this.options.openExternal ?? ((u: string) => void shell.openExternal(u)))(url);
  }

  private notifyNavState(): void {
    const contents = this.view?.webContents;
    if (!contents || !this.target) return;
    this.options.onNavState({
      runId: this.target.runId,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    });
  }
}
