// Server 進入點：讀設定 → 連資料庫並執行 migration → 啟動 HTTP 與 Runner WebSocket。
// 本機設定放在 repo 根目錄的 .env，由 dev／start script 以 --env-file-if-exists 載入。

import { GitHubAppConfigError, loadGitHubAppConfig } from "@orbis/github";
import { createGitHubOAuth } from "./auth/github-oauth";
import { ConfigError, loadConfig } from "./config";
import { createDatabase, runMigrations } from "./db/client";
import { createLogger } from "./logger";
import { RUNNER_WS_PATH } from "./runner/endpoint";
import { startServer } from "./server";

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  let githubApp: ReturnType<typeof loadGitHubAppConfig>;
  try {
    config = loadConfig(process.env);
    githubApp = loadGitHubAppConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof GitHubAppConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel, pretty: config.prettyLogs });
  if (!config.bootstrapOwnerGithubUserId) {
    logger.warn("未設定 bootstrap owner，第一次登入時不會自動建立 Team");
  }
  if (!githubApp) {
    logger.warn("未設定 GitHub App，Repo 的 App 安裝檢查、Issue 同步與開 PR 都停用");
  }
  if (!config.devPairingToken) {
    logger.warn("未設定開發用 Pairing token，Runner 無法完成 Pairing");
  }

  const database = createDatabase(config.databaseUrl, { logger });
  await runMigrations(database.db);
  logger.info("資料庫 migration 完成");

  const server = await startServer({
    config,
    db: database.db,
    logger,
    githubOAuth: createGitHubOAuth(config.github),
    ...(githubApp && { github: { app: { config: githubApp } } }),
  });
  logger.info(
    { port: server.port, runnerPath: RUNNER_WS_PATH, publicUrl: config.publicUrl },
    `Server 已啟動：http://localhost:${server.port}`,
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Server 關閉中");
    await server.close();
    await database.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
