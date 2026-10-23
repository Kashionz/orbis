// 只在 DESKTOP_ENV.testHooks=1 時啟用：Playwright（Electron 模式）用 electronApp.evaluate() 讀取
// main 程序的狀態，並攔截通知與本機工具的啟動，避免測試真的跳出通知或開啟程式。

import type { DesktopConfig } from "./config-store";
import type { LaunchSpec } from "./local-tools/command";
import type { NotificationContent } from "./notifications/needs-you";
import type { SessionState } from "./session/session-controller";
import type { SupervisorSnapshot } from "./sidecar/supervisor";
import type { TrayMenuId, TrayModel } from "./tray/tray-model";

export const TEST_HOOKS_GLOBAL = "__desktopTestHooks";

export interface DesktopTestHooks {
  notifications: NotificationContent[];
  clickNotification(index: number): void;
  launches: LaunchSpec[];
  openedPaths: string[];
  trayAction(id: TrayMenuId): void;
  tray(): TrayModel;
  sidecar(): SupervisorSnapshot;
  session(): SessionState;
  config(): DesktopConfig;
  runnerLogPath: string;
}

export function installTestHooks(hooks: DesktopTestHooks): void {
  (globalThis as Record<string, unknown>)[TEST_HOOKS_GLOBAL] = hooks;
}
