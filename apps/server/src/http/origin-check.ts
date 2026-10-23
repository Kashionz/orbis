// 寫入型 API 的 Origin 檢查（CSRF 防護）。
//
// Preview 採子網域式網址（`<run-id>.preview.<domain>`），和 Web 是 same-site，Agent 寫的 Preview 頁面
// 對 Orbis API 送出的請求會帶上 SameSite=Lax 的 session cookie。所以帶 session cookie 的寫入請求
// （GET、HEAD、OPTIONS 以外），只要有 Origin header，就必須是 Web 的 origin 或 Server 自己的 origin。
// - 瀏覽器的 fetch／表單送出寫入請求時一律帶 Origin（含 `null`），所以跨 origin 的請求都會被擋下。
// - 沒有 Origin 的請求（測試、非瀏覽器的工具）照常處理；沒有 session cookie 的請求
//   （GitHub webhook、Runner 以 Runner token 上傳 blob）不受影響。

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../routes/auth";
import { forbidden } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 只允許 allowedOrigins（完整網址或 origin 皆可）送出帶 session cookie 的寫入請求。 */
export function requireTrustedOrigin(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins.map((value) => new URL(value).origin));
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && getCookie(c, SESSION_COOKIE) !== undefined) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !allowed.has(origin)) {
        throw forbidden("請求的來源不是 Web 的 origin");
      }
    }
    await next();
  };
}
