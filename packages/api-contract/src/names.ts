// 名稱常數的 TS 版。產品名稱、設定檔名、環境變數前綴只能從這裡取得，不可以寫死字串。
// Rust 版在 crates/orbis-protocol/src/names.rs，兩邊由 test/names.test.ts 比對。

import type { Names } from "@orbis/protocol";

export const NAMES = {
  productName: "Orbis",
  productSlug: "orbis",
  configDir: ".orbis",
  configFile: "config.toml",
  envPrefix: "ORBIS_",
  branchPrefix: "orbis/",
  worktreeRootWindows: "C:\\ob",
  worktreeRootUnix: "~/.orbis/wt",
  env: {
    rootPath: "ORBIS_ROOT_PATH",
    worktreePath: "ORBIS_WORKTREE_PATH",
    port: "ORBIS_PORT",
    runId: "ORBIS_RUN_ID",
    taskKey: "ORBIS_TASK_KEY",
  },
} as const satisfies Names;

/** 由前綴組出完整的環境變數名稱，例如 `envVar("DATABASE_URL")`。 */
export function envVar(suffix: string): string {
  return `${NAMES.envPrefix}${suffix}`;
}
