// 共同編輯文件的快照儲存（ARCHITECTURE §12.1：快照存在 Postgres）。

import type { CollabDocRef } from "./doc-name";

export interface CollabStore {
  /** 讀取文件的快照（`Y.encodeStateAsUpdate` 的結果）；還沒有快照時回傳 null。 */
  load(ref: CollabDocRef): Promise<Uint8Array | null>;
  /** 以完整的快照取代舊的快照。 */
  save(ref: CollabDocRef, state: Uint8Array): Promise<void>;
}

/**
 * 存在記憶體的快照（測試用）。
 * TODO(contract): 契約 v2 的 collab 文件表合併後，Server 改用 Postgres 的實作。
 */
export class MemoryCollabStore implements CollabStore {
  readonly snapshots = new Map<string, Uint8Array>();

  async load(ref: CollabDocRef): Promise<Uint8Array | null> {
    return this.snapshots.get(ref.name) ?? null;
  }

  async save(ref: CollabDocRef, state: Uint8Array): Promise<void> {
    this.snapshots.set(ref.name, state);
  }
}
