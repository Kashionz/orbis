// Verification（ARCHITECTURE §5.1）：Server 在主 Run 回合結束後送 `verify` 給 Runner，
// Runner 以 `verification_result` Event 回報每條條件的結果。這裡是給 Web 的保存結果。
//
// 外層欄位是 REST 的 camelCase；證據 `evidence` 原樣使用協定的 `VerificationEvidence`
// （snake_case、以 `type` 區分），Server 不轉換，與 `TextBody` 的作法相同。

import type { VerificationEvidence } from "@orbis/protocol";
import { z } from "zod";
import { Id, Timestamp } from "./common";
import { VerificationOutcome, VerificationResolution, VerificationStatus } from "./enums";

/** 協定的 `VerificationEvidence`。只檢查是帶有 `type` 的物件；各種類的欄位由協定保證。 */
export const VerificationEvidenceBody = z.custom<VerificationEvidence>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string",
  { error: "證據必須是帶有 type 的物件" },
);

/** 一條條件在某一輪的結果。 */
export const VerificationResultItem = z.object({
  criterionId: Id,
  outcome: VerificationOutcome,
  /** 給人看的摘要；失敗時也是送回 Agent 重試的原因。 */
  summary: z.string(),
  evidence: z.array(VerificationEvidenceBody),
  /** 判定這條條件的 `consult` Child Run；`command` 類型為 null。 */
  judgedByRunId: Id.nullable(),
  createdAt: Timestamp,
});
export type VerificationResultItem = z.infer<typeof VerificationResultItem>;

/** 一輪 Verification（DB 的 verifications 與 verification_results）。 */
export const Verification = z.object({
  id: Id,
  runId: Id,
  taskId: Id,
  /** 這個 Run 的第幾輪，從 1 開始；人選擇「附意見再試」後重新從 1 算。 */
  attempt: z.number().int().positive(),
  status: VerificationStatus,
  /** 超過重試上限後人的決定；還沒有決定，或不需要決定時為 null。 */
  resolution: VerificationResolution.nullable(),
  resolvedByMemberId: Id.nullable(),
  /** 「附意見再試」時附的意見。 */
  comment: z.string().nullable(),
  /** 已收到的結果，依 Task 中條件的順序；還在進行中時可能不完整。 */
  results: z.array(VerificationResultItem),
  startedAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export type Verification = z.infer<typeof Verification>;

/** `GET` runVerifications 的回應：這個 Run 的每一輪，依時間排序（舊的在前）。 */
export const VerificationListResponse = z.array(Verification);
export type VerificationListResponse = z.infer<typeof VerificationListResponse>;

/**
 * Verification 超過重試上限、Task 停在 Verifying 時人的決定（`POST` runVerificationDecision）：
 * - `retry`：附上意見再試一次，重試次數重新計算。
 * - `skip`：略過失敗，進入 Review Gate（Review 時看得到失敗的結果）。
 * - `abort`：中止 Run，Task 回到 Ready。
 */
export const VerificationDecisionInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("retry"),
      comment: z.string().trim().min(1).nullable().default(null),
    })
    .strict(),
  z.object({ action: z.literal("skip") }).strict(),
  z.object({ action: z.literal("abort") }).strict(),
]);
export type VerificationDecisionInput = z.input<typeof VerificationDecisionInput>;
