// 測試與完整系統 e2e（e2e:stack）用的 Postgres：一律在「測試用的 Postgres」上建立獨立的 database，
// 用完就刪除，絕不使用開發 DB（`.env` 的 DATABASE_URL）。
//
// 測試用的 Postgres 由 TEST_DATABASE_URL 指定（admin 連線，需要 CREATEDB 權限，例如 CI 安裝的原生
// Postgres）；沒有設定時由呼叫端改用 Testcontainers。

import { randomBytes } from "node:crypto";
import { envVar } from "@orbis/api-contract";
import pg from "pg";

/** 測試用 Postgres 的 admin 連線字串。 */
export const TEST_DATABASE_URL_ENV = envVar("TEST_DATABASE_URL");
/** 開發 DB 的連線字串（Server 的 DATABASE_URL），測試不可以用它。 */
const DEV_DATABASE_URL_ENV = envVar("DATABASE_URL");

/** Postgres 連線字串指向的 database（host、port、database 名稱），用來比對是不是同一個。 */
function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const normalizedHost = host === "127.0.0.1" || host === "::1" ? "localhost" : host;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || parsed.username;
  return `${normalizedHost}:${parsed.port || "5432"}/${database}`;
}

/**
 * 讀取 TEST_DATABASE_URL；沒有設定時回傳 null。
 * 與 DATABASE_URL 指向同一個 database 時丟出錯誤，避免把測試資料寫進開發 DB。
 */
export function readTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env[TEST_DATABASE_URL_ENV]?.trim();
  if (!url) return null;
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(`${TEST_DATABASE_URL_ENV} 必須是 postgres:// 開頭的連線字串`);
  }
  const devUrl = env[DEV_DATABASE_URL_ENV]?.trim();
  if (devUrl && databaseIdentity(devUrl) === databaseIdentity(url)) {
    throw new Error(
      `${TEST_DATABASE_URL_ENV} 與 ${DEV_DATABASE_URL_ENV} 指向同一個 database；測試不可以使用開發 DB`,
    );
  }
  return url;
}

export interface ScratchDatabase {
  /** 新 database 的連線字串。 */
  url: string;
  name: string;
  /** 刪除 database（仍有連線時強制中斷）。 */
  drop(): Promise<void>;
}

async function withAdmin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** 在 adminUrl 的 Postgres 上建立一個全新的 database（名稱為 `<prefix>_<亂數>`）。 */
export async function createScratchDatabase(
  adminUrl: string,
  prefix: string,
): Promise<ScratchDatabase> {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) throw new Error(`database 前綴不合法：${prefix}`);
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  await withAdmin(adminUrl, (admin) => admin.query(`create database "${name}"`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    drop: async () => {
      await withAdmin(adminUrl, (admin) =>
        admin.query(`drop database if exists "${name}" with (force)`),
      );
    },
  };
}
