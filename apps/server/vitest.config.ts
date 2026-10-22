import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 啟動一個 Postgres 容器給所有 DB 測試共用；每個測試檔各自建立獨立的 database。
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
