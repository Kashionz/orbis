import { execFileSync } from "node:child_process";
import { envVar } from "@orbis/api-contract/names";
import { defineConfig, devices } from "@playwright/test";

/**
 * e2e 用的 port：第一次載入設定時向作業系統要一個空的 port，存在環境變數中，
 * 讓 Playwright 的 worker 程序（會重新載入設定）用同一個 port。
 */
function e2ePort(): number {
  const name = envVar("WEB_E2E_PORT");
  if (!process.env[name]) {
    const script =
      "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
    process.env[name] = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim();
  }
  return Number(process.env[name]);
}

const port = e2ePort();
const baseURL = `http://localhost:${port}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  // 完整系統的 e2e（真實 Server + Runner + Fake Agent）另有設定檔，見 playwright.system.config.ts
  testIgnore: "system/**",
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // mock 模式：以 MSW 假後端取代 Server（src/mocks）
    command: `pnpm exec vite --mode mock --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
