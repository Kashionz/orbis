// Gate 與 Needs You（ARCHITECTURE §5、§8、§10）。

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import { childQuestions } from "./delegation";
import {
  gateDecisionEnum,
  gateKindEnum,
  needsYouKindEnum,
  reviewCommentKindEnum,
  reviewCommentSideEnum,
} from "./enums";
import { projects } from "./project";
import { blobs, runs } from "./run";
import { tasks } from "./task";
import { members } from "./team";

/**
 * Gate：Task 生命週期中需要人核准的關卡（Plan Gate、Review Gate）。
 * 每次進入 Gate 新增一筆；decision 為 null 表示還在等待。退回後再次進入會是新的一筆。
 */
export const gates = pgTable(
  "gates",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** 產生這個 Gate 的 Run。 */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    kind: gateKindEnum("kind").notNull(),
    /** 送審的內容（plan 文字、diff 的 blob 參照等），格式保留彈性。 */
    subject: jsonb("subject"),
    /**
     * Gate 建立時 Task 的指派對象。「不能核准自己的 Task」同時比對目前的與這個指派對象，
     * 避免 Gate 等待期間改指派後核准自己做的 Task（ARCHITECTURE §10）。
     */
    assigneeMemberIdAtCreation: uuid("assignee_member_id_at_creation").references(
      () => members.id,
      { onDelete: "set null" },
    ),
    decision: gateDecisionEnum("decision"),
    decidedByMemberId: uuid("decided_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamptz("decided_at"),
    /** 退回時的整體說明；行內留言存在 review_comments。 */
    comment: text("comment"),
    createdAt: createdAt(),
  },
  (t) => [
    index("gates_task_id_idx").on(t.taskId),
    check("gates_decision_complete", sql`(${t.decision} IS NULL) = (${t.decidedAt} IS NULL)`),
  ],
);

/**
 * Review Gate 的留言，每則一筆（ARCHITECTURE §10、§13）。退回時打包成 prompt 送回 Agent；
 * @mention 與通知也以這張表為準。
 * - `diff`：diff 行內留言，path、line、side 必填。
 * - `preview`：在 Preview 上點選元素的留言，url 必填，selector 與截圖可以沒有。
 */
export const reviewComments = pgTable(
  "review_comments",
  {
    id: id(),
    gateId: uuid("gate_id")
      .notNull()
      .references(() => gates.id, { onDelete: "cascade" }),
    kind: reviewCommentKindEnum("kind").notNull().default("diff"),
    /** 相對於 Worktree 根目錄、以 `/` 分隔的路徑（`diff`）。 */
    path: text("path"),
    /** 從 1 開始的行號（`diff`）。 */
    line: integer("line"),
    side: reviewCommentSideEnum("side"),
    /** 留言時 Preview 的網址（`preview`）。 */
    url: text("url"),
    /** 點選的元素的 CSS selector（`preview`）；整頁截圖時為 null。 */
    selector: text("selector"),
    /** Preview 留言的截圖（`preview`）。 */
    screenshotBlobId: uuid("screenshot_blob_id").references(() => blobs.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    authorMemberId: uuid("author_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("review_comments_gate_id_idx").on(t.gateId),
    check("review_comments_line_positive", sql`${t.line} >= 1`),
    check(
      "review_comments_kind_fields",
      sql`(${t.kind} = 'diff' AND ${t.path} IS NOT NULL AND ${t.line} IS NOT NULL AND ${t.side} IS NOT NULL AND ${t.url} IS NULL AND ${t.selector} IS NULL AND ${t.screenshotBlobId} IS NULL)
        OR (${t.kind} = 'preview' AND ${t.url} IS NOT NULL AND ${t.path} IS NULL AND ${t.line} IS NULL AND ${t.side} IS NULL)`,
    ),
  ],
);

/**
 * Needs You 項目：等待某位 Member 處理的事情（權限請求、待核准的 Gate、停下來的 Run、
 * Child Run 等待人回答的問題）。
 * member_id 為 null 表示 Project 中任何有權限的 Member 都可以處理。
 * resolved_at 為 null 表示還沒處理。
 */
export const needsYouItems = pgTable(
  "needs_you_items",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").references(() => members.id, { onDelete: "cascade" }),
    kind: needsYouKindEnum("kind").notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    gateId: uuid("gate_id").references(() => gates.id, { onDelete: "cascade" }),
    /** `child_question` 的問題；runId 是父 Run。 */
    childQuestionId: uuid("child_question_id").references(() => childQuestions.id, {
      onDelete: "cascade",
    }),
    /** 項目的內容，例如權限請求的 tool call 與選項；格式保留彈性。 */
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    resolvedAt: timestamptz("resolved_at"),
    resolvedByMemberId: uuid("resolved_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /** 處理的結果，例如權限請求選了哪個選項。 */
    resolution: jsonb("resolution"),
    createdAt: createdAt(),
  },
  (t) => [
    index("needs_you_items_member_id_open_idx").on(t.memberId).where(sql`${t.resolvedAt} IS NULL`),
    index("needs_you_items_project_id_open_idx")
      .on(t.projectId)
      .where(sql`${t.resolvedAt} IS NULL`),
    check("needs_you_items_gate_has_gate_id", sql`${t.kind} <> 'gate' OR ${t.gateId} IS NOT NULL`),
    check(
      "needs_you_items_child_question_has_id",
      // 轉成 text 再比較：`child_question` 是同一個 migration 中 ALTER TYPE 新增的值，
      // Postgres 不允許在同一個 transaction 中直接使用。
      sql`${t.kind}::text <> 'child_question' OR ${t.childQuestionId} IS NOT NULL`,
    ),
    check(
      "needs_you_items_run_kinds_have_run_id",
      sql`${t.kind} = 'gate' OR ${t.runId} IS NOT NULL`,
    ),
  ],
);
