// Diff review 的留言草稿：存在 sessionStorage，重新整理頁面不會遺失。

import { ReviewCommentInput } from "@orbis/api-contract";
import { z } from "zod";

export const ReviewDraft = z.object({
  comments: z.array(ReviewCommentInput),
  /** 整體說明。 */
  summary: z.string(),
});
export type ReviewDraft = z.infer<typeof ReviewDraft>;

export const EMPTY_DRAFT: ReviewDraft = { comments: [], summary: "" };

const storageKey = (runId: string) => `review-draft:${runId}`;

export function loadDraft(runId: string): ReviewDraft {
  try {
    const raw = sessionStorage.getItem(storageKey(runId));
    if (!raw) return EMPTY_DRAFT;
    const parsed = ReviewDraft.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveDraft(runId: string, draft: ReviewDraft): void {
  try {
    if (draft.comments.length === 0 && draft.summary === "") {
      sessionStorage.removeItem(storageKey(runId));
    } else {
      sessionStorage.setItem(storageKey(runId), JSON.stringify(draft));
    }
  } catch {
    // 無法寫入時草稿只存在記憶體中
  }
}

/** 依檔案、行號排序留言，退回時送出的順序固定。 */
export function sortComments(comments: readonly ReviewCommentInput[]): ReviewCommentInput[] {
  return [...comments].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.side.localeCompare(b.side),
  );
}
