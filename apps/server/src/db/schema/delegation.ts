// Orbis MCP 工具呼叫與 Child Run 的問題（ARCHITECTURE §9、ADR-0009）。

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz } from "./columns";
import { runs } from "./run";
import { members } from "./team";

/**
 * Runner 轉來的 Orbis MCP 工具呼叫（協定的 `tool_call`），每個 call_id 一筆。
 * Runner 重新連線後以同一個 call_id 重送，Server 依此去除重複：已有 result 的直接重送結果，
 * 還在等待的（`wait_run`、`ask_parent`）繼續等。result 為 null 表示還沒有結果。
 */
export const orbisToolCalls = pgTable(
  "orbis_tool_calls",
  {
    /** 協定的 call_id，由 Runner 產生。 */
    callId: uuid("call_id").primaryKey(),
    /** 呼叫工具的 Run。 */
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** 協定的 OrbisToolName，例如 `delegate`。 */
    tool: text("tool").notNull(),
    /** 協定的 OrbisToolCall（完整內容）。 */
    input: jsonb("input").notNull(),
    /** 協定的 OrbisToolResult；還沒有結果時為 null。 */
    result: jsonb("result"),
    createdAt: createdAt(),
    completedAt: timestamptz("completed_at"),
  },
  (t) => [
    index("orbis_tool_calls_run_id_idx").on(t.runId),
    index("orbis_tool_calls_pending_idx").on(t.runId).where(sql`${t.completedAt} IS NULL`),
    check(
      "orbis_tool_calls_result_complete",
      sql`(${t.result} IS NULL) = (${t.completedAt} IS NULL)`,
    ),
  ],
);

/**
 * Child Run 以 `ask_parent` 提出的問題。父 Agent 以 `answer_child` 回答（answered_by_run_id），
 * 父 Run 的回合已經結束時改由人在 Needs You 回答（answered_by_member_id）。
 */
export const childQuestions = pgTable(
  "child_questions",
  {
    /** 協定的 question_id。 */
    id: id(),
    childRunId: uuid("child_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    parentRunId: uuid("parent_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    answer: text("answer"),
    answeredByRunId: uuid("answered_by_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    answeredByMemberId: uuid("answered_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    askedAt: timestamptz("asked_at").notNull().defaultNow(),
    answeredAt: timestamptz("answered_at"),
  },
  (t) => [
    index("child_questions_parent_run_id_open_idx")
      .on(t.parentRunId)
      .where(sql`${t.answeredAt} IS NULL`),
    index("child_questions_child_run_id_idx").on(t.childRunId),
    check(
      "child_questions_answer_complete",
      sql`(${t.answer} IS NULL) = (${t.answeredAt} IS NULL)`,
    ),
  ],
);
