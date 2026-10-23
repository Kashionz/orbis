// 即時共同編輯（ARCHITECTURE §12.1）：Yjs over y-websocket，路徑是 `API_ROUTES.collab`。
//
// - 文件內容是 TipTap 的 `Y.XmlFragment`（欄位名稱 `COLLAB_FRAGMENT`）。Server 存檔時把它轉成 markdown，
//   回寫 Task 描述或 Acceptance Criterion 的描述；Repo Spec 草稿只存快照，提交時才轉成 markdown。
// - Server 與 Web 只使用下面列出的節點與 mark，轉換時遇到其他種類一律當成純文字。
// - 權限沿用 Role：能查看 Task 的人可以連線（唯讀），能編輯 Task 的人才能寫入。

/** 共同編輯文件的種類。 */
export const COLLAB_DOCUMENT_KINDS = [
  "task-description",
  "acceptance-criterion",
  "repo-spec-draft",
] as const;
export type CollabDocumentKind = (typeof COLLAB_DOCUMENT_KINDS)[number];

/** 文件名稱：`<種類>:<ID>`，例如 `task-description:0195f0a0-…`。 */
export interface CollabDocumentRef {
  kind: CollabDocumentKind;
  /** Task ID、Acceptance Criterion ID，或 Repo Spec ID。 */
  id: string;
}

export function formatCollabDocName(ref: CollabDocumentRef): string {
  if (!ref.id || /[:/\s]/.test(ref.id)) throw new Error(`不合法的文件 ID：${ref.id}`);
  return `${ref.kind}:${ref.id}`;
}

/** 解析文件名稱；格式不對時回傳 null。 */
export function parseCollabDocName(name: string): CollabDocumentRef | null {
  const index = name.indexOf(":");
  if (index < 0) return null;
  const kind = name.slice(0, index);
  const id = name.slice(index + 1);
  if (!(COLLAB_DOCUMENT_KINDS as readonly string[]).includes(kind)) return null;
  if (!id || /[:/\s]/.test(id)) return null;
  return { kind: kind as CollabDocumentKind, id };
}

/** `Y.Doc` 中存放內容的 XmlFragment 名稱（TipTap Collaboration 的 `field`）。 */
export const COLLAB_FRAGMENT = "default";

/** 允許的節點（TipTap StarterKit 加上 mention）。 */
export const COLLAB_NODE_TYPES = [
  "doc",
  "paragraph",
  "text",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "horizontalRule",
  "hardBreak",
  "mention",
] as const;
export type CollabNodeType = (typeof COLLAB_NODE_TYPES)[number];

/** 允許的 mark（TipTap StarterKit）。 */
export const COLLAB_MARK_TYPES = ["bold", "italic", "strike", "code", "link", "underline"] as const;
export type CollabMarkType = (typeof COLLAB_MARK_TYPES)[number];

/**
 * mention 節點的屬性。`id` 是 `member:<Member ID>` 或 `agent:<Agent Profile id>`
 * （同 mention.ts 的 `formatMentionTargetId`）；`nodeId` 由 Web 在插入時產生（UUID），
 * Server 以它去除重複，存檔時只對新出現的 mention 發通知或建立 Run。
 */
export interface CollabMentionAttrs {
  id: string;
  label: string;
  nodeId: string;
}
