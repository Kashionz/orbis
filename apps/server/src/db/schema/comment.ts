// Task 留言、Task note、@mention（ARCHITECTURE §9、§12.3）。

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns";
import { mentionSourceEnum, taskNoteSourceEnum } from "./enums";
import { runs } from "./run";
import { tasks } from "./task";
import { members } from "./team";

/**
 * Task 留言。作者是 Member，或 Agent（@agent 的 consult Run 結束後把最後的回覆貼回來，author_run_id）。
 * 內文是 markdown，@mention 用 api-contract `mention.ts` 的明確寫法。
 */
export const taskComments = pgTable(
  "task_comments",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorMemberId: uuid("author_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    authorRunId: uuid("author_run_id").references(() => runs.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("task_comments_task_id_idx").on(t.taskId, t.createdAt),
    // 作者被刪除後兩者都可能是 null，所以只檢查不會同時有值。
    check(
      "task_comments_single_author",
      sql`${t.authorMemberId} IS NULL OR ${t.authorRunId} IS NULL`,
    ),
  ],
);

/**
 * Task note：Agent 以 `update_task_note` 留下的進度或決策紀錄，或 Feedback Loop 每次自動修正的紀錄
 * （連到修正用的 Run 與 PR 上的紀錄留言）。只有系統寫入。
 */
export const taskNotes = pgTable(
  "task_notes",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    source: taskNoteSourceEnum("source").notNull(),
    body: text("body").notNull(),
    /** 相關的連結，例如 PR 上的紀錄留言。 */
    url: text("url"),
    createdAt: createdAt(),
  },
  (t) => [index("task_notes_task_id_idx").on(t.taskId, t.createdAt)],
);

/**
 * 一次 @mention。被提及的是 Member（member_id）或 Agent（agent，Agent Profile 的 id）其中之一；
 * @agent 建立的 consult Run 記在 consult_run_id。
 * 以 (source_kind, source_id, node_id) 去除重複：留言修改或共同編輯文件存檔時，只有新出現的 mention
 * 才會通知或建立 Run。node_id 在留言中是 token 的序號，在共同編輯文件中是 mention 節點的 `nodeId`。
 */
export const mentions = pgTable(
  "mentions",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sourceKind: mentionSourceEnum("source_kind").notNull(),
    /** task_comments.id、review_comments.id，或 collab_documents.name。 */
    sourceId: text("source_id").notNull(),
    nodeId: text("node_id").notNull(),
    memberId: uuid("member_id").references(() => members.id, { onDelete: "cascade" }),
    agent: text("agent"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    consultRunId: uuid("consult_run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("mentions_source_node_unique").on(t.sourceKind, t.sourceId, t.nodeId),
    index("mentions_task_id_idx").on(t.taskId),
    index("mentions_member_id_idx").on(t.memberId),
    check("mentions_single_target", sql`(${t.memberId} IS NULL) <> (${t.agent} IS NULL)`),
  ],
);
