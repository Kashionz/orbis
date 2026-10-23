// MSW 假後端的設定。Playwright 以 `page.addInitScript` 在頁面載入前設定 `window.__MOCK_CONFIG__`。

import type { ProjectPolicy, Role } from "@orbis/api-contract";

/** 假後端狀態在 sessionStorage 中的 key（e2e 也用它讀出狀態）。 */
export const MOCK_STATE_STORAGE_KEY = "mock-backend-state";

export interface MockConfig {
  /** 登入者在 Team 的 Role，預設 `owner`。 */
  role?: Role;
  /** 登入者在「核心產品」Project 的 Role 覆寫（Project 的 `viewerRole`）；省略時沿用 Team 的 Role。 */
  projectRole?: Role;
  /** 登入狀態：`unauthorized`＝回 401、`error`＝回 500、`no-team`＝還不是任何 Team 的 Member。 */
  session?: "ok" | "unauthorized" | "error" | "no-team";
  /** 模擬 Agent 每一步的間隔，預設 150ms。 */
  eventIntervalMs?: number;
  /** 大量 Event 的 Run 有幾筆 Event，預設 5,000。 */
  largeRunEvents?: number;
  /** 覆寫 Project 的政策。 */
  policy?: Partial<ProjectPolicy>;
  /** Server 拒絕所有寫入（403），模擬 UI 判斷與 Server 不一致的情況。 */
  forbidWrites?: boolean;
  /** 派工對話框的情境：`none`＝沒有任何 Runner 完成 Pairing。 */
  runners?: "default" | "none";
  /** 另外建立一個等待「設定的信任核准」的 Run。 */
  configTrust?: boolean;
  /** review diff 中 README.md 修改後的內容放在 blob，並多一個二進位檔案。 */
  blobDiff?: boolean;
}

declare global {
  interface Window {
    __MOCK_CONFIG__?: MockConfig;
  }
}

export function mockConfig(): MockConfig {
  return typeof window === "undefined" ? {} : (window.__MOCK_CONFIG__ ?? {});
}
