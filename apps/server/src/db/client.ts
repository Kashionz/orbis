// 資料庫連線與 migration。

import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Logger } from "../logger";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** migration 目錄（drizzle-kit 產生）。用 fileURLToPath 轉成各平台的原生路徑。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

export interface DatabaseOptions {
  /** 記錄 pool 中閒置連線的錯誤；未提供時只吞掉錯誤。 */
  logger?: Logger;
}

export function createDatabase(databaseUrl: string, options: DatabaseOptions = {}): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  // 閒置中的連線出錯（資料庫重新啟動、連線被 pg_terminate_backend 中斷、網路斷線）時，pg.Pool 會發出
  // `error`。沒有 listener 時 Node 會把它當成 uncaught exception，整個 Server 跟著 crash；
  // 有 listener 時 pool 只是把那條連線移除，下一次查詢會重新建立連線。所以這裡一定要掛 listener。
  pool.on("error", (error) => {
    options.logger?.warn(
      { err: error },
      "資料庫的閒置連線中斷，已從 pool 移除；下次查詢會重新連線",
    );
  });
  // pool.end() 在連線從 pool 移除時就完成，那時連線可能還在關閉。這段期間資料庫中斷連線
  // （例如測試緊接著 drop database ... with (force)）送來的錯誤沒有人處理，會變成 uncaught error，
  // 所以 close() 要等每條連線真的斷開。
  const ending = new Set<Promise<void>>();
  pool.on("connect", (client) => {
    const ended = new Promise<void>((resolve) => client.once("end", () => resolve()));
    ending.add(ended);
    void ended.then(() => ending.delete(ended));
  });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
      await Promise.all(ending);
    },
  };
}

/** 套用所有尚未執行的 migration。Server 啟動時自動呼叫。 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
