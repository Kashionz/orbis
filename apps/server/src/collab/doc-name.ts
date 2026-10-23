// 共同編輯文件的參照：契約的 `CollabDocumentRef` 加上完整的文件名稱（y-websocket 的 room 名稱）。
// 名稱的格式見 api-contract `collab.ts`；Server 另外要求 ID 是 UUID（資料庫的欄位型別）。

import {
  type CollabDocumentKind,
  type CollabDocumentRef,
  formatCollabDocName,
  parseCollabDocName,
} from "@orbis/api-contract";
import { z } from "zod";

export interface CollabDocRef extends CollabDocumentRef {
  /** 完整的文件名稱，例如 `task-description:<uuid>`。 */
  name: string;
}

const Uuid = z.uuid();

/** 解析文件名稱；格式不對或 ID 不是 UUID 時回傳 null。 */
export function parseCollabDocRef(name: string): CollabDocRef | null {
  const ref = parseCollabDocName(name);
  if (!ref || !Uuid.safeParse(ref.id).success) return null;
  return collabDocRef(ref.kind, ref.id);
}

/** 由種類與 ID 組出文件參照（ID 一律小寫，同一份文件只有一個名稱）。 */
export function collabDocRef(kind: CollabDocumentKind, id: string): CollabDocRef {
  const normalized = id.toLowerCase();
  return { kind, id: normalized, name: formatCollabDocName({ kind, id: normalized }) };
}
