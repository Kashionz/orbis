// 每個測試檔建立一個全新的 database 並跑完 migration，彼此不互相影響。

import { inject } from "vitest";
import { createDatabase, type DatabaseHandle, runMigrations } from "../../src/db/client";
import { createScratchDatabase } from "../../src/db/test-database";

export { dbSkipReason } from "./db-skip";

export interface TestDatabase extends DatabaseHandle {
  url: string;
  /** 關閉連線並刪除 database。 */
  drop(): Promise<void>;
}

/** 建立一個空的 database（還沒跑 migration）。 */
export async function createEmptyTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject("postgresAdminUrl");
  if (!adminUrl) throw new Error("沒有可用的測試 Postgres");
  const scratch = await createScratchDatabase(adminUrl, "test");
  const handle = createDatabase(scratch.url);
  return {
    ...handle,
    url: scratch.url,
    async drop() {
      await handle.close();
      await scratch.drop();
    },
  };
}

/** 建立 database 並跑完 migration。 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const database = await createEmptyTestDatabase();
  await runMigrations(database.db);
  return database;
}
