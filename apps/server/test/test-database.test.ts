// 測試用 Postgres 的設定（src/db/test-database.ts）：不可以是開發 DB。

import { envVar } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { readTestDatabaseUrl } from "../src/db/test-database";

const TEST = envVar("TEST_DATABASE_URL");
const DEV = envVar("DATABASE_URL");

describe("readTestDatabaseUrl", () => {
  it("沒有設定時回傳 null", () => {
    expect(readTestDatabaseUrl({})).toBeNull();
    expect(readTestDatabaseUrl({ [TEST]: "  " })).toBeNull();
  });

  it("回傳設定的連線字串", () => {
    const url = "postgres://postgres:pw@localhost:5432/postgres";
    expect(readTestDatabaseUrl({ [TEST]: url, [DEV]: "postgres://orbis@localhost/orbis" })).toBe(
      url,
    );
  });

  it("與開發 DB 指向同一個 database 時拒絕（localhost 與 127.0.0.1、省略 port 視為相同）", () => {
    expect(() =>
      readTestDatabaseUrl({
        [TEST]: "postgres://admin:x@127.0.0.1/orbis",
        [DEV]: "postgres://orbis:orbis@localhost:5432/orbis",
      }),
    ).toThrow(/開發 DB/);
  });

  it("同一台 Postgres 的不同 database 可以使用（測試會另建 database）", () => {
    expect(
      readTestDatabaseUrl({
        [TEST]: "postgres://postgres:x@localhost:5432/postgres",
        [DEV]: "postgres://orbis:orbis@localhost:5432/orbis",
      }),
    ).not.toBeNull();
  });

  it("不是 postgres:// 開頭時拒絕", () => {
    expect(() => readTestDatabaseUrl({ [TEST]: "mysql://localhost/db" })).toThrow(/postgres/);
  });
});
