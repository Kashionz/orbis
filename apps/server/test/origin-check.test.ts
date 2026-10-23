// 寫入型 API 的 Origin 檢查：Preview 子網域（same-site）送來帶 session cookie 的寫入請求要被擋下。

import { API_ROUTES } from "@orbis/api-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, seedTeam, type TestContext } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

describe.skipIf(dbSkipReason !== null)("寫入型 API 的 Origin 檢查", () => {
  let database: TestDatabase;
  let ctx: TestContext;
  let cookie: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    ctx = createTestContext(database.db);
    cookie = (await seedTeam(database.db)).members.owner.cookie;
  });

  afterAll(async () => {
    await database?.drop();
  });

  const createProject = (headers: Record<string, string>, prefix: string) =>
    ctx.app.request(API_ROUTES.projects, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name: prefix, keyPrefix: prefix }),
    });

  it("Web 的 origin 與 Server 的 origin 可以寫入", async () => {
    expect((await createProject({ cookie, origin: "http://localhost:5173" }, "WEB")).status).toBe(
      201,
    );
    expect((await createProject({ cookie, origin: "http://localhost:4000" }, "API")).status).toBe(
      201,
    );
  });

  it("沒有 Origin 的請求（非瀏覽器）照常處理", async () => {
    expect((await createProject({ cookie }, "CLI")).status).toBe(201);
  });

  it("Preview 子網域、其他網站與 null 的 Origin 一律 403", async () => {
    for (const origin of ["http://3f2a.preview.localhost:5173", "https://evil.example", "null"]) {
      const res = await createProject({ cookie, origin }, "BAD");
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    }
  });

  it("讀取不檢查 Origin；沒有 session cookie 的請求不受影響", async () => {
    const read = await ctx.app.request(API_ROUTES.projects, {
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(read.status).toBe(200);
    const anonymous = await createProject({ origin: "https://evil.example" }, "ANON");
    expect(anonymous.status).toBe(401);
  });
});
