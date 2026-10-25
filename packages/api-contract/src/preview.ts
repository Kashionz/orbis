// Preview（ARCHITECTURE §13）：Run 的 dev server。Runner 在 setup 後就啟動，經由 Runner 通道分享給 Team；
// 分享網址是子網域式 `https://<run-id>.<Preview 網域>/`，第一次開啟時經由 `API_ROUTES.previewAuthorize`
// 換票取得 Preview 子網域的 cookie。

import { PREVIEW_STOP_REASONS } from "@orbis/protocol";
import { z } from "zod";
import { Id, Timestamp } from "./common";
import { PreviewInviteDuration, PreviewInviteStatus } from "./enums";

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

// 預覽邀請（後端缺口 `preview-share`，ADR-0015）：把 Preview 分享給 Team 以外、或特定的人。
// Team 設定 `allowExternalPreview` 打開後，對這個 Task 有操作權限（`edit_task`）的人可以邀請；
// 關閉時建立與列出都回 403 `preview_sharing_disabled`。受邀者只能看預覽頁面，不會因此加入 Team，
// 也看不到 Task。預覽停止或 Worktree 封存後，這個 Run 的邀請全部失效。

/**
 * `POST` runPreviewInvites：以 GitHub 帳號（Server 查出 user id 保存，登入時以 id 比對）或 email
 * （以登入者已驗證的 email 比對）指定一位受邀者。
 */
export const CreatePreviewInviteInput = z.union([
  z
    .object({
      githubLogin: z.string().trim().min(1).max(39),
      duration: PreviewInviteDuration.default("24h"),
    })
    .strict(),
  z
    .object({
      email: z.string().trim().toLowerCase().pipe(z.email()),
      duration: PreviewInviteDuration.default("24h"),
    })
    .strict(),
]);
export type CreatePreviewInviteInput = z.input<typeof CreatePreviewInviteInput>;

export const PreviewInvite = z
  .object({
    id: Id,
    runId: Id,
    /** 以 GitHub 帳號邀請時的 login（邀請時的快照）與 user id；以 email 邀請時為 null。 */
    githubLogin: z.string().min(1).nullable(),
    githubUserId: z.number().int().positive().nullable(),
    /** 以 email 邀請時的 email；以 GitHub 帳號邀請時為 null。 */
    email: z.email().nullable(),
    expiresAt: Timestamp,
    /** 邀請的人；被移除時為 null。 */
    createdByMemberId: Id.nullable(),
    createdAt: Timestamp,
    revokedAt: Timestamp.nullable(),
    /** 受邀者最後一次開啟預覽的時間；還沒開過時為 null。 */
    lastOpenedAt: Timestamp.nullable(),
    status: PreviewInviteStatus,
  })
  .refine((invite) => (invite.githubUserId === null) !== (invite.email === null), {
    error: "githubUserId 與 email 恰好一個有值",
    path: ["email"],
  });
export type PreviewInvite = z.infer<typeof PreviewInvite>;

/** `GET` runPreviewInvites 的回應：這個 Run 的所有邀請（含過期與撤銷），依建立時間排序（新的在前）。 */
export const PreviewInviteListResponse = z.array(PreviewInvite);
export type PreviewInviteListResponse = z.infer<typeof PreviewInviteListResponse>;

/**
 * `POST` runPreviewInvites 的回應（201）。`inviteUrl` 是 Orbis 主網址的 `/preview-invites/<token>`，每位受邀者
 * 各自一條，只在這裡出現一次（Server 只存 hash）；有設定 SMTP 時也寄信（`emailSent`）。
 *
 * 受邀者開啟 `GET` previewInviteAccept（瀏覽器導覽）：沒有登入時先以 GitHub 登入；Server 確認登入者是這個邀請的
 * 對象（GitHub user id 或已驗證的 email）、邀請有效，才發 ticket 並轉到預覽子網域（和 previewAuthorize 相同的
 * 換票流程）。不是受邀者時顯示 `invite_email_mismatch`。失敗時轉到 Web 的 `/invites/error?code=<代碼>`。
 */
export const PreviewInviteCreated = z.object({
  invite: PreviewInvite,
  inviteUrl: z.url(),
  emailSent: z.boolean(),
});
export type PreviewInviteCreated = z.infer<typeof PreviewInviteCreated>;
