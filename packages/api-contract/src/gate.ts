// Gate、Review Gate 的行內留言與決定（ARCHITECTURE §5、§10）。

import { z } from "zod";
import { Id, Timestamp } from "./common";
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
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ReviewComment = z.infer<typeof ReviewComment>;

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
  createdAt: Timestamp,
});
export type Gate = z.infer<typeof Gate>;

/**
 * 對 Gate 的決定（`POST` gate 的 decision）：
 * - `approve`：核准。Review Gate 核准後 Task 進入 PR Open。
 * - `reject`：退回，附上整體說明或行內留言（至少一項），打包成 prompt 送回 Agent。
 * - `abort`：中止 Run，Task 回到 Ready。
 */
export const GateDecisionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }).strict(),
  z
    .object({
      action: z.literal("reject"),
      comment: z.string().trim().min(1).nullable().default(null),
      reviewComments: z.array(ReviewCommentInput).default([]),
    })
    .strict()
    .refine((input) => input.comment !== null || input.reviewComments.length > 0, {
      error: "退回時至少要有一則說明或行內留言",
    }),
  z.object({ action: z.literal("abort") }).strict(),
]);
export type GateDecisionInput = z.input<typeof GateDecisionInput>;
