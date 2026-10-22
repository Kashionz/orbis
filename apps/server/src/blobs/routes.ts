// blob 的上傳（Runner，Runner token 認證）與下載（Web，session 認證）。
//
// 上傳：`PUT <RUNNER_BLOB_PATH>/:blobId?runId=<Run>&sha256=<hex>`，body 是內容本身，
// `Content-Type` 是 media type。Server 計算 sha256 與大小並和 BlobRef 比對。blob_id 由 Runner 產生；
// 同一個 blob_id 重送相同內容視為成功（可以安全地重試），內容不同回 409。
// Runner 只能把 blob 掛在自己正在執行的 Run 上。
//
// TODO(contract)：上傳路徑、查詢參數與認證方式隨 contract/protocol 定案。

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { loadRunScope, requireProjectCapability } from "../authz/scope";
import { RUNNER_BLOB_PATH } from "../contract-pending";
import { blobs, dispatches } from "../db/schema";
import { ApiError, conflict, notFound, readId, readQuery } from "../http/errors";
import type { AppEnv } from "../http/session";
import { findRunnerByToken } from "../runner/service";
import type { Services } from "../services";
import { BLOB_RETENTION_MS, type BlobStore, blobStorageKey } from "./store";

/** 單一 blob 的大小上限。 */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;

const UploadQuery = z.object({
  runId: z.uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: "sha256 必須是 64 個小寫十六進位字元" }),
});

const MediaType = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/, { error: "不是合法的 media type" });

interface UploadEnv {
  Variables: { upload: { blobId: string; runId: string; sha256: string; mediaType: string } };
}

/** 瀏覽器可以直接顯示的圖片；其他內容一律以附件下載，避免在 Server 的 origin 上執行。 */
const INLINE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function createBlobRoutes(
  s: Services & { blobStore: BlobStore },
  options: { maxBytes?: number } = {},
): {
  runner: Hono<UploadEnv>;
  web: Hono<AppEnv>;
} {
  const { db, auth, blobStore } = s;
  const maxBytes = options.maxBytes ?? MAX_BLOB_BYTES;

  const runner = new Hono<UploadEnv>();
  runner.put(
    `${RUNNER_BLOB_PATH}/:blobId`,
    // 先認證、確認 Runner 正在執行這個 Run，之後才開始讀 body，未認證的請求不會消耗記憶體。
    async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
      const caller = token ? await findRunnerByToken(db, token) : null;
      if (!caller) throw new ApiError(401, "unauthorized", "Runner token 不正確或已被撤銷");

      const blobId = readId(c, "blobId", "blob");
      const query = readQuery(c, UploadQuery);
      const mediaType = MediaType.safeParse(c.req.header("content-type") ?? "");
      if (!mediaType.success) {
        throw new ApiError(400, "invalid_input", "缺少或不合法的 Content-Type");
      }

      // Runner 只能把 blob 掛在自己正在（或剛）執行的 Run 上。
      const [dispatch] = await db
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(
          and(
            eq(dispatches.runId, query.runId),
            eq(dispatches.runnerId, caller.id),
            inArray(dispatches.status, ["accepted", "completed"]),
          ),
        )
        .limit(1);
      if (!dispatch) throw new ApiError(403, "forbidden", "這台 Runner 沒有在執行這個 Run");
      c.set("upload", { blobId, ...query, mediaType: mediaType.data });
      await next();
    },
    // 讀取 body 時就計算大小，超過上限立刻中止。
    bodyLimit({
      maxSize: maxBytes,
      onError: (c) =>
        c.json({ error: "payload_too_large", message: `blob 不能超過 ${maxBytes} bytes` }, 413),
    }),
    async (c) => {
      const { blobId, runId, mediaType, sha256: declared } = c.get("upload");
      const data = new Uint8Array(await c.req.arrayBuffer());
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (sha256 !== declared) {
        throw new ApiError(422, "invalid_input", "內容的 sha256 與宣告的不符");
      }

      // 先保留 blob_id 再寫入內容：同一個 blob_id 並行上傳不同內容時，只有一個會成功。
      // 儲存位置也帶上 sha256，不同內容不會寫到同一個檔案。
      const key = blobStorageKey(blobId, sha256);
      const now = s.clock.now();
      const [reserved] = await db
        .insert(blobs)
        .values({
          id: blobId,
          sha256,
          size: data.byteLength,
          mediaType,
          storageKey: key,
          runId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + BLOB_RETENTION_MS),
        })
        .onConflictDoNothing()
        .returning({ id: blobs.id });
      if (!reserved) {
        const [existing] = await db.select().from(blobs).where(eq(blobs.id, blobId));
        if (!existing || existing.sha256 !== sha256 || existing.runId !== runId) {
          throw conflict("這個 blob_id 已經用在不同的內容");
        }
        // 重送相同內容：補寫一次內容（前一次可能寫入失敗），可以安全地重試。
        await blobStore.put(existing.storageKey, data);
        return c.json({ blobId, sha256, size: existing.size }, 200);
      }
      try {
        await blobStore.put(key, data);
      } catch (error) {
        await db.delete(blobs).where(eq(blobs.id, blobId));
        throw error;
      }
      return c.json({ blobId, sha256, size: data.byteLength }, 201);
    },
  );

  const web = new Hono<AppEnv>();
  web.get("/blobs/:blobId", auth, async (c) => {
    const actor = c.get("actor");
    const blobId = readId(c, "blobId", "blob");
    const [blob] = await db.select().from(blobs).where(eq(blobs.id, blobId));
    if (!blob?.runId) throw notFound("blob");
    const scope = await loadRunScope(db, actor, blob.runId);
    requireProjectCapability(actor, scope, "view");
    if (blob.expiresAt.getTime() <= s.clock.now().getTime()) {
      throw new ApiError(410, "gone", "blob 已超過保存期限");
    }
    const data = await blobStore.get(blob.storageKey);
    if (!data) throw new ApiError(410, "gone", "blob 已超過保存期限");
    const essence = blob.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
    const inline = INLINE_MEDIA_TYPES.has(essence);
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      "content-type": inline ? essence : "application/octet-stream",
      "content-disposition": inline ? "inline" : `attachment; filename="${blob.id}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=86400, immutable",
      // 原本的 media type（例如 text/plain; charset=utf-8），Web 依此決定如何顯示。
      "x-blob-media-type": blob.mediaType,
    });
  });

  return { runner, web };
}
