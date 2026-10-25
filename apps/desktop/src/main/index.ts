// Desktop 的 main 程序：載入 Web UI、登入後自動 Pairing、代管 Runner sidecar、系統匣、Needs You 通知
// （ARCHITECTURE §16、ADR-0008）。各部分的邏輯在各自的模組中，這裡只負責和 Electron 接起來。

import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NAMES } from "@orbis/api-contract/names";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  net,
  session,
  shell,
  type WebContents,
} from "electron";
import { BRIDGE_IPC, type DesktopActionResult, type PreviewShowResult } from "../bridge";
import { type SaveResult, SETTINGS_IPC, type SettingsState } from "../settings-api";
import { ConfigStore } from "./config-store";
import {
  buildEditorLaunch,
  buildTerminalLaunch,
  type CommandEnv,
  createWhich,
  type LaunchResult,
  type LaunchSpec,
} from "./local-tools/command";
import { type Launcher, spawnLauncher } from "./local-tools/launcher";
import {
  EDITOR_PRESETS,
  PATH_PLACEHOLDER,
  type ToolChoice,
  terminalPresets,
} from "./local-tools/presets";
import { revealWorktree } from "./local-tools/reveal";
import { checkWorktreePath } from "./local-tools/worktree-path";
import { APP_USER_MODEL_ID, DESKTOP_ENV, SESSION_COOKIE } from "./names";
import { decideNavigation, isTrustedSender } from "./navigation-policy";
import {
  NeedsYouPoller,
  type NotificationContent,
  needsYouNotification,
} from "./notifications/needs-you";
import { PreviewView } from "./preview/preview-view";
import {
  fetchPreviewState,
  parsePreviewBounds,
  parseRunId,
  resolvePreviewTarget,
} from "./preview/target";
import { checkServerHealth, normalizeServerUrl, resolveRunnerServerUrl } from "./server-url";
import { createServerApi, type ServerApi, UnauthorizedError } from "./session/server-api";
import { SessionController } from "./session/session-controller";
import { AgentLogin } from "./sidecar/agent-login";
import { RotatingLogFile } from "./sidecar/log-file";
import { killProcessTree } from "./sidecar/process-tree";
import { buildRunnerLaunch, resolveRunnerCommand } from "./sidecar/runner-command";
import { RunnerSupervisor } from "./sidecar/supervisor";
import { installTestHooks } from "./test-hooks";
import { DesktopTray } from "./tray/tray";
import {
  buildTrayModel,
  deriveRunnerView,
  type TrayMenuId,
  type TrayModel,
  VERSION_MISMATCH_MESSAGE,
} from "./tray/tray-model";
import {
  type UpdateChoice,
  UpdateController,
  type UpdatePrompt,
  updateView,
} from "./update/controller";
import { createElectronUpdater } from "./update/electron-updater";
import { releasePageUrl } from "./update/release-source";
import {
  type CompatibilityVerdict,
  checkCompatibility,
  LOCAL_VERSIONS,
  sameVerdict,
} from "./version/compat";

// ---- 啟動前的設定（要在 ready 之前完成）

app.setName(NAMES.productName);
const userDataOverride = process.env[DESKTOP_ENV.userDataDir];
if (userDataOverride) app.setPath("userData", userDataOverride);
const testHooksEnabled = process.env[DESKTOP_ENV.testHooks] === "1";

const distDir = dirname(fileURLToPath(import.meta.url));
const SETTINGS_HTML = join(distDir, "renderer", "settings.html");
const userData = app.getPath("userData");
const config = new ConfigStore(join(userData, "desktop-config.json"));
const runnerStateDir = join(userData, "runner");
const runnerLog = new RotatingLogFile(join(userData, "logs", "runner.log"));
/** Desktop 自己的紀錄：自動更新、版本相容。 */
const desktopLog = new RotatingLogFile(join(userData, "logs", "desktop.log"));
/** 每隔這麼久重新向 Server 確認版本相容（ARCHITECTURE §16）。 */
const COMPAT_RECHECK_MS = 6 * 60 * 60_000;

let mainWindow: BrowserWindow | null = null;
/** 主視窗中的 Preview 內嵌瀏覽器（跟著主視窗建立與移除）。 */
let previewView: PreviewView | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: DesktopTray | null = null;
let quitting = false;
let needsYouCount = 0;
/** sidecar 目前使用的 Pairing token，以及取得它時的 Server。 */
let pairing: { token: string; serverUrl: string } | null = null;
const liveNotifications = new Set<Notification>();
/** Desktop 與 Server 的版本相容判定；還沒查過（或查不到）時為 null。 */
let compat: CompatibilityVerdict | null = null;
/** 已經用對話框提示過的判定，同一個問題不重複跳出。 */
let shownCompat: CompatibilityVerdict | null = null;
let updateController: UpdateController | null = null;

const testState = {
  notifications: [] as NotificationContent[],
  notificationClicks: [] as (() => void)[],
  launches: [] as LaunchSpec[],
  openedPaths: [] as string[],
  externalUrls: [] as string[],
  updatePrompts: [] as UpdatePrompt[],
  updateAnswers: [] as UpdateChoice[],
  dialogs: [] as string[],
};

function openExternal(url: string): void {
  if (testHooksEnabled) {
    testState.externalUrls.push(url);
    return;
  }
  void shell.openExternal(url);
}

function parentWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** 一般的提示對話框（手動檢查更新的結果等）。 */
function showInfo(message: string, detail?: string): void {
  if (testHooksEnabled) {
    testState.dialogs.push(message);
    return;
  }
  const options = { type: "info" as const, message, ...(detail && { detail }) };
  const parent = parentWindow();
  void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
}

function serverUrl(): string | null {
  return config.get().serverUrl;
}

// ---- Server API：用 Electron session 的 fetch，帶著 Web UI 登入後的 cookie

const sessionFetch = ((input: string | URL | Request, init?: RequestInit) =>
  session.defaultSession.fetch(input as string, {
    ...init,
    credentials: "include",
  })) as typeof fetch;

const api: ServerApi = {
  me: () => currentApi().me(),
  createLocalPairingToken: () => currentApi().createLocalPairingToken(),
  listNeedsYou: () => currentApi().listNeedsYou(),
  revokeRunner: (runnerId) => currentApi().revokeRunner(runnerId),
};

function currentApi(): ServerApi {
  const url = serverUrl();
  if (!url) throw new Error("尚未設定 Server URL");
  return createServerApi(url, sessionFetch);
}

// ---- Runner sidecar

const runnerCommand = () =>
  resolveRunnerCommand({
    env: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
  });

// Agent 重新登入（agent-relogin）：sidecar 同一個 Runner 執行檔與狀態目錄的 `login <agent>`。
const agentLogin = new AgentLogin({
  command: runnerCommand,
  baseEnv: process.env,
  stateDir: runnerStateDir,
  spawn: (launch) => {
    const child = spawn(launch.command, launch.args, {
      env: launch.env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      // macOS／Linux：自成一個 process group，逾時時才能結束整個程序樹
      detached: process.platform !== "win32",
    });
    child.stderr?.setEncoding("utf8");
    return {
      pid: child.pid,
      onStderr: (listener) => child.stderr?.on("data", listener),
      onExit: (listener) => {
        child.once("error", (error) => listener(null, error));
        child.once("exit", (code) => listener(code));
      },
    };
  },
  killTree: (pid) => killProcessTree(pid),
});

const supervisor = new RunnerSupervisor({
  launch: () => {
    if (!pairing) throw new Error("沒有 Pairing token，無法啟動 Runner");
    return buildRunnerLaunch({
      command: runnerCommand(),
      baseEnv: process.env,
      // 用取得 Pairing token 時解析好的 Server，不重新讀設定：設定換了 Server 時，不能帶著前一個 Server 的
      // Runner token 去連新的 Server
      serverUrl: pairing.serverUrl,
      pairingToken: pairing.token,
      stateDir: runnerStateDir,
    });
  },
  log: runnerLog,
  initialCommands: () => (config.get().claimingPaused ? [{ type: "pause_claiming" }] : []),
});

const sessionController = new SessionController({
  api,
  hasSessionCookie: async () => {
    const url = serverUrl();
    if (!url) return false;
    const cookies = await session.defaultSession.cookies.get({ url, name: SESSION_COOKIE });
    return cookies.length > 0;
  },
  runner: {
    start: async (token) => {
      const url = serverUrl();
      if (!url) throw new Error("沒有 Server URL，無法啟動 Runner");
      // Runner 直接連 Server 的 API origin（/api/health 回報），不經過 Web UI 的 dev server
      const runnerUrl = await resolveRunnerServerUrl(
        url,
        sessionFetch,
        process.env[DESKTOP_ENV.runnerServerUrl] || undefined,
      );
      if (runnerUrl !== url) runnerLog.note(`Runner 連線到 ${runnerUrl}`);
      await supervisor.stop();
      pairing = { token, serverUrl: runnerUrl };
      supervisor.start();
    },
    stop: async () => {
      await supervisor.stop();
      pairing = null;
    },
    clearState: async () => {
      rmSync(runnerStateDir, { recursive: true, force: true });
      config.update({ runnerId: null });
    },
    activeRuns: () => supervisor.snapshot().status?.active_runs ?? 0,
    runnerId: () => config.get().runnerId,
  },
  log: (message) => runnerLog.note(message),
  confirmLogout: async (activeRuns) => {
    const options = {
      type: "warning" as const,
      buttons: ["登出", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `仍有 ${activeRuns} 個 Run 執行中，登出會中止它們`,
      detail: "登出後會撤銷這台電腦的 Local Runner，並停止 Runner。",
    };
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return response === 0;
  },
});

let lastSupervisorPhase = supervisor.snapshot().phase;
supervisor.onChange((snapshot) => {
  if (snapshot.phase === "needs_pairing") void sessionController.runnerNeedsPairing();
  if (snapshot.phase === "version_mismatch" && lastSupervisorPhase !== "version_mismatch") {
    void onSidecarVersionMismatch();
  }
  lastSupervisorPhase = snapshot.phase;
  const runnerId = snapshot.status?.runner_id;
  if (runnerId && runnerId !== config.get().runnerId) config.update({ runnerId });
  renderTray();
});

/**
 * Runner 與 Server 的協定版本不相容（sidecar 以 SIDECAR_EXIT_VERSION_MISMATCH 結束）：
 * 先向 Server 查版本，查得到就由版本相容的對話框說明要更新哪一邊；查不到才顯示籠統的提示。
 */
async function onSidecarVersionMismatch(): Promise<void> {
  await refreshCompatibility();
  if (compat && compat.kind !== "compatible") return;
  if (testHooksEnabled) {
    testState.dialogs.push(VERSION_MISMATCH_MESSAGE);
    return;
  }
  const options = {
    type: "warning" as const,
    message: VERSION_MISMATCH_MESSAGE,
    detail: "Runner 已停止，不會自動重啟。更新後重新啟動 App 即可。",
  };
  const parent = parentWindow();
  void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
}

// ---- 版本相容（ARCHITECTURE §16）：和 Server 的 /api/health 比對 API 與協定版本

/** 向 Server 查版本並更新判定；Server 暫時連不上時保留上一次的判定。 */
async function refreshCompatibility(): Promise<void> {
  const url = serverUrl();
  if (!url) {
    compat = null;
    shownCompat = null;
    renderTray();
    return;
  }
  const health = await checkServerHealth(url, sessionFetch);
  if (!health.ok) return;
  const verdict = checkCompatibility(LOCAL_VERSIONS, health.versions);
  if (!sameVerdict(verdict, compat)) {
    desktopLog.note(
      verdict.kind === "compatible"
        ? `版本相容（Server v${health.versions?.server ?? "?"}）`
        : `${verdict.message}：${verdict.detail}`,
    );
  }
  compat = verdict;
  renderTray();
  if (verdict.kind === "compatible") {
    shownCompat = null;
    return;
  }
  if (sameVerdict(verdict, shownCompat)) return;
  shownCompat = verdict;
  await showCompatibilityDialog(verdict);
}

/** 版本不相容的對話框：要更新 Desktop 時直接提供檢查更新（Windows）或下載頁（macOS）。 */
async function showCompatibilityDialog(
  verdict: Exclude<CompatibilityVerdict, { kind: "compatible" }>,
): Promise<void> {
  if (testHooksEnabled) {
    testState.dialogs.push(verdict.message);
    return;
  }
  const needsDesktop = verdict.kind !== "update_server";
  const installs = process.platform === "win32";
  const buttons = needsDesktop ? [installs ? "檢查更新" : "開啟下載頁", "稍後"] : ["確定"];
  const options = {
    type: "warning" as const,
    message: verdict.message,
    detail: `${verdict.detail}\nDesktop v${app.getVersion()}。`,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  };
  const parent = parentWindow();
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (!needsDesktop || response !== 0) return;
  if (installs) updateController?.checkNow();
  else openExternal(releasePageUrl(app.getVersion()).replace(/\/tag\/[^/]*$/, ""));
}

// ---- 自動更新（ARCHITECTURE §16）

async function promptUpdate(prompt: UpdatePrompt): Promise<UpdateChoice> {
  if (testHooksEnabled) {
    testState.updatePrompts.push(prompt);
    return testState.updateAnswers.shift() ?? "later";
  }
  const parent = parentWindow();
  const ask = (options: Electron.MessageBoxOptions) =>
    parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  if (prompt.kind === "downloaded") {
    const { response } = await ask({
      type: "info",
      message: `更新 v${prompt.version} 已下載`,
      detail: "立即重新啟動並安裝，或在結束 App 時安裝。安裝前會先停止 Runner。",
      buttons: ["立即重新啟動並更新", "稍後"],
      defaultId: 0,
      cancelId: 1,
    });
    return response === 0 ? "install_now" : "later";
  }
  const { response } = await ask({
    type: "info",
    message: `有新版本 v${prompt.version}`,
    detail: "這個平台不會自動安裝更新：請開啟下載頁，下載後覆蓋現有的 App。",
    buttons: ["開啟下載頁", "略過這個版本", "稍後"],
    defaultId: 0,
    cancelId: 2,
  });
  return (["open_download", "skip_version", "later"] as const)[response] ?? "later";
}

/** 安裝更新前停止 Runner；還有 Run 在跑時先問使用者。 */
async function prepareInstall(): Promise<boolean> {
  const activeRuns = supervisor.snapshot().status?.active_runs ?? 0;
  if (activeRuns > 0 && !testHooksEnabled) {
    const options = {
      type: "warning" as const,
      buttons: ["停止並更新", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `仍有 ${activeRuns} 個 Run 執行中，更新會中止它們`,
      detail: "更新前會先停止 Runner；中止的 Run 會回到佇列。",
    };
    const parent = parentWindow();
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (response !== 0) return false;
  }
  poller.stop();
  await sessionController.dispose();
  return true;
}

function createUpdateController(): UpdateController {
  const controller = new UpdateController({
    updater: createElectronUpdater({
      isPackaged: app.isPackaged,
      feedUrl: process.env[DESKTOP_ENV.updateFeedUrl] || undefined,
      userDataDir: userData,
      log: (message) => desktopLog.note(message),
    }),
    platform: process.platform,
    currentVersion: app.getVersion(),
    prompt: promptUpdate,
    inform: (message) => showInfo(message),
    openDownloadPage: (version) => openExternal(releasePageUrl(version)),
    prepareInstall,
    // 測試時不在結束 App 時真的執行下載下來的安裝檔
    allowInstallOnQuit: !testHooksEnabled,
    skippedVersion: {
      get: () => config.get().skippedUpdateVersion,
      set: (version) => {
        config.update({ skippedUpdateVersion: version });
      },
    },
    log: (message) => desktopLog.note(message),
  });
  controller.onChange(() => renderTray());
  return controller;
}

// ---- Needs You 輪詢與桌面通知

const poller = new NeedsYouPoller({
  list: () => api.listNeedsYou(),
  onItems: (items, newItems) => {
    needsYouCount = items.length;
    // 桌面通知總開關（desktop-notify-toggle）：關閉時照常輪詢、更新系統匣，只是不發原生通知
    if (config.get().notificationsEnabled) {
      for (const item of newItems) showNotification(needsYouNotification(item));
    }
    renderTray();
  },
  onError: (error) => {
    if (error instanceof UnauthorizedError) void sessionController.refresh();
  },
});

sessionController.onChange((state) => {
  if (state.me?.member) {
    poller.start();
  } else {
    poller.stop();
    needsYouCount = 0;
    // 登出後不再顯示任何 Run 的 Preview
    previewView?.destroy();
  }
  renderTray();
});

function showNotification(content: NotificationContent): void {
  const onClick = () => {
    const url = serverUrl();
    if (!url) return;
    const window = ensureMainWindow(url);
    void window.loadURL(`${url}${content.href}`);
    window.show();
    window.focus();
  };
  if (testHooksEnabled) {
    testState.notifications.push(content);
    testState.notificationClicks.push(onClick);
    return;
  }
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: content.title, body: content.body });
  // 保留參照，避免通知還在畫面上時被 GC，點擊事件就收不到
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on("click", () => {
    release();
    onClick();
  });
  notification.on("close", release);
  notification.show();
}

// ---- 系統匣

let trayModel: TrayModel = buildTrayModel({
  runner: { kind: "signed_out" },
  needsYouCount: 0,
  claimingPaused: false,
});

function renderTray(): void {
  const previousLabel = trayModel.statusLabel;
  trayModel = buildTrayModel({
    runner: deriveRunnerView(sessionController.snapshot(), supervisor.snapshot()),
    needsYouCount,
    claimingPaused: config.get().claimingPaused,
    compat,
    update: updateController ? updateView(updateController.snapshot()) : undefined,
  });
  // 狀態變化也寫進 Runner log，排查「為什麼沒有連上」時可以對照時間點
  if (trayModel.statusLabel !== previousLabel) runnerLog.note(`系統匣：${trayModel.statusLabel}`);
  tray?.render(trayModel);
}

function onTrayAction(id: TrayMenuId): void {
  switch (id) {
    case "show-window":
      showMainWindow();
      break;
    case "pause-claiming": {
      const paused = !config.get().claimingPaused;
      config.update({ claimingPaused: paused });
      supervisor.send({ type: paused ? "pause_claiming" : "resume_claiming" });
      renderTray();
      break;
    }
    case "check-updates":
      updateController?.checkNow();
      break;
    case "open-runner-log":
      openRunnerLog();
      break;
    case "open-settings":
      openSettingsWindow(false);
      break;
    case "quit":
      app.quit();
      break;
  }
}

function openRunnerLog(): void {
  if (!existsSync(runnerLog.path)) runnerLog.note("Runner log 建立");
  if (testHooksEnabled) {
    testState.openedPaths.push(runnerLog.path);
    return;
  }
  void shell.openPath(runnerLog.path);
}

// ---- 視窗與安全設定

/** 所有視窗共用的限制：不開新視窗、不嵌 webview、導覽與轉址依 navigation-policy。 */
function hardenWebContents(contents: WebContents, allowedOrigin: () => string | null): void {
  const guard = (event: Electron.Event, url: string) => {
    const origin = allowedOrigin();
    const decision = origin ? decideNavigation(url, origin) : "deny";
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(url);
  };
  contents.on("will-navigate", (details) => guard(details, details.url));
  contents.on("will-redirect", (details) => guard(details, details.url));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const origin = allowedOrigin();
    const decision = origin ? decideNavigation(url, origin) : "deny";
    if (decision === "allow") void contents.loadURL(url);
    else if (decision === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
}

function serverOrigin(): string | null {
  const url = serverUrl();
  return url ? new URL(url).origin : null;
}

function ensureMainWindow(url: string): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: NAMES.productName,
    webPreferences: {
      preload: join(distDir, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  hardenWebContents(window.webContents, serverOrigin);
  window.once("ready-to-show", () => window.show());
  // 關閉視窗只是縮到系統匣，Runner 繼續執行；要結束請用系統匣或選單的「結束」
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      previewView = null;
    }
  });
  // Web UI 換頁或重新載入時，之前的 Preview 不再有對應的分頁
  window.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) previewView?.hide();
  });
  mainWindow = window;
  previewView = new PreviewView({
    window,
    serverOrigin,
    zoomFactor: () => (window.isDestroyed() ? 1 : window.webContents.getZoomFactor()),
    onNavState: (state) => {
      if (!window.isDestroyed()) window.webContents.send(BRIDGE_IPC.previewNavState, state);
    },
    authorize: authorizePreview,
    ...(testHooksEnabled && {
      openExternal: (target: string) => testState.externalUrls.push(target),
    }),
  });
  void window.loadURL(url);
  return window;
}

/**
 * Preview 網址的換票（§13）：帶著 Web UI 的 session cookie 請求 authorize，不跟隨轉址，
 * 回傳它轉往的網址（Preview 網址的 callback）。內嵌瀏覽器本身沒有 Web UI 的 session。
 */
function authorizePreview(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = net.request({
      url,
      session: session.defaultSession,
      useSessionCookies: true,
      redirect: "manual",
    });
    request.on("redirect", (_status, _method, redirectUrl) => {
      request.abort();
      resolve(redirectUrl);
    });
    // 沒有轉址（例如已登出回 401）：不開啟
    request.on("response", () => resolve(null));
    request.on("error", () => resolve(null));
    request.end();
  });
}

function showMainWindow(): void {
  const url = serverUrl();
  if (!url) {
    openSettingsWindow(true);
    return;
  }
  const window = ensureMainWindow(url);
  window.show();
  window.focus();
}

function openSettingsWindow(firstRun: boolean): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 620,
    height: firstRun ? 300 : 520,
    show: false,
    title: NAMES.productName,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(distDir, "settings-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  // 設定頁是本機檔案，不允許導覽到任何其他地方
  hardenWebContents(window.webContents, () => null);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (settingsWindow === window) settingsWindow = null;
    // 第一次啟動時沒設定好就關掉設定頁：沒有其他視窗可用，直接結束
    if (firstRun && !serverUrl()) app.quit();
  });
  settingsWindow = window;
  void window.loadFile(SETTINGS_HTML, firstRun ? { query: { "first-run": "1" } } : {});
}

function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "檔案",
      submenu: [
        { label: "設定…", accelerator: "CmdOrCtrl+,", click: () => openSettingsWindow(false) },
        { label: "開啟 Runner log", click: openRunnerLog },
        { type: "separator" },
        { label: "檢查更新…", click: () => updateController?.checkNow() },
        {
          label: `關於 ${NAMES.productName}`,
          click: () =>
            showInfo(
              `${NAMES.productName} Desktop v${app.getVersion()}`,
              `API 版本 ${LOCAL_VERSIONS.api}、協定版本 ${LOCAL_VERSIONS.protocol}`,
            ),
        },
        { type: "separator" },
        { label: `結束 ${NAMES.productName}`, accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    { role: "editMenu", label: "編輯" },
    {
      label: "檢視",
      submenu: [
        { role: "reload", label: "重新載入" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const, label: "開發者工具" }]),
        { type: "separator" },
        { role: "resetZoom", label: "實際大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "縮小" },
      ],
    },
    { role: "windowMenu", label: "視窗" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC

function fromMainWindow(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    isTrustedSender(frame?.url, frame === mainWindow.webContents.mainFrame, serverOrigin())
  );
}

function fromSettingsWindow(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  if (!url || !settingsWindow || event.sender !== settingsWindow.webContents) return false;
  const expected = pathToFileURL(SETTINGS_HTML);
  const actual = new URL(url);
  return actual.protocol === "file:" && actual.pathname === expected.pathname;
}

/** 用 lstat 判斷：Windows 的 App execution alias（例如 wt.exe）用 stat 讀不到。 */
const pathExists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const commandEnv = (): CommandEnv => {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EACCES" && pathExists(p);
    }
  };
  return {
    platform: process.platform,
    which: createWhich(process.platform, process.env, isFile),
    exists: pathExists,
    env: process.env,
  };
};

const launcher: Launcher = testHooksEnabled
  ? async (spec) => {
      testState.launches.push(spec);
      return { ok: true };
    }
  : spawnLauncher;

/** Worktree 路徑的檢查（Worktree 根目錄底下剛好兩層、解析 symlink 後仍在根目錄內）。 */
function checkWorktree(input: unknown) {
  return checkWorktreePath(input, {
    platform: process.platform,
    home: homedir(),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    realpath: (p) => realpathSync.native(p),
  });
}

async function openWorktree(
  input: unknown,
  build: (choice: ToolChoice, path: string, env: CommandEnv) => LaunchResult,
  choice: ToolChoice,
): Promise<DesktopActionResult> {
  const checked = checkWorktree(input);
  if (!checked.ok) return { ok: false, message: checked.message };
  const launch = build(choice, checked.path, commandEnv());
  if (!launch.ok) return launch;
  return launcher(launch.spec);
}

function registerIpc(): void {
  const denied = { ok: false as const, message: "不允許的呼叫來源" };
  ipcMain.handle(BRIDGE_IPC.getVersion, (event) => {
    if (!fromMainWindow(event)) throw new Error(denied.message);
    return app.getVersion();
  });
  ipcMain.handle(BRIDGE_IPC.openWorktreeInEditor, (event, path: unknown) =>
    fromMainWindow(event) ? openWorktree(path, buildEditorLaunch, config.get().editor) : denied,
  );
  ipcMain.handle(BRIDGE_IPC.openWorktreeInTerminal, (event, path: unknown) =>
    fromMainWindow(event) ? openWorktree(path, buildTerminalLaunch, config.get().terminal) : denied,
  );
  ipcMain.handle(BRIDGE_IPC.beforeLogout, (event) => {
    if (!fromMainWindow(event)) throw new Error(denied.message);
    return sessionController.prepareLogout();
  });
  ipcMain.handle(BRIDGE_IPC.revealWorktree, (event, path: unknown) =>
    fromMainWindow(event)
      ? revealWorktree(path, {
          check: checkWorktree,
          openPath: async (target) => {
            if (testHooksEnabled) {
              testState.openedPaths.push(target);
              return "";
            }
            return shell.openPath(target);
          },
        })
      : denied,
  );
  ipcMain.handle(BRIDGE_IPC.loginAgent, (event, agentId: unknown) =>
    fromMainWindow(event) ? agentLogin.login(agentId) : denied,
  );
  ipcMain.handle(BRIDGE_IPC.getNotificationsEnabled, (event) => {
    if (!fromMainWindow(event)) throw new Error(denied.message);
    return config.get().notificationsEnabled;
  });
  ipcMain.handle(BRIDGE_IPC.setNotificationsEnabled, (event, enabled: unknown) => {
    if (!fromMainWindow(event)) throw new Error(denied.message);
    if (typeof enabled !== "boolean") throw new Error("enabled 必須是 true 或 false");
    config.update({ notificationsEnabled: enabled });
  });
  registerPreviewIpc(denied);

  ipcMain.handle(SETTINGS_IPC.getState, (event): SettingsState => {
    if (!fromSettingsWindow(event)) throw new Error(denied.message);
    const current = config.get();
    return {
      productName: NAMES.productName,
      serverUrl: current.serverUrl,
      editor: current.editor,
      terminal: current.terminal,
      editorPresets: EDITOR_PRESETS,
      terminalPresets: terminalPresets(process.platform),
      pathPlaceholder: PATH_PLACEHOLDER,
    };
  });
  ipcMain.handle(SETTINGS_IPC.saveServerUrl, async (event, input: unknown): Promise<SaveResult> => {
    if (!fromSettingsWindow(event)) return denied;
    const normalized = normalizeServerUrl(typeof input === "string" ? input : "");
    if (!normalized.ok) return normalized;
    const health = await checkServerHealth(normalized.url, sessionFetch);
    if (!health.ok) return health;
    await switchServer(normalized.url);
    settingsWindow?.close();
    return { ok: true };
  });
  ipcMain.handle(SETTINGS_IPC.saveTools, (event, tools: unknown): SaveResult => {
    if (!fromSettingsWindow(event)) return denied;
    const { editor, terminal } = (tools ?? {}) as { editor?: ToolChoice; terminal?: ToolChoice };
    const saved = config.update({
      editor: editor ?? config.get().editor,
      terminal: terminal ?? config.get().terminal,
    });
    if (editor && saved.editor.preset !== editor.preset) {
      return { ok: false, message: "不支援這個編輯器設定" };
    }
    if (terminal && saved.terminal.preset !== terminal.preset) {
      return { ok: false, message: "不支援這個終端機設定" };
    }
    return { ok: true };
  });
}

/** Preview 的內嵌瀏覽器（ARCHITECTURE §13）。開哪個網址由 main 自己向 Server 查詢後決定。 */
function registerPreviewIpc(denied: DesktopActionResult & { ok: false }): void {
  const view = (event: IpcMainInvokeEvent) => (fromMainWindow(event) ? previewView : null);
  ipcMain.handle(
    BRIDGE_IPC.previewShow,
    async (event, runIdInput: unknown, boundsInput: unknown): Promise<PreviewShowResult> => {
      const preview = view(event);
      if (!preview) return denied;
      const runId = parseRunId(runIdInput);
      const bounds = parsePreviewBounds(boundsInput);
      const url = serverUrl();
      if (!runId || !bounds || !url) return { ok: false, message: "參數不正確" };
      const state = await fetchPreviewState(url, sessionFetch, runId);
      if ("error" in state) {
        preview.hide();
        return { ok: false, message: state.error };
      }
      const target = resolvePreviewTarget({ runId, state, localRunnerId: config.get().runnerId });
      if (target.mode === "unavailable") {
        preview.hide();
        return { ok: false, message: target.message };
      }
      await preview.show(target, bounds);
      return { ok: true, mode: target.mode, url: target.url };
    },
  );
  ipcMain.handle(BRIDGE_IPC.previewSetBounds, (event, boundsInput: unknown) => {
    const bounds = parsePreviewBounds(boundsInput);
    if (bounds) view(event)?.setBounds(bounds);
  });
  ipcMain.handle(BRIDGE_IPC.previewHide, (event) => view(event)?.hide());
  ipcMain.handle(BRIDGE_IPC.previewReload, (event) => view(event)?.reload());
  ipcMain.handle(BRIDGE_IPC.previewGoBack, (event) => view(event)?.goBack());
  ipcMain.handle(BRIDGE_IPC.previewGoForward, (event) => view(event)?.goForward());
  ipcMain.handle(BRIDGE_IPC.previewOpenDevTools, (event) => view(event)?.openDevTools());
  ipcMain.handle(BRIDGE_IPC.previewNavigate, (event, input: unknown): DesktopActionResult => {
    const preview = view(event);
    if (!preview) return denied;
    if (typeof input !== "string") return { ok: false, message: "不支援這個網址" };
    return preview.navigate(input);
  });
  ipcMain.handle(BRIDGE_IPC.previewPickElement, (event) => view(event)?.pickElement() ?? null);
}

/** 換到另一個 Server：前一個 Server 的登入狀態與 Runner 都不再有效。 */
async function switchServer(url: string): Promise<void> {
  const previous = serverUrl();
  if (previous !== url) {
    if (previous) {
      await session.defaultSession.clearStorageData({ origin: new URL(previous).origin });
    }
    await sessionController.changeServer(() => {
      config.update({ serverUrl: url });
    });
    if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(url);
  }
  showMainWindow();
  void refreshCompatibility();
}

// ---- App 生命週期

let refreshTimer: NodeJS.Timeout | null = null;
function scheduleSessionRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  // cookie 被覆寫時會連續觸發「移除＋新增」，等一下再確認
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void sessionController.refresh();
  }, 300);
}

async function start(): Promise<void> {
  if (process.platform === "win32") {
    app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath);
  }
  // 預設拒絕網頁的權限請求；只允許 Web UI 寫入剪貼簿（複製按鈕）
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const origin = serverOrigin();
    const fromServer = origin !== null && contents.getURL().startsWith(`${origin}/`);
    callback(fromServer && permission === "clipboard-sanitized-write");
  });
  session.defaultSession.cookies.on("changed", (_event, cookie) => {
    if (cookie.name === SESSION_COOKIE) scheduleSessionRefresh();
  });

  registerIpc();
  buildAppMenu();
  try {
    tray = new DesktopTray(onTrayAction, showMainWindow);
  } catch (error) {
    // 部分 Linux 桌面環境沒有系統匣
    runnerLog.note(`無法建立系統匣：${(error as Error).message}`);
  }
  renderTray();

  if (testHooksEnabled) {
    installTestHooks({
      notifications: testState.notifications,
      clickNotification: (index) => testState.notificationClicks[index]?.(),
      launches: testState.launches,
      openedPaths: testState.openedPaths,
      externalUrls: testState.externalUrls,
      previewWebContentsId: () => previewView?.webContents?.id ?? null,
      trayAction: onTrayAction,
      tray: () => trayModel,
      sidecar: () => supervisor.snapshot(),
      session: () => sessionController.snapshot(),
      config: () => config.get(),
      runnerLogPath: runnerLog.path,
      update: () => updateController?.snapshot() ?? { kind: "unavailable" },
      updatePrompts: testState.updatePrompts,
      answerUpdatePrompt: (choice) => {
        testState.updateAnswers.push(choice);
      },
      compat: () => compat,
      dialogs: testState.dialogs,
    });
  }

  updateController = createUpdateController();
  updateController.start();
  setInterval(() => void refreshCompatibility(), COMPAT_RECHECK_MS);

  const url = serverUrl();
  if (url) {
    ensureMainWindow(url);
    void refreshCompatibility();
    await sessionController.refresh();
  } else {
    openSettingsWindow(true);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app.on("activate", showMainWindow);
  // 有系統匣時關掉所有視窗不結束；結束一律經由 before-quit
  app.on("window-all-closed", () => {
    if (!tray) app.quit();
  });

  let shutdownDone = false;
  app.on("before-quit", (event) => {
    quitting = true;
    if (shutdownDone) return;
    event.preventDefault();
    poller.stop();
    updateController?.dispose();
    void sessionController
      .dispose()
      .catch((error: unknown) => runnerLog.note(`停止 Runner 失敗：${String(error)}`))
      .finally(() => {
        shutdownDone = true;
        runnerLog.close();
        desktopLog.close();
        tray?.destroy();
        app.quit();
      });
  });

  void app.whenReady().then(start);
}
