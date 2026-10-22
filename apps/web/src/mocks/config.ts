// MSW 假後端的設定。Playwright 以 `page.addInitScript` 在頁面載入前設定 `window.__MOCK_CONFIG__`。

import type { ProjectPolicy, Role } from "@orbis/api-contract";

export interface MockConfig {
  /** 登入者的 Role，預設 `owner`。 */
  role?: Role;
  /** 登入狀態：`unauthorized`＝回 401、`error`＝回 500、`no-team`＝還不是任何 Team 的 Member。 */
  session?: "ok" | "unauthorized" | "error" | "no-team";
  /** 模擬 Agent 每一步的間隔，預設 150ms。 */
  eventIntervalMs?: number;
  /** 大量 Event 的 Run 有幾筆 Event，預設 5,000。 */
  largeRunEvents?: number;
  /** 覆寫 Project 的政策。 */
  policy?: Partial<ProjectPolicy>;
  /** 派工對話框的情境：`none`＝沒有任何 Runner 完成 Pairing。 */
  runners?: "default" | "none";
}

declare global {
  interface Window {
    __MOCK_CONFIG__?: MockConfig;
  }
}

export function mockConfig(): MockConfig {
  return typeof window === "undefined" ? {} : (window.__MOCK_CONFIG__ ?? {});
}
