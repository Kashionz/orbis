// 把 electron-updater 接成 UpdateController 用的 UpdaterLike。
// - 打包後：electron-builder 依 RELEASE_SOURCE 產生 resources/app-update.yml（GitHub provider），直接用。
// - 開發模式：預設沒有更新來源（回傳 null）。設定 DESKTOP_ENV.updateFeedUrl 時，寫一份 generic provider 的
//   設定檔交給 electron-updater，開發模式也會檢查更新（e2e 用本機的 fake feed）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAMES } from "@orbis/api-contract/names";
import { autoUpdater, type Logger } from "electron-updater";
import type { UpdaterLike } from "./controller";

export interface CreateUpdaterOptions {
  isPackaged: boolean;
  /** DESKTOP_ENV.updateFeedUrl。 */
  feedUrl: string | undefined;
  /** 開發模式的設定檔寫在這個目錄底下。 */
  userDataDir: string;
  log: (message: string) => void;
}

export function createElectronUpdater(options: CreateUpdaterOptions): UpdaterLike | null {
  if (!options.isPackaged && !options.feedUrl) return null;
  const logger: Logger = {
    info: (message) => options.log(`[updater] ${String(message)}`),
    warn: (message) => options.log(`[updater] 警告：${String(message)}`),
    error: (message) => options.log(`[updater] 錯誤：${String(message)}`),
  };
  autoUpdater.logger = logger;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  if (options.feedUrl) {
    // 和打包後的 app-update.yml 同樣的欄位；updaterCacheDirName 是下載快取的目錄名稱
    const configPath = join(options.userDataDir, "dev-app-update.yml");
    mkdirSync(options.userDataDir, { recursive: true });
    writeFileSync(
      configPath,
      [
        "provider: generic",
        `url: ${JSON.stringify(options.feedUrl)}`,
        `updaterCacheDirName: ${NAMES.productSlug}-updater-dev`,
        "",
      ].join("\n"),
    );
    autoUpdater.updateConfigPath = configPath;
    autoUpdater.forceDevUpdateConfig = true;
    options.log(`更新來源改為 ${options.feedUrl}`);
  }
  return autoUpdater;
}
