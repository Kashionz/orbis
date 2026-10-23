// GitHub 整合（ARCHITECTURE §5.2、§11）：Task 與 Issue 的對應、webhook 去重、PR 與 Task 的對應。
// 讀寫由 packages/github 的 GitHubStore port 定義；Drizzle 版的實作在 Server。

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import {
  feedbackFixStatusEnum,
  feedbackSourceEnum,
  githubWebhookDeliveryStatusEnum,
  pullRequestStateEnum,
} from "./enums";
import { repoSpecs, repos } from "./project";
import { runs } from "./run";
import { tasks } from "./task";
import { members } from "./team";

/**
 * Task 與 GitHub Issue 的對應。一個 Task 最多對應一個 Issue；同一個 Issue 可能對應
 * 不同 Project 的 Task（同一個 repo 登記在多個 Project）。
 */
export const taskIssueLinks = pgTable(
  "task_issue_links",
  {
    taskId: uuid("task_id")
      .primaryKey()
      .references(() => tasks.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** GitHub 的 repository id（改名後仍可對應）。 */
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    issueNumber: integer("issue_number").notNull(),
    /** GitHub 的 Issue id（全域唯一）。 */
    issueId: bigint("issue_id", { mode: "number" }).notNull(),
    issueUrl: text("issue_url").notNull(),
    /** 狀態摘要留言的 comment id；還沒建立或已被刪除時為 null。 */
    summaryCommentId: bigint("summary_comment_id", { mode: "number" }),
    /** 上次寫出的摘要留言內容的雜湊，相同就不再更新。 */
    summaryHash: text("summary_hash"),
    /** 上次同步時 Issue 各欄位的快照與時間，用來做欄位層級的合併；格式由 packages/github 定義。 */
    snapshot: jsonb("snapshot").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("task_issue_links_github_repo_id_issue_number_idx").on(t.githubRepoId, t.issueNumber),
    // 同一個 Repo（Project 內的登記）中，一個 Issue 只能對應一個 Task；兩人同時匯入時由 DB 擋下。
    // 同一個 GitHub repo 登記在不同 Project 時是不同的 repo_id，不受影響。
    unique("task_issue_links_repo_id_issue_number_unique").on(t.repoId, t.issueNumber),
  ],
);

/**
 * webhook delivery 的去重紀錄。先以 processing 搶下處理權，處理成功後改成 completed；
 * 處理失敗會刪除紀錄，讓 GitHub 的 redelivery 可以重新處理。
 * GitHub 只能重新傳送 3 天內的 delivery，Server 定期刪除舊紀錄（以 claimed_at 查詢）。
 */
export const githubWebhookDeliveries = pgTable(
  "github_webhook_deliveries",
  {
    /** GitHub 的 `X-GitHub-Delivery`。 */
    deliveryId: text("delivery_id").primaryKey(),
    /** `X-GitHub-Event`，例如 `issues`。 */
    event: text("event").notNull(),
    status: githubWebhookDeliveryStatusEnum("status").notNull(),
    claimedAt: timestamptz("claimed_at").notNull(),
    completedAt: timestamptz("completed_at"),
  },
  (t) => [index("github_webhook_deliveries_claimed_at_idx").on(t.claimedAt)],
);

/** 以 GitHub App 身分開出的 PR 與 Task 的對應，以及 Feedback Loop 的次數（ARCHITECTURE §5.2）。 */
export const pullRequests = pgTable(
  "pull_requests",
  {
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    number: integer("number").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** 開出這個 PR 的 Run。 */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    headBranch: text("head_branch").notNull(),
    headSha: text("head_sha").notNull(),
    url: text("url").notNull(),
    state: pullRequestStateEnum("state").notNull().default("open"),
    /** CI 失敗觸發的自動修正次數。W5–7 起不再使用，次數由 feedback_fixes 數出（保留欄位，不刪除）。 */
    ciFixCount: integer("ci_fix_count").notNull().default(0),
    /** review 留言觸發的自動修正次數。W5–7 起不再使用，次數由 feedback_fixes 數出（保留欄位，不刪除）。 */
    reviewFixCount: integer("review_fix_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("pull_requests_github_repo_id_number_unique").on(t.githubRepoId, t.number),
    index("pull_requests_task_id_idx").on(t.taskId),
    check(
      "pull_requests_fix_counts_nonnegative",
      sql`${t.ciFixCount} >= 0 AND ${t.reviewFixCount} >= 0`,
    ),
  ],
);

/**
 * Feedback Loop 待送的批次（ARCHITECTURE §5.2 的合併再送），讀寫由 packages/github 的 FeedbackStore 定義。
 * 每個 PR 的每種來源最多一筆：新的回饋併入 items，due_at 到了（或 review 送出）才組成修正 prompt
 * 送出，送出後刪除。CI 的批次記下所屬的 head_sha，不是 PR 目前的 head 時整批作廢。
 */
export const feedbackBatches = pgTable(
  "feedback_batches",
  {
    id: id(),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    prNumber: integer("pr_number").notNull(),
    source: feedbackSourceEnum("source").notNull(),
    headSha: text("head_sha"),
    /** 收集到的留言或 check，格式由 packages/github 定義。 */
    items: jsonb("items").notNull().default(sql`'[]'::jsonb`),
    dueAt: timestamptz("due_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("feedback_batches_pr_source_unique").on(t.githubRepoId, t.prNumber, t.source),
    index("feedback_batches_due_at_idx").on(t.dueAt),
    check(
      "feedback_batches_head_sha_only_for_ci",
      sql`(${t.source}::text = 'ci') = (${t.headSha} IS NOT NULL)`,
    ),
  ],
);

/**
 * 每一次 Feedback Loop 自動修正的紀錄（packages/github 的 FeedbackFix）。修正會開一個新的 Run
 * （origin = feedback_loop），接續 previous_run_id 的 session；run_id 是那個新 Run，沒有開成時為 null。
 * 每個 PR 每種來源的修正次數由這張表數出（pull_requests 的兩個計數不再使用）；
 * trigger 是觸發的批次，CI 的批次也用來判斷同一個 check 是否已經觸發過。
 * Task 上顯示的紀錄另外寫成 task_notes（source = feedback_loop）。
 */
export const feedbackFixes = pgTable(
  "feedback_fixes",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    prNumber: integer("pr_number").notNull(),
    source: feedbackSourceEnum("source").notNull(),
    /** 要接續 session 的 Run（開出 PR 或上一次修正的 Run）。 */
    previousRunId: uuid("previous_run_id").references(() => runs.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    /** 觸發的批次（FeedbackBatch），格式由 packages/github 定義。 */
    trigger: jsonb("trigger").notNull(),
    status: feedbackFixStatusEnum("status").notNull(),
    /** PR 上這次修正的紀錄留言 id；push 後在同一則留言補上新的 commit。 */
    prCommentId: bigint("pr_comment_id", { mode: "number" }),
    /** 修正 push 出去的 commit（`pushed` 時）。 */
    commitSha: text("commit_sha"),
    /** 失敗的原因（`failed` 時）。 */
    message: text("message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("feedback_fixes_pr_idx").on(t.githubRepoId, t.prNumber, t.createdAt),
    index("feedback_fixes_run_id_idx").on(t.runId),
    index("feedback_fixes_task_id_idx").on(t.taskId),
  ],
);

/** 「提交到 repo」開出的 Repo Spec PR（ARCHITECTURE §12.1）。merge 後更新 repo_specs 的版本。 */
export const repoSpecPullRequests = pgTable(
  "repo_spec_pull_requests",
  {
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    number: integer("number").notNull(),
    repoSpecId: uuid("repo_spec_id")
      .notNull()
      .references(() => repoSpecs.id, { onDelete: "cascade" }),
    headBranch: text("head_branch").notNull(),
    url: text("url").notNull(),
    state: pullRequestStateEnum("state").notNull().default("open"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.githubRepoId, t.number] }),
    index("repo_spec_pull_requests_repo_spec_id_idx").on(t.repoSpecId),
  ],
);
