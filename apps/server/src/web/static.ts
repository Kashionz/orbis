// 提供 Web 的靜態檔（`vite build` 的輸出），正式部署時 Web 與 API 在同一個 origin（ARCHITECTURE §16）。
//
// - 目錄中存在的檔案照常回應。Vite 的 `assets/` 檔名帶 hash，可以長期快取；其他檔案（含 index.html）不快取，
//   升級後瀏覽器才會拿到新的 index.html。
// - 其他路徑回 index.html，交給 Web 的 router（例如 `/tasks/ORB-12`）。`/api` 底下的路徑不在這裡處理，
//   由 API 路由決定，沒有對應的路徑回 404。
// - 路徑含 `..` 或 `\` 時 serveStatic 自己會拒絕，不會跳出目錄。

import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

/** `/api` 底下的路徑不交給 Web。 */
const API_PREFIX = "/api/";

/** Vite 輸出中帶 hash 的檔案目錄。 */
const HASHED_ASSETS_PREFIX = "/assets/";

export function createWebStatic(webDir: string): Hono {
  const root = path.resolve(webDir);
  const indexFile = path.join(root, "index.html");
  if (!existsSync(indexFile)) {
    throw new Error(`Web 的靜態檔目錄 ${root} 中沒有 index.html，請先執行 vite build`);
  }
  const app = new Hono();
  // serveStatic 的 onFound 在回應建好之後才呼叫，那時再加 header 已經來不及，所以先在這裡決定快取方式。
  app.use("*", async (c, next) => {
    c.header(
      "Cache-Control",
      c.req.path.startsWith(HASHED_ASSETS_PREFIX)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    await next();
  });
  app.use("*", serveStatic({ root }));
  app.get("*", (c) => {
    if (c.req.path.startsWith(API_PREFIX) || c.req.path === API_PREFIX.slice(0, -1)) {
      return c.notFound();
    }
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(Readable.toWeb(createReadStream(indexFile)) as ReadableStream);
  });
  return app;
}
