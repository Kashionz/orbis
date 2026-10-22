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
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, timestamptz, updatedAt } from "./columns";
import { githubWebhookDeliveryStatusEnum, pullRequestStateEnum } from "./enums";
import { repos } from "./project";
import { runs } from "./run";
import { tasks } from "./task";

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
  ],
);

/**
 * webhook delivery 的去重紀錄。先以 processing 搶下處理權，處理成功後改成 completed；
 * 處理失敗會刪除紀錄，讓 GitHub 的 redelivery 可以重新處理。
 */
export const githubWebhookDeliveries = pgTable("github_webhook_deliveries", {
  /** GitHub 的 `X-GitHub-Delivery`。 */
  deliveryId: text("delivery_id").primaryKey(),
  /** `X-GitHub-Event`，例如 `issues`。 */
  event: text("event").notNull(),
  status: githubWebhookDeliveryStatusEnum("status").notNull(),
  claimedAt: timestamptz("claimed_at").notNull(),
  completedAt: timestamptz("completed_at"),
});

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
    /** CI 失敗觸發的自動修正次數（上限 5）。 */
    ciFixCount: integer("ci_fix_count").notNull().default(0),
    /** review 留言觸發的自動修正次數（上限 5，與 CI 分開計數）。 */
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
