// DB 測試需要 Postgres：有 TEST_DATABASE_URL（CI 在三平台安裝的原生 Postgres）時用它；
// 沒有時以 Testcontainers 啟動，需要 Docker，所以 Linux 以外的 CI 明確 skip 並印出原因。
// 本機（沒有設定 CI）一律照常跑。

import { TEST_DATABASE_URL_ENV } from "../../src/db/test-database";

// 這裡只看有沒有設定；連線字串的檢查（包含不可以是開發 DB）在 global-setup 做。
const hasTestDatabaseUrl = Boolean(process.env[TEST_DATABASE_URL_ENV]?.trim());

export const dbSkipReason: string | null =
  !hasTestDatabaseUrl && process.env.CI && process.platform !== "linux"
    ? `CI 環境的 ${process.platform} 沒有設定 ${TEST_DATABASE_URL_ENV}，也沒有可用的 Linux 容器，略過需要 Postgres 的測試`
    : null;
