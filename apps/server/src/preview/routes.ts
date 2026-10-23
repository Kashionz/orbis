// Web UI origin 上的 Preview API（ARCHITECTURE §13）：
// - `GET /api/runs/:runId/preview`：Run 的 Preview 狀態與網址。
// - `GET /api/preview/:runId/authorize`：換票。確認 session 與查看權限後，帶著一次性 ticket
//   轉到 Preview 網址的 callback。沒有登入時轉到登入頁。
// - `POST /api/runs/:runId/preview/screenshots`：上傳 Preview 留言的截圖（multipart，欄位 `file`，PNG）。

import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { requireProjectCapability } from "../authz/scope";
import { BLOB_RETENTION_MS, blobStorageKey } from "../blobs/store";
import { blobs } from "../db/schema";
import { ApiError, readId } from "../http/errors";
import { type AppEnv, resolveActor } from "../http/session";
import { SESSION_COOKIE } from "../routes/auth";
import type { Services } from "../services";
import { requireRunVisible } from "./access";
import { PREVIEW_CALLBACK_PATH, previewShareUrl, safeReturnPath } from "./domain";
import { loadPreviewState, PREVIEW_AUTHORIZE_ROUTE, PREVIEW_STATE_ROUTE } from "./state";

// TODO(contract): 契約 v2 合併後改用 API_ROUTES.runPreviewScreenshots 與 PREVIEW_SCREENSHOT_MAX_BYTES（#29）。
export const PREVIEW_SCREENSHOTS_ROUTE = "/api/runs/:runId/preview/screenshots";
export const PREVIEW_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
/** multipart 的邊界與欄位標頭的額外空間。 */
const MULTIPART_OVERHEAD = 64 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function createPreviewRoutes(s: Services): Hono<AppEnv> {
  const { db, auth, clock, preview, blobStore } = s;
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

  app.post(
    PREVIEW_SCREENSHOTS_ROUTE,
    auth,
    // 先確認權限，之後才讀 body
    async (c, next) => {
      const actor = c.get("actor");
      const scope = await requireRunVisible(db, actor, readId(c, "runId", "Run"));
      // 截圖是 Preview 留言的附件，和 Review Gate 退回的權限相同
      requireProjectCapability(actor, { ...scope, task: undefined }, "approve_gate");
      await next();
    },
    bodyLimit({
      maxSize: PREVIEW_SCREENSHOT_MAX_BYTES + MULTIPART_OVERHEAD,
      onError: (c) =>
        c.json(
          {
            error: "payload_too_large",
            message: `截圖不能超過 ${PREVIEW_SCREENSHOT_MAX_BYTES} bytes`,
          },
          413,
        ),
    }),
    async (c) => {
      const runId = readId(c, "runId", "Run");
      const form = await c.req.parseBody().catch(() => {
        throw new ApiError(400, "invalid_input", "必須是 multipart/form-data");
      });
      const file = form.file;
      if (!(file instanceof File)) {
        throw new ApiError(400, "invalid_input", "缺少截圖（欄位 file）");
      }
      if (file.size > PREVIEW_SCREENSHOT_MAX_BYTES) {
        throw new ApiError(
          413,
          "payload_too_large",
          `截圖不能超過 ${PREVIEW_SCREENSHOT_MAX_BYTES} bytes`,
        );
      }
      const data = new Uint8Array(await file.arrayBuffer());
      if (!PNG_SIGNATURE.every((byte, i) => data[i] === byte)) {
        throw new ApiError(400, "invalid_input", "截圖必須是 PNG");
      }
      const blobId = randomUUID();
      const sha256 = createHash("sha256").update(data).digest("hex");
      const key = blobStorageKey(blobId, sha256);
      await blobStore.put(key, data);
      const now = clock.now();
      await db.insert(blobs).values({
        id: blobId,
        sha256,
        size: data.byteLength,
        mediaType: "image/png",
        storageKey: key,
        runId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + BLOB_RETENTION_MS),
      });
      return c.json({ blobId }, 201);
    },
  );

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
