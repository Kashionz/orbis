import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";
import { readTestDatabaseUrl, TEST_DATABASE_URL_ENV } from "../src/db/test-database";
import { dbSkipReason } from "./helpers/db-skip";

/** DB 測試使用的 Postgres 映像檔，與 docker compose 的版本一致。 */
const POSTGRES_IMAGE = "postgres:17";

declare module "vitest" {
  export interface ProvidedContext {
    /** 測試用 Postgres 的 admin 連線字串；DB 測試被略過時為 null。 */
    postgresAdminUrl: string | null;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * 有 TEST_DATABASE_URL 時直接用那個 Postgres（每個測試檔各自建立獨立的 database），
 * 沒有時啟動一個 Testcontainers 的 Postgres 給所有 DB 測試共用。
 */
export async function setup(project: TestProject): Promise<void> {
  if (dbSkipReason) {
    console.warn(`[db-tests] 略過：${dbSkipReason}`);
    project.provide("postgresAdminUrl", null);
    return;
  }
  let external: string | null;
  try {
    external = readTestDatabaseUrl();
  } catch (error) {
    // 直接印出原因：vitest 處理 globalSetup 的錯誤時可能只剩 source map 的錯誤。
    console.error(`[db-tests] ${(error as Error).message}`);
    throw error;
  }
  if (external) {
    console.warn(`[db-tests] 使用 ${TEST_DATABASE_URL_ENV} 指定的 Postgres`);
    project.provide("postgresAdminUrl", external);
    return;
  }
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  project.provide("postgresAdminUrl", container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
