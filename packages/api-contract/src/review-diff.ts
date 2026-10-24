// Review 用的完整 diff（ARCHITECTURE §10）：Runner 以協定的 `run_diff` Event 送上來，
// Server 保存最新的一份，Web 透過 REST 取得。
//
// 外層欄位是 REST 的 camelCase；檔案內容 `TextBody` 沿用協定的形狀（snake_case），Server 不轉換。

import { FILE_CHANGES, type FileChange, type TextBody as ProtocolTextBody } from "@orbis/protocol";
import { z } from "zod";
import { Id } from "./common";

export { FILE_CHANGES };

export const DiffFileChange = z.enum(FILE_CHANGES);
export type DiffFileChange = FileChange;

/** 協定的 `TextBody`：內嵌的文字，或 blob 參照。 */
export const TextBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), text: z.string() }),
  z.object({
    type: z.literal("blob"),
    blob_id: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    media_type: z.string().min(1),
  }),
]) satisfies z.ZodType<ProtocolTextBody>;
export type TextBody = ProtocolTextBody;

export const ReviewDiffFile = z.object({
  path: z.string().min(1),
  /** 改名前的路徑；沒有改名時為 null。 */
  oldPath: z.string().min(1).nullable(),
  change: DiffFileChange,
  /** 二進位檔案；為 true 時 old 與 new 都是 null。 */
  binary: z.boolean(),
  /** 修改前的內容；新增檔案時為 null。 */
  old: TextBody.nullable(),
  /** 修改後的內容；刪除檔案時為 null。 */
  new: TextBody.nullable(),
});
export type ReviewDiffFile = z.infer<typeof ReviewDiffFile>;

/**
 * Run 最新的一份完整 diff（base_commit 到 Worktree）。`seq` 是這份 diff 的 `run_diff` Event 的 seq。
 * 超過 90 天的 Run，放在 blob 的檔案內容已被清除，顯示為「已過期」（ARCHITECTURE §14）。
 */
export const ReviewDiff = z.object({
  runId: Id,
  seq: z.number().int().positive(),
  baseCommit: z.string().min(1),
  files: z.array(ReviewDiffFile),
  /**
   * 這份 diff 之前 Agent 最後的回覆（協定的 `final_message`）；沒有時為 null。diff 為空時，人在
   * Review Gate 上靠它判斷 Agent 是做完了不需要改檔，還是出了錯（例如模型錯誤被當成回覆）。
   */
  finalMessage: TextBody.nullable(),
});
export type ReviewDiff = z.infer<typeof ReviewDiff>;
