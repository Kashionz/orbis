// Preview（ARCHITECTURE §13）：Run 的 dev server。Runner 在 setup 後就啟動，經由 Runner 通道分享給 Team；
// 分享網址是子網域式 `https://<run-id>.<Preview 網域>/`，第一次開啟時經由 `API_ROUTES.previewAuthorize`
// 換票取得 Preview 子網域的 cookie。

import { PREVIEW_STOP_REASONS } from "@orbis/protocol";
import { z } from "zod";
import { Id } from "./common";

/** Preview 的狀態。 */
export const PREVIEW_STATUSES = ["not_configured", "starting", "ready", "stopped"] as const;
export const PreviewStatus = z.enum(PREVIEW_STATUSES);
export type PreviewStatus = z.infer<typeof PreviewStatus>;

/** `GET` runPreview 的回應。 */
export const PreviewState = z.object({
  /** Repo 設定檔沒有 `[preview]` 時為 `not_configured`。 */
  status: PreviewStatus,
  /** Runner 分配給這個 Worktree 的 port；還沒啟動時為 null。 */
  port: z.number().int().min(1).max(65_535).nullable(),
  /** Runner 本機的網址（只有同一台電腦上的 Desktop 能開）；還沒就緒時為 null。 */
  localUrl: z.url().nullable(),
  /** 分享給 Team 的網址；Server 沒有設定 Preview 網域，或還沒就緒時為 null。 */
  shareUrl: z.url().nullable(),
  /** 執行這個 Run 的 Runner；Desktop 據此判斷能不能直接開 `localUrl`。 */
  runnerId: Id.nullable(),
  /** 最近一次停止的原因（協定的 `preview_stopped`）；沒有停止過時為 null。 */
  stopped: z
    .object({
      reason: z.enum(PREVIEW_STOP_REASONS),
      exitCode: z.number().int().nullable(),
      /** 輸出的最後一段（已遮蔽 secret）。 */
      output: z.string(),
    })
    .nullable(),
});
export type PreviewState = z.infer<typeof PreviewState>;

/** 截圖的上限：10 MiB。 */
export const PREVIEW_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * `POST` runPreviewScreenshots 的回應。request 是 multipart，欄位 `file` 為 PNG，最大
 * `PREVIEW_SCREENSHOT_MAX_BYTES`；blob 掛在這個 Run 上，保存期限與其他 blob 相同。
 */
export const PreviewScreenshotUploaded = z.object({ blobId: Id });
export type PreviewScreenshotUploaded = z.infer<typeof PreviewScreenshotUploaded>;
