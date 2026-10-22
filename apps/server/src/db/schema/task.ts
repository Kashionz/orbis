// Task、Task 相依、Acceptance Criterion、Draft Task（ARCHITECTURE §4、§5、§9）。

import { sql } from "drizzle-orm";
import {
  boolean,
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
import { acceptanceCriterionKindEnum, taskDoneReasonEnum, taskStatusEnum } from "./enums";
import { projects, repoSpecs, repos } from "./project";
import { runs } from "./run";
import { members } from "./team";

/**
 * Task：指派給 Member、可交由 Agent 執行的一件工作。只對應一個 Repo（ADR-0011）。
 * Task Key（例如 `ORB-12`）在建立時由 Project 前綴與流水號組成並保存下來，之後不隨前綴變動。
 */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Project 內的流水號。 */
    number: integer("number").notNull(),
    /** Task Key，例如 `ORB-12`。 */
    key: text("key").notNull(),
    /**
     * 這個 Task 對應的 Repo。Backlog 階段可以還沒決定，所以允許 null；
     * 進入 Ready 前必須設定（由應用層檢查）。
     */
    repoId: uuid("repo_id").references(() => repos.id),
    /** 連結的 Repo 內 Spec；小 Task 的 Spec 就是 description。 */
    repoSpecId: uuid("repo_spec_id").references(() => repoSpecs.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** Task 描述（markdown），與 GitHub Issue 的 body 同步。 */
    description: text("description").notNull().default(""),
    status: taskStatusEnum("status").notNull().default("backlog"),
    /** 轉為 Done 的原因（GitHub 的 state_reason）；不是 Done 時為 null。 */
    doneReason: taskDoneReasonEnum("done_reason"),
    assigneeMemberId: uuid("assignee_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /** 與 GitHub Issue 同步的 labels。 */
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    /** Plan Gate 的個別覆寫；null 表示沿用 projects.plan_gate_enabled。 */
    planGateEnabled: boolean("plan_gate_enabled"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("tasks_project_id_number_unique").on(t.projectId, t.number),
    unique("tasks_project_id_key_unique").on(t.projectId, t.key),
    index("tasks_project_id_status_idx").on(t.projectId, t.status),
    index("tasks_assignee_member_id_idx").on(t.assigneeMemberId),
    check("tasks_number_positive", sql`${t.number} >= 1`),
    check("tasks_done_reason_only_when_done", sql`${t.doneReason} IS NULL OR ${t.status} = 'done'`),
  ],
);

/**
 * Task 相依：task_id 依賴 depends_on_task_id（depends_on 完成後 task 才能開始）。
 * 兩者必須在同一個 Project、不可形成循環，由應用層檢查。
 */
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    index("task_dependencies_depends_on_task_id_idx").on(t.dependsOnTaskId),
    check("task_dependencies_not_self", sql`${t.taskId} <> ${t.dependsOnTaskId}`),
  ],
);

/**
 * Acceptance Criterion：Task 上一條可判定的完成條件（ARCHITECTURE §5.1）。
 * passed 為 null 表示還沒判定；evidence 是判定時附上的證據（指令輸出、截圖的 blob 參照等）。
 */
export const acceptanceCriteria = pgTable(
  "acceptance_criteria",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** 在 Task 中的顯示順序。 */
    position: integer("position").notNull(),
    kind: acceptanceCriterionKindEnum("kind").notNull(),
    description: text("description").notNull(),
    /** `command` 類型要執行的指令；其他類型為 null。 */
    command: text("command"),
    passed: boolean("passed"),
    /** 判定的證據，格式保留彈性（例如 `{ exit_code, output_blob }`、`{ screenshots: [...] }`）。 */
    evidence: jsonb("evidence"),
    checkedAt: timestamptz("checked_at"),
    /** `manual` 類型由哪位 Member 打勾。 */
    checkedByMemberId: uuid("checked_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /** `agent`、`browser` 類型由哪個 Run 判定。 */
    checkedByRunId: uuid("checked_by_run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("acceptance_criteria_task_id_idx").on(t.taskId),
    check(
      "acceptance_criteria_command_required",
      sql`${t.kind} <> 'command' OR ${t.command} IS NOT NULL`,
    ),
  ],
);

/**
 * Draft Task：由 Agent 透過 `propose_tasks` 提出、尚未經人確認的 Task（ARCHITECTURE §9）。
 * 不佔 Task Key；確認後才建立 tasks 的紀錄並填入 confirmed_task_id，駁回時填 dismissed_at。
 */
export const draftTasks = pgTable(
  "draft_tasks",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** 提出這個 Draft Task 的 Run。 */
    proposedByRunId: uuid("proposed_by_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    repoId: uuid("repo_id").references(() => repos.id, { onDelete: "set null" }),
    /** `propose_tasks` 的 spec 參數（Spec 內容或 Repo 內 Spec 的路徑），格式保留彈性。 */
    spec: text("spec"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** 提議的 Acceptance Criterion：`[{ kind, description, command? }]`。 */
    acceptanceCriteria: jsonb("acceptance_criteria").notNull().default(sql`'[]'::jsonb`),
    /** 提議的相依關係：同一批 Draft Task 的 id，或既有 Task 的 id。格式保留彈性。 */
    dependsOn: jsonb("depends_on").notNull().default(sql`'[]'::jsonb`),
    confirmedTaskId: uuid("confirmed_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    confirmedByMemberId: uuid("confirmed_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamptz("confirmed_at"),
    dismissedAt: timestamptz("dismissed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("draft_tasks_project_id_idx").on(t.projectId),
    check(
      "draft_tasks_confirmed_or_dismissed",
      sql`${t.confirmedAt} IS NULL OR ${t.dismissedAt} IS NULL`,
    ),
  ],
);
