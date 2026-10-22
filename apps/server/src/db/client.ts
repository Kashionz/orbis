// 資料庫連線與 migration。

import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** migration 目錄（drizzle-kit 產生）。用 fileURLToPath 轉成各平台的原生路徑。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

export function createDatabase(databaseUrl: string): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  return { db, pool, close: () => pool.end() };
}

/** 套用所有尚未執行的 migration。Server 啟動時自動呼叫。 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
