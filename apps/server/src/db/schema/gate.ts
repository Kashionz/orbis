// Gate 與 Needs You（ARCHITECTURE §5、§8、§10）。

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz } from "./columns";
import { gateDecisionEnum, gateKindEnum, needsYouKindEnum } from "./enums";
import { projects } from "./project";
import { runs } from "./run";
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
    decision: gateDecisionEnum("decision"),
    decidedByMemberId: uuid("decided_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamptz("decided_at"),
    /** 退回時的整體說明；行內留言另外保存（之後由負責的軌加入）。 */
    comment: text("comment"),
    createdAt: createdAt(),
  },
  (t) => [
    index("gates_task_id_idx").on(t.taskId),
    check("gates_decision_complete", sql`(${t.decision} IS NULL) = (${t.decidedAt} IS NULL)`),
  ],
);

/**
 * Needs You 項目：等待某位 Member 處理的事情（權限請求、待核准的 Gate、停下來的 Run）。
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
      "needs_you_items_run_kinds_have_run_id",
      sql`${t.kind} = 'gate' OR ${t.runId} IS NOT NULL`,
    ),
  ],
);
