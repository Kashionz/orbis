// Verification（ARCHITECTURE §5.1）：每一輪一筆，每條條件的結果另存一筆。

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz } from "./columns";
import {
  verificationOutcomeEnum,
  verificationResolutionEnum,
  verificationStatusEnum,
} from "./enums";
import { runs } from "./run";
import { acceptanceCriteria, tasks } from "./task";
import { members } from "./team";

/**
 * 一輪 Verification。id 即協定的 verification_id（Server 送 `verify` 時產生）。
 * attempt 在每個 Run 內從 1 開始；人選擇「附意見再試」後重新從 1 算，所以同一個 Run 可能有兩筆
 * attempt 相同的紀錄，以 started_at 區分先後。超過重試上限後，人的決定記在 resolution。
 */
export const verifications = pgTable(
  "verifications",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: verificationStatusEnum("status").notNull().default("running"),
    resolution: verificationResolutionEnum("resolution"),
    resolvedByMemberId: uuid("resolved_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /** 「附意見再試」時附的意見。 */
    comment: text("comment"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
  },
  (t) => [
    index("verifications_run_id_idx").on(t.runId, t.startedAt),
    index("verifications_task_id_idx").on(t.taskId),
    check("verifications_attempt_positive", sql`${t.attempt} >= 1`),
  ],
);

/**
 * 一條條件在某一輪的結果（協定的 `verification_result`）。evidence 是協定的
 * `VerificationEvidence[]`（JSONB，原樣保存）。最新一次的結果另外寫回 acceptance_criteria。
 */
export const verificationResults = pgTable(
  "verification_results",
  {
    id: id(),
    verificationId: uuid("verification_id")
      .notNull()
      .references(() => verifications.id, { onDelete: "cascade" }),
    criterionId: uuid("criterion_id")
      .notNull()
      .references(() => acceptanceCriteria.id, { onDelete: "cascade" }),
    outcome: verificationOutcomeEnum("outcome").notNull(),
    summary: text("summary").notNull(),
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    /** 判定的 `consult` Child Run；`command` 類型為 null。 */
    judgedByRunId: uuid("judged_by_run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("verification_results_verification_id_criterion_id_unique").on(
      t.verificationId,
      t.criterionId,
    ),
  ],
);
