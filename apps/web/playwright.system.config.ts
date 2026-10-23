// 完整系統的 e2e：真實 Server + Postgres + Local Runner + Fake Agent，Web 以 Vite 接到 Server。
//
// globalSetup 啟動 B1 的 `e2e:stack` 與 Vite（都用空的 port），teardown 關閉它們並確認沒有殘留的程序。
// 執行前要先 `cargo build -p <產品>-runner -p <產品>-fake-agent`。需要 Postgres：有 `<前綴>DATABASE_URL`
// 時用它，沒有時 stack 以 Testcontainers 啟動（需要 Docker）。

import { defineConfig, devices } from "@playwright/test";
import { systemPorts } from "./e2e/system/ports";

const { webPort } = systemPorts();
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e/system",
  outputDir: "test-results/system",
  globalSetup: "./e2e/system/global-setup.ts",
  forbidOnly: isCI,
  retries: 0,
  // 整個系統只有一組種子資料與一台 Runner，測試依序執行
  workers: 1,
  // 真實的 Runner 與 Agent 比 MSW 慢
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: isCI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/system" }]]
    : "list",
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
