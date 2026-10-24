// Gate、Review Gate 的行內留言、Preview 留言與決定（ARCHITECTURE §5、§10、§13）。

import { z } from "zod";
import { HttpUrl, Id, Timestamp } from "./common";
import { GateDecision, GateKind, ReviewCommentSide } from "./enums";

/** 新增一則行內留言（退回時一起送出）。 */
export const ReviewCommentInput = z
  .object({
    /** 相對於 Worktree 根目錄、以 `/` 分隔的路徑。 */
    path: z.string().min(1),
    /** 從 1 開始的行號。 */
    line: z.number().int().positive(),
    side: ReviewCommentSide,
    body: z.string().trim().min(1),
  })
  .strict();
export type ReviewCommentInput = z.infer<typeof ReviewCommentInput>;

/** 已保存的行內留言（DB 的 review_comments，每則一筆）。 */
export const ReviewComment = z.object({
  id: Id,
  gateId: Id,
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: ReviewCommentSide,
  body: z.string().min(1),
  /** 作者；Member 被移除後為 null。 */
  authorMemberId: Id.nullable(),
  /** 這則留言中的 @agent 建立的 `consult` Run。 */
  consultRunIds: z.array(Id),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ReviewComment = z.infer<typeof ReviewComment>;

/**
 * 新增一則在 Preview 上的留言（ARCHITECTURE §13）。Web 先存成草稿，Review Gate 退回時與行內留言
 * 一起送出、打包成同一個 prompt，截圖以圖片附上。
 */
export const PreviewCommentInput = z
  .object({
    body: z.string().trim().min(1),
    /** 留言時 Preview 的網址。Server 另外檢查是不是這個 Run 的 Preview。 */
    url: HttpUrl,
    /** 點選的元素的 CSS selector；瀏覽器版只能附整頁截圖，為 null。 */
    selector: z.string().min(1).nullable().default(null),
    /** 以 `POST` runPreviewScreenshots 上傳的截圖；沒有截圖時為 null。 */
    screenshotBlobId: Id.nullable().default(null),
  })
  .strict();
export type PreviewCommentInput = z.input<typeof PreviewCommentInput>;

/** 已保存的 Preview 留言（DB 的 review_comments 中 `kind = preview` 的列）。 */
export const PreviewComment = z.object({
  id: Id,
  gateId: Id,
  body: z.string().min(1),
  url: HttpUrl,
  selector: z.string().min(1).nullable(),
  screenshotBlobId: Id.nullable(),
  /** 作者；Member 被移除後為 null。 */
  authorMemberId: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PreviewComment = z.infer<typeof PreviewComment>;

export const Gate = z.object({
  id: Id,
  taskId: Id,
  /** 產生這個 Gate 的 Run。 */
  runId: Id.nullable(),
  kind: GateKind,
  /** null 表示還在等待。 */
  decision: GateDecision.nullable(),
  decidedByMemberId: Id.nullable(),
  decidedAt: Timestamp.nullable(),
  /** 退回時的整體說明。 */
  comment: z.string().nullable(),
  reviewComments: z.array(ReviewComment),
  previewComments: z.array(PreviewComment),
  /** Plan Gate 送審的 `plan_proposed` Event 的 seq；Review Gate 為 null。 */
  planSeq: z.number().int().positive().nullable(),
  /** Review Gate 送審的 `run_diff` Event 的 seq；Plan Gate 為 null。 */
  reviewDiffSeq: z.number().int().positive().nullable(),
  /**
   * Review Gate 以「結束（沒有變更）」結束：diff 為空，Task 轉 Done，不 push、不開 PR。
   * 這時 `decision` 為 `approved`。
   */
  finishedWithoutChanges: z.boolean(),
  createdAt: Timestamp,
});
export type Gate = z.infer<typeof Gate>;

/**
 * 對 Gate 的決定（`POST` gate 的 decision）：
 * - `approve`：核准。Review Gate 核准後 Task 進入 PR Open。
 * - `reject`：退回，附上整體說明、行內留言或 Preview 留言（至少一項），打包成 prompt 送回 Agent。
 *   Plan Gate 只接受整體說明，帶留言時 Server 回 422。
 * - `abort`：中止 Run，Task 回到 Ready。
 * - `finish_without_changes`：結束（沒有變更）。只用在 diff 為空的 Review Gate（這時不能 `approve`，
 *   因為沒有東西可以 push）：Task 轉 Done（關閉原因 `completed`），不 push、不開 PR，Run 結束。
 *   權限與 manual 條件的要求都和核准相同。
 */
export const GateDecisionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }).strict(),
  z
    .object({
      action: z.literal("reject"),
      comment: z.string().trim().min(1).nullable().default(null),
      reviewComments: z.array(ReviewCommentInput).default([]),
      previewComments: z.array(PreviewCommentInput).default([]),
    })
    .strict()
    .refine(
      (input) =>
        input.comment !== null ||
        input.reviewComments.length > 0 ||
        input.previewComments.length > 0,
      { error: "退回時至少要有一則說明、行內留言或 Preview 留言" },
    ),
  z.object({ action: z.literal("abort") }).strict(),
  z.object({ action: z.literal("finish_without_changes") }).strict(),
]);
export type GateDecisionInput = z.input<typeof GateDecisionInput>;
