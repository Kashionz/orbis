import { defineConfig, devices } from "@playwright/test";

/** e2e 用獨立的 port，避免和正在跑的 dev server（5173）衝突。 */
const E2E_PORT = 5183;
const baseURL = `http://localhost:${E2E_PORT}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // 測試以 page.route 模擬 /api，不需要真實 Server
    command: `pnpm exec vite --port ${E2E_PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
