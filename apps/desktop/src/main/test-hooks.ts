// 只在 DESKTOP_ENV.testHooks=1 時啟用：Playwright（Electron 模式）用 electronApp.evaluate() 讀取
// main 程序的狀態，並攔截通知、本機工具的啟動與對話框，避免測試真的跳出通知、開啟程式或卡在對話框上。

import type { DesktopConfig } from "./config-store";
import type { LaunchSpec } from "./local-tools/command";
import type { NotificationContent } from "./notifications/needs-you";
import type { SessionState } from "./session/session-controller";
import type { SupervisorSnapshot } from "./sidecar/supervisor";
import type { TrayMenuId, TrayModel } from "./tray/tray-model";
import type { UpdateChoice, UpdatePrompt, UpdateState } from "./update/controller";
import type { CompatibilityVerdict } from "./version/compat";

export const TEST_HOOKS_GLOBAL = "__desktopTestHooks";

export interface DesktopTestHooks {
  notifications: NotificationContent[];
  clickNotification(index: number): void;
  launches: LaunchSpec[];
  openedPaths: string[];
  /** Preview 內嵌瀏覽器與更新提示交給外部瀏覽器開啟的網址。 */
  externalUrls: string[];
  /** Preview 內嵌瀏覽器的 webContents ID；還沒開啟時是 null。 */
  previewWebContentsId(): number | null;
  trayAction(id: TrayMenuId): void;
  tray(): TrayModel;
  sidecar(): SupervisorSnapshot;
  session(): SessionState;
  config(): DesktopConfig;
  runnerLogPath: string;
  /** 自動更新的狀態（UpdateController）。 */
  update(): UpdateState;
  /** 更新流程跳出的對話框；回答由 answerUpdatePrompt 預先排好，沒有排就是「稍後」。 */
  updatePrompts: UpdatePrompt[];
  answerUpdatePrompt(choice: UpdateChoice): void;
  /** Desktop 與 Server 的版本相容判定；還沒查過時是 null。 */
  compat(): CompatibilityVerdict | null;
  /** 顯示過的一般對話框訊息（版本不相容、手動檢查更新的結果）。 */
  dialogs: string[];
}

export function installTestHooks(hooks: DesktopTestHooks): void {
  (globalThis as Record<string, unknown>)[TEST_HOOKS_GLOBAL] = hooks;
}
