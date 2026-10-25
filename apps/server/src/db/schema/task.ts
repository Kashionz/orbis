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
import {
  acceptanceCriterionKindEnum,
  taskDoneReasonEnum,
  taskGeneralAccessEnum,
  taskStatusEnum,
} from "./enums";
import { projects, repoSpecs, repos } from "./project";
import { runs } from "./run";
import { members } from "./team";

/**
 * Task：指派給 Member、可交由 Agent 執行的一件工作。只對應一個 Repo（ADR-0011），可以不指定。
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
     * 這個 Task 對應的 Repo。可以不指定（只能停在 Backlog），之後補指定一次就不能再換；
     * 進入 Ready 前必須設定（都由應用層檢查）。
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
    /** 一般存取（Task 分享，ADR-0012）；Task 成員在 task_members。 */
    generalAccess: taskGeneralAccessEnum("general_access").notNull().default("team_edit"),
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
    /** `command` 類型要執行的指令；null 表示沿用 Repo 設定檔（§6.3）的 `verify`。其他類型一律為 null。 */
    command: text("command"),
    passed: boolean("passed"),
    /** 最近一次判定的摘要（失敗原因、Agent 的判定理由）。 */
    resultSummary: text("result_summary"),
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
    // 與契約一致：只有 command 類型可以設定指令；command 類型的指令可以為 null（ARCHITECTURE §5.1）。
    check(
      "acceptance_criteria_command_only_for_command_kind",
      sql`${t.kind} = 'command' OR ${t.command} IS NULL`,
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
    /** 同一次 `propose_tasks` 的批次（同一批共用一個值，由應用層產生）。 */
    batchId: uuid("batch_id").notNull().default(sql`gen_random_uuid()`),
    /** 在批次中的順序，從 1 開始；`depends_on` 的 `#<n>` 指這個值。 */
    position: integer("position").notNull().default(1),
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
    /** 提議的相依關係：同一批的 `#<n>`，或既有的 Task Key（字串陣列）。 */
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
    index("draft_tasks_batch_id_idx").on(t.batchId, t.position),
    check("draft_tasks_position_positive", sql`${t.position} >= 1`),
    check(
      "draft_tasks_confirmed_or_dismissed",
      sql`${t.confirmedAt} IS NULL OR ${t.dismissedAt} IS NULL`,
    ),
  ],
);
