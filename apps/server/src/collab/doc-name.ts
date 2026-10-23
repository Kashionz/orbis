// 共同編輯文件的名稱（ARCHITECTURE §12.1）：`<種類>:<id>`，也是 y-websocket 的 room 名稱。
//
// - `task-description:<taskId>`：Task 描述（小 Task 的 Spec）。
// - `acceptance-criterion:<criterionId>`：一條 Acceptance Criterion 的描述。
// - `repo-spec-draft:<repoSpecId>`：Repo Spec 的草稿（「提交到 repo」由 D 軌實作）。

import { z } from "zod";

// TODO(contract): 文件名稱的組法與種類改用 packages/api-contract 的定義（ORB-3 契約 v2）。
export const COLLAB_DOC_KINDS = [
  "task-description",
  "acceptance-criterion",
  "repo-spec-draft",
] as const;
export type CollabDocKind = (typeof COLLAB_DOC_KINDS)[number];

export interface CollabDocRef {
  /** 完整的文件名稱，例如 `task-description:<uuid>`。 */
  name: string;
  kind: CollabDocKind;
  /** 文件所屬資源的 id（Task、Acceptance Criterion 或 RepoSpec）。 */
  id: string;
}

const Uuid = z.uuid();

/** 解析文件名稱；格式不對時回傳 null。 */
export function parseCollabDocName(name: string): CollabDocRef | null {
  const separator = name.indexOf(":");
  if (separator < 0) return null;
  const kind = name.slice(0, separator);
  const id = name.slice(separator + 1).toLowerCase();
  if (!(COLLAB_DOC_KINDS as readonly string[]).includes(kind)) return null;
  if (!Uuid.safeParse(id).success) return null;
  return { name: `${kind}:${id}`, kind: kind as CollabDocKind, id };
}

export function collabDocName(kind: CollabDocKind, id: string): string {
  return `${kind}:${id}`;
}
