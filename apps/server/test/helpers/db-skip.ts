// DB 測試（Testcontainers）只在 Linux CI 跑；Windows／macOS 的 CI 明確 skip 並印出原因。
// 本機（沒有設定 CI）一律照常跑，需要 Docker。

export const dbSkipReason: string | null =
  process.env.CI && process.platform !== "linux"
    ? `CI 環境的 ${process.platform} 沒有可用的 Linux 容器，略過需要 Postgres（Testcontainers）的測試；這些測試只在 Linux CI 執行`
    : null;
