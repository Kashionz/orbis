// 每個測試檔建立一個全新的 database 並跑完 migration，彼此不互相影響。

import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { createDatabase, type DatabaseHandle, runMigrations } from "../../src/db/client";

export { dbSkipReason } from "./db-skip";

export interface TestDatabase extends DatabaseHandle {
  url: string;
  /** 關閉連線並刪除 database。 */
  drop(): Promise<void>;
}

/** 建立一個空的 database（還沒跑 migration）。 */
export async function createEmptyTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject("postgresAdminUrl");
  if (!adminUrl) throw new Error("沒有可用的 Postgres 容器");
  const name = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle = createDatabase(url.toString());
  return {
    ...handle,
    url: url.toString(),
    async drop() {
      await handle.close();
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`drop database if exists "${name}" with (force)`);
      await client.end();
    },
  };
}

/** 建立 database 並跑完 migration。 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const database = await createEmptyTestDatabase();
  await runMigrations(database.db);
  return database;
}
