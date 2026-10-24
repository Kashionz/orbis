// 自動更新的流程（ARCHITECTURE §16）。不依賴 Electron：electron-updater 以 UpdaterLike 介面注入，
// 對話框、開啟下載頁、安裝前停止 Runner 都由呼叫端提供，單元測試用 fake updater 跑完整個流程。
//
// - Windows：自動下載，下載完成後問「立即重新啟動並更新／稍後」；稍後就在結束 App 時安裝。
//   安裝前先停止 Runner sidecar（內建的 Runner 執行檔會一起被換掉）。
// - macOS（與其他不自動安裝的平台）：只檢查，偵測到新版時問「開啟下載頁／略過這個版本／稍後」。
//   未簽章的 App 不能用 electron-updater 安裝（使用者核准的 91 決定）。
// - 時機：App ready 後 DEFAULT_INITIAL_DELAY_MS 第一次檢查，之後每 DEFAULT_CHECK_INTERVAL_MS 一次；
//   系統匣與選單可以手動檢查。同一個版本每次啟動只主動提示一次，手動檢查一律提示。

/** electron-updater 的 AppUpdater 中，這裡用到的部分。 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available", listener: (info: { version: string }) => void): unknown;
  on(event: "update-not-available", listener: (info: { version: string }) => void): unknown;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type UpdateState =
  /** 沒有可用的更新來源（開發模式且沒有覆寫 feed）。 */
  | { kind: "unavailable" }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up_to_date"; checkedAt: number }
  /** 有新版本但不會自動安裝（macOS）；`skipped` 是使用者選擇略過的版本。 */
  | { kind: "available"; version: string; skipped: boolean }
  | { kind: "downloading"; version: string; percent: number }
  /** 已下載，結束 App 時安裝（Windows）。 */
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

export type UpdatePrompt =
  | { kind: "downloaded"; version: string }
  | { kind: "available"; version: string };

export type UpdateChoice = "install_now" | "later" | "open_download" | "skip_version";

export interface UpdateControllerDeps {
  updater: UpdaterLike | null;
  platform: NodeJS.Platform;
  currentVersion: string;
  /** 詢問使用者；`downloaded` 只會回 install_now／later，`available` 只會回 open_download／skip_version／later。 */
  prompt(prompt: UpdatePrompt): Promise<UpdateChoice>;
  /** 手動檢查的結果（已是最新版本、檢查失敗）。 */
  inform(message: string): void;
  openDownloadPage(version: string): void;
  /** 安裝前停止 Runner（有 Run 在跑時先問使用者）；回傳 false 表示使用者取消。 */
  prepareInstall(): Promise<boolean>;
  /** macOS 使用者略過的版本，保存在設定中。 */
  skippedVersion: { get(): string | null; set(version: string | null): void };
  /** Windows 下載完成、使用者選「稍後」時，要不要在結束 App 時安裝；預設是。測試時關閉。 */
  allowInstallOnQuit?: boolean;
  log(message: string): void;
  initialDelayMs?: number;
  intervalMs?: number;
}

export const DEFAULT_INITIAL_DELAY_MS = 30_000;
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

type Listener = (state: UpdateState) => void;

/** 哪些平台由 electron-updater 下載並安裝。 */
export function installsAutomatically(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

export class UpdateController {
  private state: UpdateState;
  private readonly listeners = new Set<Listener>();
  private readonly installable: boolean;
  private manual = false;
  /** 這次啟動已經主動提示過的版本。 */
  private promptedVersion: string | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  /** 對話框正在顯示時不再疊第二個。 */
  private prompting = false;

  constructor(private readonly deps: UpdateControllerDeps) {
    this.installable = installsAutomatically(deps.platform);
    this.state = deps.updater ? { kind: "idle" } : { kind: "unavailable" };
    const updater = deps.updater;
    if (!updater) return;
    updater.autoDownload = this.installable;
    updater.autoInstallOnAppQuit = this.installable && (deps.allowInstallOnQuit ?? true);
    updater.on("checking-for-update", () => this.update({ kind: "checking" }));
    updater.on("update-not-available", () => this.onUpToDate());
    updater.on("update-available", (info) => this.onAvailable(info.version));
    updater.on("download-progress", (info) => {
      if (this.state.kind === "downloading") {
        this.update({ ...this.state, percent: Math.round(info.percent) });
      }
    });
    updater.on("update-downloaded", (info) => void this.onDownloaded(info.version));
    updater.on("error", (error) => this.onError(error));
  }

  snapshot(): UpdateState {
    return this.state;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 排定自動檢查：延遲一段時間後第一次，之後定期。 */
  start(): void {
    if (!this.deps.updater || this.initialTimer || this.intervalTimer) return;
    const initialDelay = this.deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const interval = this.deps.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.check(false);
    }, initialDelay);
    this.intervalTimer = setInterval(() => this.check(false), interval);
  }

  dispose(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }

  /**
   * 使用者手動檢查（系統匣、選單）。已經下載好或已經知道有新版本時，不重新檢查，直接再問一次；
   * 正在檢查或下載時不做事。
   */
  checkNow(): void {
    if (!this.deps.updater) return;
    switch (this.state.kind) {
      case "checking":
      case "downloading":
        return;
      case "downloaded":
        void this.promptDownloaded(this.state.version);
        return;
      case "available":
        void this.promptAvailable(this.state.version);
        return;
      default:
        this.check(true);
    }
  }

  private check(manual: boolean): void {
    const updater = this.deps.updater;
    if (!updater) return;
    if (
      this.state.kind === "checking" ||
      this.state.kind === "downloading" ||
      this.state.kind === "downloaded"
    ) {
      return;
    }
    this.manual = manual;
    this.update({ kind: "checking" });
    this.deps.log(manual ? "手動檢查更新" : "自動檢查更新");
    // checkForUpdates 失敗時 electron-updater 會先發 error 事件；這裡只處理沒有發事件的情況
    updater.checkForUpdates().catch((error: unknown) => {
      if (this.state.kind === "checking") this.onError(error);
    });
  }

  private onUpToDate(): void {
    this.update({ kind: "up_to_date", checkedAt: Date.now() });
    this.deps.log(`已是最新版本（v${this.deps.currentVersion}）`);
    if (this.manual) this.deps.inform(`已是最新版本（v${this.deps.currentVersion}）`);
    this.manual = false;
  }

  private onAvailable(version: string): void {
    this.deps.log(`有新版本 v${version}（目前 v${this.deps.currentVersion}）`);
    if (this.installable) {
      // autoDownload：electron-updater 接著自動下載
      this.update({ kind: "downloading", version, percent: 0 });
      return;
    }
    const skipped = this.deps.skippedVersion.get() === version;
    this.update({ kind: "available", version, skipped: skipped && !this.manual });
    const shouldPrompt = this.manual || (!skipped && this.promptedVersion !== version);
    this.manual = false;
    if (shouldPrompt) void this.promptAvailable(version);
  }

  private async onDownloaded(version: string): Promise<void> {
    this.deps.log(`更新 v${version} 已下載，結束 App 時安裝`);
    this.update({ kind: "downloaded", version });
    const shouldPrompt = this.manual || this.promptedVersion !== version;
    this.manual = false;
    if (shouldPrompt) await this.promptDownloaded(version);
  }

  private onError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log(`檢查更新失敗：${message}`);
    this.update({ kind: "error", message });
    if (this.manual) this.deps.inform(`檢查更新失敗：${message}`);
    this.manual = false;
  }

  private async promptAvailable(version: string): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;
    this.promptedVersion = version;
    try {
      const choice = await this.deps.prompt({ kind: "available", version });
      switch (choice) {
        case "open_download":
          this.deps.openDownloadPage(version);
          break;
        case "skip_version":
          this.deps.skippedVersion.set(version);
          if (this.state.kind === "available" && this.state.version === version) {
            this.update({ ...this.state, skipped: true });
          }
          break;
        default:
          break;
      }
    } finally {
      this.prompting = false;
    }
  }

  private async promptDownloaded(version: string): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;
    this.promptedVersion = version;
    try {
      const choice = await this.deps.prompt({ kind: "downloaded", version });
      if (choice !== "install_now") return;
      if (!(await this.deps.prepareInstall())) {
        this.deps.log("使用者取消安裝更新，結束 App 時再安裝");
        return;
      }
      this.deps.log(`安裝更新 v${version} 並重新啟動`);
      this.deps.updater?.quitAndInstall();
    } finally {
      this.prompting = false;
    }
  }

  private update(state: UpdateState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

/** 系統匣要顯示的更新資訊：純資料，方便測試。 */
export interface UpdateView {
  /** 系統匣的「更新：…」一行；沒有要顯示的東西時為 null。 */
  label: string | null;
  /** 「檢查更新…」項目的文字與是否可按。 */
  action: { label: string; enabled: boolean };
}

export function updateView(state: UpdateState): UpdateView {
  const check = (enabled = true) => ({ label: "檢查更新…", enabled });
  switch (state.kind) {
    case "unavailable":
      return { label: null, action: check(false) };
    case "idle":
    case "up_to_date":
      return { label: null, action: check() };
    case "checking":
      return { label: "檢查更新中…", action: check(false) };
    case "available":
      return {
        label: state.skipped ? null : `有新版本 v${state.version}，請手動下載`,
        action: { label: `下載新版本 v${state.version}…`, enabled: true },
      };
    case "downloading":
      return { label: `下載更新 v${state.version}（${state.percent}%）`, action: check(false) };
    case "downloaded":
      return {
        label: `更新 v${state.version} 已下載，結束 App 時安裝`,
        action: { label: `立即安裝更新 v${state.version}…`, enabled: true },
      };
    case "error":
      return { label: null, action: check() };
  }
}
