// Web UI origin 上的 Preview API（ARCHITECTURE §13）：
// - `GET runPreview`：Run 的 Preview 狀態與網址。
// - `POST runPreviewRestart`：重新啟動 Preview 的 dev server（`restart_preview`）。
// - `GET previewAuthorize`：換票。確認 session 與查看權限後，帶著一次性 ticket
//   轉到 Preview 網址的 callback。沒有登入時轉到登入頁。
// - `POST runPreviewScreenshots`：上傳 Preview 留言的截圖（multipart，欄位 `file`，PNG）。

import { createHash, randomUUID } from "node:crypto";
import { API_ROUTES, apiPath, PREVIEW_SCREENSHOT_MAX_BYTES } from "@orbis/api-contract";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { findSession } from "../auth/service";
import { requireProjectCapability } from "../authz/scope";
import { BLOB_RETENTION_MS, blobStorageKey } from "../blobs/store";
import { blobs } from "../db/schema";
import { inTransaction } from "../db/tx";
import { TERMINAL_RUN_STATUSES } from "../domain/run-status";
import { ApiError, conflict, readId } from "../http/errors";
import { type AppEnv, resolveActor } from "../http/session";
import { SESSION_COOKIE } from "../routes/auth";
import type { Services } from "../services";
import { canViewRunByInvite, requireRunVisible } from "./access";
import { PREVIEW_CALLBACK_PATH, previewShareUrl, safeReturnPath } from "./domain";
import { loadPreviewState } from "./state";

/** multipart 的邊界與欄位標頭的額外空間。 */
const MULTIPART_OVERHEAD = 64 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 寫入型的 Preview API 只接受 Web UI 自己發出的請求：沒有 body 或 multipart 的 POST 不需要 preflight，
 * 同站的 Preview 頁面（Agent 寫的程式）會帶著 session cookie 送來（B 軌之後會對所有寫入型 API 檢查 Origin）。
 */
function webOriginOnly(publicUrl: string): MiddlewareHandler<AppEnv> {
  const webOrigin = new URL(publicUrl).origin;
  return async (c, next) => {
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    if (
      (origin !== undefined && origin !== webOrigin) ||
      (site !== undefined && site !== "same-origin" && site !== "none")
    ) {
      throw new ApiError(403, "forbidden", "不接受其他網站發出的請求");
    }
    await next();
  };
}

export function createPreviewRoutes(s: Services): Hono<AppEnv> {
  const { db, auth, clock, preview, blobStore } = s;
  const app = new Hono<AppEnv>();
  const fromWeb = webOriginOnly(preview.publicUrl);

  app.get(API_ROUTES.runPreview, auth, async (c) => {
    const scope = await requireRunVisible(db, c.get("actor"), readId(c, "runId", "Run"));
    return c.json(await loadPreviewState(db, scope.run, preview.domain));
  });

  app.post(API_ROUTES.runPreviewRestart, fromWeb, auth, async (c) => {
    const actor = c.get("actor");
    const scope = await requireRunVisible(db, actor, readId(c, "runId", "Run"));
    // 和取消 Run 相同的權限
    requireProjectCapability(actor, scope, "edit_task");
    if (TERMINAL_RUN_STATUSES.includes(scope.run.status)) throw conflict("Run 已經結束");
    const state = await loadPreviewState(db, scope.run, preview.domain);
    if (state.status === "not_configured") throw conflict("這個 Repo 沒有設定 Preview");
    await inTransaction(db, (uow) =>
      s.runControls.send(uow.tx, scope.run.id, { action: "restart_preview" }, uow, actor.memberId),
    );
    return c.body(null, 202);
  });

  app.get(API_ROUTES.previewAuthorize, async (c) => {
    const runId = readId(c, "runId", "Run");
    const domain = preview.domain;
    if (!domain) throw new ApiError(404, "not_found", "Server 沒有設定 Preview 網域");
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await findSession(db, token, clock.now()) : null;
    if (!session) return c.redirect(`${preview.publicUrl}/login`, 302);
    // Team 中能查看這個 Run，或有有效的預覽邀請（受邀者可以不屬於任何 Team，ADR-0015）。
    let visible = false;
    try {
      await requireRunVisible(db, await resolveActor(db, clock, token), runId);
      visible = true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
    if (!visible && !(await canViewRunByInvite(db, clock, session.id, runId))) {
      throw new ApiError(404, "not_found", "找不到Run");
    }
    const callback = new URL(PREVIEW_CALLBACK_PATH, previewShareUrl(runId, domain));
    callback.searchParams.set("ticket", preview.auth.issueTicket(runId, session.id));
    callback.searchParams.set("return", safeReturnPath(c.req.query("return")));
    // ticket 在網址中：不要被快取，也不要以 Referer 帶到其他網站
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.redirect(callback.href, 302);
  });

  app.post(
    API_ROUTES.runPreviewScreenshots,
    fromWeb,
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
  const url = new URL(`${publicUrl}${apiPath(API_ROUTES.previewAuthorize, { runId })}`);
  url.searchParams.set("return", safeReturnPath(returnPath));
  return url.href;
}
