// 資料庫連線（src/db/client.ts）：close() 要等每條連線真的斷開，之後 drop database 才不會中斷還在關閉的連線；
// 閒置連線被中斷時只記 log、不讓程序 crash。

import { sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { createDatabase } from "../../src/db/client";
import { createScratchDatabase } from "../../src/db/test-database";
import { createLogger } from "../../src/logger";
import { dbSkipReason } from "../helpers/db";

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等待 ${what} 逾時`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(dbSkipReason !== null)("createDatabase 的 close()", () => {
  it("等所有連線斷開才完成", async () => {
    const adminUrl = inject("postgresAdminUrl");
    if (!adminUrl) throw new Error("沒有可用的測試 Postgres");
    const scratch = await createScratchDatabase(adminUrl, "test");
    try {
      const handle = createDatabase(scratch.url);
      let connected = 0;
      let ended = 0;
      handle.pool.on("connect", (client) => {
        connected++;
        client.once("end", () => ended++);
      });
      // 同時查詢，讓 pool 開出多條連線。
      await Promise.all(
        Array.from({ length: 5 }, () => handle.db.execute(sql`select pg_sleep(0.05)`)),
      );
      expect(connected).toBeGreaterThan(1);
      await handle.close();
      // 只等到連線從 pool 移除的話，這時連線還在關閉；接著 drop database ... with (force)
      // 中斷它們時，送來的錯誤會變成 uncaught error。
      expect(ended).toBe(connected);
    } finally {
      await scratch.drop();
    }
  });

  it("閒置連線被資料庫中斷時記 log、不 crash，之後查詢仍成功（91：pg Pool 的 error listener）", async () => {
    const adminUrl = inject("postgresAdminUrl");
    if (!adminUrl) throw new Error("沒有可用的測試 Postgres");
    const scratch = await createScratchDatabase(adminUrl, "test");
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const lines: string[] = [];
      const logger = createLogger({
        level: "warn",
        pretty: false,
        destination: { write: (line: string) => void lines.push(line) },
      });
      const handle = createDatabase(scratch.url, { logger });
      const pid = await handle.db
        .execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        .then((r) => r.rows[0]?.pid);
      expect(pid).toBeTypeOf("number");
      // 這條連線已回到 pool 閒置；從另一條連線把它中斷，模擬資料庫重新啟動或網路中斷。
      // 沒有 error listener 時，pg.Pool 發出的 `error` 會變成 uncaught exception，讓測試程序整個失敗。
      await admin.query("select pg_terminate_backend($1)", [pid]);
      await waitFor(() => lines.length > 0, "pool 的 error log");
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        level: 40,
        msg: expect.stringContaining("閒置連線中斷"),
      });
      // pool 已把壞掉的連線移除，下一次查詢重新建立連線。
      const again = await handle.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      expect(again.rows[0]?.pid).not.toBe(pid);
      await handle.close();
    } finally {
      await admin.end();
      await scratch.drop();
    }
  });
});
