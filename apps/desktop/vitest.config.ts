import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/ 是 Playwright（Electron 模式）的測試，不由 vitest 執行
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
