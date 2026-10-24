// 資料庫連線（src/db/client.ts）：close() 要等每條連線真的斷開，之後 drop database 才不會中斷還在關閉的連線。

import { sql } from "drizzle-orm";
import { describe, expect, inject, it } from "vitest";
import { createDatabase } from "../../src/db/client";
import { createScratchDatabase } from "../../src/db/test-database";
import { dbSkipReason } from "../helpers/db";

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
});
