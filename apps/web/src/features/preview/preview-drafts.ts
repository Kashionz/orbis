// Preview 留言的草稿（ARCHITECTURE §13）：在 Preview 分頁中寫好，Review Gate 退回時和 diff 行內留言一起送出。
// 存在 sessionStorage（key `preview-draft:<runId>`），重新整理頁面不會遺失；無法寫入時只存在記憶體中。
// 截圖在加入草稿時就上傳，草稿只存 blob ID。
//
// C 軌的 Review 頁面：以 loadPreviewDrafts() 列出草稿，退回時放進 GateDecisionInput.previewComments，
// 送出成功後呼叫 clearPreviewDrafts()。

import { z } from "zod";

// TODO(contract): 契約 v2 合併後改用 api-contract 的 PreviewCommentInput（#29）。
export const PreviewCommentDraft = z.object({
  body: z.string().trim().min(1),
  /** 留言時 Preview 的網址。 */
  url: z.string().min(1),
  /** 在 Desktop 中選取的元素；一般瀏覽器中是 null。 */
  selector: z.string().min(1).nullable(),
  screenshotBlobId: z.string().min(1).nullable(),
});
export type PreviewCommentDraft = z.infer<typeof PreviewCommentDraft>;

const Drafts = z.array(PreviewCommentDraft);

const storageKey = (runId: string) => `preview-draft:${runId}`;
/** sessionStorage 無法使用時的備援。 */
const memory = new Map<string, PreviewCommentDraft[]>();

export function loadPreviewDrafts(runId: string): PreviewCommentDraft[] {
  try {
    const raw = sessionStorage.getItem(storageKey(runId));
    if (raw === null) return memory.get(runId) ?? [];
    const parsed = Drafts.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return memory.get(runId) ?? [];
  }
}

export function savePreviewDrafts(runId: string, drafts: readonly PreviewCommentDraft[]): void {
  memory.set(runId, [...drafts]);
  try {
    if (drafts.length === 0) sessionStorage.removeItem(storageKey(runId));
    else sessionStorage.setItem(storageKey(runId), JSON.stringify(drafts));
  } catch {
    // 無法寫入時草稿只存在記憶體中
  }
}

export function clearPreviewDrafts(runId: string): void {
  savePreviewDrafts(runId, []);
}
