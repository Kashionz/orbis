// Desktop 用到的名稱，全部由名稱常數組出，不寫死產品名稱與環境變數前綴。

import { envVar, NAMES } from "@orbis/api-contract/names";

/** Server 的 session cookie 名稱，與 apps/server/src/routes/auth.ts 的 SESSION_COOKIE 一致。 */
export const SESSION_COOKIE = `${NAMES.productSlug}_session`;

/** Runner 執行檔的檔名（cargo 的 bin 名稱）。 */
export function runnerBinaryName(platform: NodeJS.Platform = process.platform): string {
  return `${NAMES.productSlug}-runner${platform === "win32" ? ".exe" : ""}`;
}

/** Windows 的 AppUserModelId，桌面通知需要它。 */
export const APP_USER_MODEL_ID = `com.${NAMES.productSlug}.desktop`;

/** Desktop 自己讀取的環境變數。 */
export const DESKTOP_ENV = {
  /** 覆寫 userData 目錄（測試用，讓每個測試有獨立的設定與 cookie）。 */
  userDataDir: envVar("DESKTOP_USER_DATA_DIR"),
  /** 覆寫 sidecar 的啟動指令，JSON 字串陣列，例如 `["node", "fake-sidecar.mjs"]`（測試與開發用）。 */
  runnerCommand: envVar("DESKTOP_RUNNER_COMMAND"),
  /** 覆寫 Runner 要連線的 Server 網址；未設定時用 `/api/health` 回報的 API origin（開發與測試用）。 */
  runnerServerUrl: envVar("RUNNER_SERVER_URL"),
  /** 啟用測試用的 hook：記錄通知與本機工具的啟動，而不真的執行。只給 Playwright 使用。 */
  testHooks: envVar("DESKTOP_TEST_HOOKS"),
} as const;

/** 傳給 Runner sidecar 的環境變數（協定的 names.runner_env）。 */
export const RUNNER_ENV = {
  serverUrl: NAMES.runnerEnv.serverUrl,
  pairingToken: NAMES.runnerEnv.pairingToken,
  /** 只覆寫狀態目錄；Runner 的設定檔仍從家目錄讀取。 */
  stateDir: NAMES.runnerEnv.stateDir,
} as const;
