// Web UI origin 上的 Preview API（ARCHITECTURE §13）：
// - `GET /api/runs/:runId/preview`：Run 的 Preview 狀態與網址。
// - `GET /api/preview/:runId/authorize`：換票。確認 session 與查看權限後，帶著一次性 ticket
//   轉到 Preview 網址的 callback。沒有登入時轉到登入頁。

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { ApiError, readId } from "../http/errors";
import { type AppEnv, resolveActor } from "../http/session";
import { SESSION_COOKIE } from "../routes/auth";
import type { Services } from "../services";
import { requireRunVisible } from "./access";
import { PREVIEW_CALLBACK_PATH, previewShareUrl, safeReturnPath } from "./domain";
import { loadPreviewState, PREVIEW_AUTHORIZE_ROUTE, PREVIEW_STATE_ROUTE } from "./state";

export function createPreviewRoutes(s: Services): Hono<AppEnv> {
  const { db, auth, clock, preview } = s;
  const app = new Hono<AppEnv>();

  app.get(PREVIEW_STATE_ROUTE, auth, async (c) => {
    const scope = await requireRunVisible(db, c.get("actor"), readId(c, "runId", "Run"));
    return c.json(await loadPreviewState(db, scope.run, preview.domain));
  });

  app.get(PREVIEW_AUTHORIZE_ROUTE, async (c) => {
    const runId = readId(c, "runId", "Run");
    const domain = preview.domain;
    if (!domain) throw new ApiError(404, "not_found", "Server 沒有設定 Preview 網域");
    let actor: Awaited<ReturnType<typeof resolveActor>>;
    try {
      actor = await resolveActor(db, clock, getCookie(c, SESSION_COOKIE));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return c.redirect(`${preview.publicUrl}/login`, 302);
      }
      throw error;
    }
    await requireRunVisible(db, actor, runId);
    const callback = new URL(PREVIEW_CALLBACK_PATH, previewShareUrl(runId, domain));
    callback.searchParams.set("ticket", preview.auth.issueTicket(runId, actor.sessionId));
    callback.searchParams.set("return", safeReturnPath(c.req.query("return")));
    // ticket 在網址中：不要被快取，也不要以 Referer 帶到其他網站
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.redirect(callback.href, 302);
  });

  return app;
}

/** authorize 的網址（Preview 網址沒有 preview cookie 時，頁面導覽轉到這裡）。 */
export function previewAuthorizeUrl(publicUrl: string, runId: string, returnPath: string): string {
  const url = new URL(
    `${publicUrl}${PREVIEW_AUTHORIZE_ROUTE.replace(":runId", encodeURIComponent(runId))}`,
  );
  url.searchParams.set("return", safeReturnPath(returnPath));
  return url.href;
}
