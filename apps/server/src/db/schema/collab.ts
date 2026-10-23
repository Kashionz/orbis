// 共同編輯文件的快照（ARCHITECTURE §12.1）。文件名稱的格式見 api-contract `collab.ts`。

import { sql } from "drizzle-orm";
import { check, customType, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { updatedAt } from "./columns";
import { repoSpecs } from "./project";
import { acceptanceCriteria, tasks } from "./task";

/** Postgres 的 bytea，TS 端為 Uint8Array。 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value),
});

/**
 * 一份 Yjs 文件的快照（`Y.encodeStateAsUpdate` 的結果）。所屬的 Task、Acceptance Criterion 或
 * Repo Spec 恰好一個，刪除時一併刪除文件。
 */
export const collabDocuments = pgTable(
  "collab_documents",
  {
    /** 文件名稱，例如 `task-description:<Task ID>`。 */
    name: text("name").primaryKey(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    acceptanceCriterionId: uuid("acceptance_criterion_id").references(() => acceptanceCriteria.id, {
      onDelete: "cascade",
    }),
    repoSpecId: uuid("repo_spec_id").references(() => repoSpecs.id, { onDelete: "cascade" }),
    state: bytea("state").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "collab_documents_single_owner",
      sql`num_nonnulls(${t.taskId}, ${t.acceptanceCriterionId}, ${t.repoSpecId}) = 1`,
    ),
  ],
);
