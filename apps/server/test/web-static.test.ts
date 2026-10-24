// Server 提供 Web 的靜態檔（ORBIS_WEB_DIR，ARCHITECTURE §16）：檔案照常回應、其他路徑回 index.html、
// `/api` 底下沒有對應的路徑仍是 404、不能跳出目錄。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API_ROUTES } from "@orbis/api-contract";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createWebStatic } from "../src/web/static";
import { createTestContext, unusedGitHubOAuth } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";

const INDEX_HTML = "<!doctype html><title>Web</title><div id=root></div>";
const APP_JS = "console.log('app');";

function writeWebDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "orbis-web-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), INDEX_HTML);
  writeFileSync(path.join(dir, "assets", "app-abc123.js"), APP_JS);
  // 目錄外的檔案（放在上一層），不可以被讀到。
  writeFileSync(path.join(dir, "..", "orbis-web-outside.txt"), "外面的檔案");
  return dir;
}

describe.skipIf(dbSkipReason !== null)("Web 的靜態檔", () => {
  let database: TestDatabase;
  let webDir: string;
  let app: Hono;

  beforeAll(async () => {
    database = await createTestDatabase();
    webDir = writeWebDir();
    const ctx = createTestContext(database.db);
    app = createApp({
      config: {
        publicUrl: "http://localhost:5173",
        apiOrigin: "http://localhost:4000",
        bootstrapOwnerGithubUserId: null,
        webDir,
      },
      db: database.db,
      logger: ctx.logger,
      githubOAuth: unusedGitHubOAuth,
      services: ctx.services,
    });
  });

  afterAll(async () => {
    rmSync(path.join(webDir, "..", "orbis-web-outside.txt"), { force: true });
    rmSync(webDir, { recursive: true, force: true });
    await database?.drop();
  });

  it("目錄中的檔案照常回應：index.html 不快取、assets 帶 hash 可以長期快取", async () => {
    const index = await app.request("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await index.text()).toBe(INDEX_HTML);

    const asset = await app.request("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toBe(APP_JS);
  });

  it("其他路徑回 index.html，交給 Web 的 router", async () => {
    for (const route of ["/tasks/ORB-12", "/admin", "/projects/x/settings?tab=repos"]) {
      const res = await app.request(route);
      expect(res.status, route).toBe(200);
      expect(await res.text(), route).toBe(INDEX_HTML);
    }
  });

  it("`/api` 底下沒有對應的路徑仍是 404，API 照常運作", async () => {
    expect((await app.request("/api/no-such-route")).status).toBe(404);
    expect((await app.request("/api")).status).toBe(404);
    const health = await app.request(API_ROUTES.health);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  });

  it("只提供目錄中的檔案；寫入類的方法不交給靜態檔", async () => {
    // URL 解析會先把 `..` 與 `%2e%2e` 正規化掉，所以這些請求實際上都是 /orbis-web-outside.txt：
    // 目錄中沒有這個檔案，回 index.html，不會讀到上一層的檔案。
    for (const route of [
      "/orbis-web-outside.txt",
      "/assets/../orbis-web-outside.txt",
      "/assets/%2e%2e/orbis-web-outside.txt",
    ]) {
      const res = await app.request(route);
      expect(res.status, route).toBe(200);
      expect(await res.text(), route).toBe(INDEX_HTML);
    }
    expect((await app.request("/", { method: "POST" })).status).toBe(404);
  });

  it("目錄中沒有 index.html 時啟動就失敗", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "orbis-web-empty-"));
    try {
      expect(() => createWebStatic(empty)).toThrow("index.html");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
