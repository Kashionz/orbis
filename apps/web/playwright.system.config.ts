// 完整系統的 e2e：真實 Server + Postgres + Runner + Fake Agent，Web 以 Vite 接到 Server。
//
// 完整系統由整合流程先啟動（需要 A1、B1 提供的測試用登入、種子資料與 Runner Pairing），
// 這裡只負責跑測試。沒有設定 `<前綴>SYSTEM_E2E_BASE_URL` 時，所有測試都會 skip。

import { envVar } from "@orbis/api-contract/names";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env[envVar("SYSTEM_E2E_BASE_URL")];
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e/system",
  forbidOnly: isCI,
  retries: 0,
  // 真實的 Runner 與 Agent 比 MSW 慢
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
