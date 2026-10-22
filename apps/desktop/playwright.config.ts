import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);

// Electron 模式：測試自己啟動 App 與 fake Server（port 0），不需要 webServer。
// 執行前要先 `node scripts/build.mjs`（`pnpm test:e2e` 會先打包）。
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // 每個測試各自啟動一個 Electron 與 Runner，依序執行比較穩定
  workers: 1,
  timeout: 90_000,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
});
