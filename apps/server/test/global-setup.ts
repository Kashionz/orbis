import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";
import { dbSkipReason } from "./helpers/db-skip";

/** DB 測試使用的 Postgres 映像檔，與 docker compose 的版本一致。 */
const POSTGRES_IMAGE = "postgres:17";

declare module "vitest" {
  export interface ProvidedContext {
    /** 容器的 admin 連線字串；DB 測試被略過時為 null。 */
    postgresAdminUrl: string | null;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  if (dbSkipReason) {
    console.warn(`[db-tests] 略過：${dbSkipReason}`);
    project.provide("postgresAdminUrl", null);
    return;
  }
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  project.provide("postgresAdminUrl", container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
