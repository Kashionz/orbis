import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);

// Desktop 的完整系統 e2e（Electron 版的 M1 路徑）：spec 自己啟動 e2e:stack、Vite 與 Electron（都用空的 port）。
// 執行前要先 `cargo build -p <產品>-runner -p <產品>-fake-agent`，`pnpm test:e2e:system` 會先打包 Desktop。
// 需要 Postgres：有 `<前綴>DATABASE_URL` 時用它，沒有時 stack 以 Testcontainers 啟動（需要 Docker）。
export default defineConfig({
  testDir: "e2e/system",
  outputDir: "test-results/system",
  forbidOnly: isCI,
  retries: 0,
  // 整個系統只有一組種子資料與一台 Runner
  workers: 1,
  timeout: 300_000,
  // 真實的 Runner 與 Agent 比 fake Server 慢
  expect: { timeout: 30_000 },
  reporter: isCI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/system" }]]
    : "list",
  use: { trace: "retain-on-failure" },
});
