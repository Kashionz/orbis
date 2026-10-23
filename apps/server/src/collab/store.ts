// 共同編輯文件的快照儲存（ARCHITECTURE §12.1：快照存在 Postgres 的 collab_documents）。

import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { collabDocuments } from "../db/schema";
import type { CollabDocRef } from "./doc-name";

export interface CollabStore {
  /** 讀取文件的快照（`Y.encodeStateAsUpdate` 的結果）；還沒有快照時回傳 null。 */
  load(ref: CollabDocRef): Promise<Uint8Array | null>;
  /** 以完整的快照取代舊的快照。 */
  save(ref: CollabDocRef, state: Uint8Array): Promise<void>;
}

/** 存在 Postgres。所屬的 Task、Acceptance Criterion 或 Repo Spec 被刪除時快照一併刪除。 */
export class PostgresCollabStore implements CollabStore {
  constructor(private readonly db: Database) {}

  async load(ref: CollabDocRef): Promise<Uint8Array | null> {
    const [row] = await this.db
      .select({ state: collabDocuments.state })
      .from(collabDocuments)
      .where(eq(collabDocuments.name, ref.name));
    return row?.state ?? null;
  }

  async save(ref: CollabDocRef, state: Uint8Array): Promise<void> {
    const owner = {
      taskId: ref.kind === "task-description" ? ref.id : null,
      acceptanceCriterionId: ref.kind === "acceptance-criterion" ? ref.id : null,
      repoSpecId: ref.kind === "repo-spec-draft" ? ref.id : null,
    };
    await this.db
      .insert(collabDocuments)
      .values({ name: ref.name, ...owner, state })
      .onConflictDoUpdate({
        target: collabDocuments.name,
        set: { state, updatedAt: new Date() },
      });
  }
}

/** 存在記憶體（不需要資料庫的單元測試用）。 */
export class MemoryCollabStore implements CollabStore {
  readonly snapshots = new Map<string, Uint8Array>();

  async load(ref: CollabDocRef): Promise<Uint8Array | null> {
    return this.snapshots.get(ref.name) ?? null;
  }

  async save(ref: CollabDocRef, state: Uint8Array): Promise<void> {
    this.snapshots.set(ref.name, state);
  }
}
