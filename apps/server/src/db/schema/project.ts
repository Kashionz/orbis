// Project、Project 對 Member 的 Role 覆寫、Repo、RepoSpec（ARCHITECTURE §4、§9、§10、§12.2）。

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns";
import { permissionPolicyEnum, roleEnum } from "./enums";
import { members, teams } from "./team";

/**
 * Project：一組相關 Repo 與 Task 的集合，擁有自己的看板與政策設定。
 * Task Key 由 task_key_prefix 加上流水號組成（例如 `ORB-12`），流水號取自 next_task_number。
 */
export const projects = pgTable(
  "projects",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Task Key 的前綴，例如 `ORB`。 */
    taskKeyPrefix: text("task_key_prefix").notNull(),
    /** 下一個 Task 的流水號。建立 Task 時在同一個 transaction 中遞增。 */
    nextTaskNumber: integer("next_task_number").notNull().default(1),
    /** Plan Gate 是否開啟；Task 可以再個別覆寫（tasks.plan_gate_enabled）。 */
    planGateEnabled: boolean("plan_gate_enabled").notNull().default(true),
    /** 是否允許 Run 使用 Delegation。 */
    delegationEnabled: boolean("delegation_enabled").notNull().default(true),
    /** 允許被分派的 Agent；null 表示不限制。 */
    delegationAllowedAgents: text("delegation_allowed_agents").array(),
    /** 「Member 不能核准自己的 Task」。 */
    forbidSelfApproval: boolean("forbid_self_approval").notNull().default(false),
    /** Role 為 Member 的人能否派工到 Team Runner（Owner／Admin 一律可以）。 */
    allowMemberTeamRunnerDispatch: boolean("allow_member_team_runner_dispatch")
      .notNull()
      .default(true),
    /** 這個 Project 的 Run 預設使用的 Permission Policy。 */
    defaultPermissionPolicy: permissionPolicyEnum("default_permission_policy")
      .notNull()
      .default("auto"),
    /** Verification 失敗時自動重試的上限（ARCHITECTURE §5.1，預設 3 次）。 */
    verificationMaxRetries: integer("verification_max_retries").notNull().default(3),
    /** 有 Repo 的 Task 是否自動建立對應的 GitHub Issue（ARCHITECTURE §11）。 */
    autoCreateIssues: boolean("auto_create_issues").notNull().default(true),
    /** 會觸發 Feedback Loop 的 bot 的 GitHub login（ARCHITECTURE §5.2）。 */
    feedbackBotAllowlist: text("feedback_bot_allowlist")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("projects_team_id_task_key_prefix_unique").on(t.teamId, t.taskKeyPrefix),
    check("projects_next_task_number_positive", sql`${t.nextTaskNumber} >= 1`),
  ],
);

/** Project 對個別 Member 的 Role 覆寫。沒有紀錄時沿用 members.role。 */
export const projectMemberRoles = pgTable(
  "project_member_roles",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.memberId] })],
);

/** Repo：登記在 Project 底下的一個 GitHub repository。 */
export const repos = pgTable(
  "repos",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    githubOwner: text("github_owner").notNull(),
    githubName: text("github_name").notNull(),
    /** GitHub 的 repository id；登記時由 D 軌讀取，改名後仍可對應。 */
    githubRepoId: bigint("github_repo_id", { mode: "number" }),
    defaultBranch: text("default_branch"),
    /** 安裝在這個 repo 的 GitHub App installation id；未安裝時為 null。 */
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("repos_project_id_github_owner_github_name_unique").on(
      t.projectId,
      t.githubOwner,
      t.githubName,
    ),
  ],
);

/**
 * RepoSpec：Repo 內的 markdown Spec 檔，可以被多個 Task 連結。草稿在 collab_documents
 * （`repo-spec-draft:<id>`）；提交到 repo 的 PR merge 後 version 加 1（ARCHITECTURE §12.1）。
 */
export const repoSpecs = pgTable(
  "repo_specs",
  {
    id: id(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** Repo 內的相對路徑，一律用 `/` 分隔。 */
    path: text("path").notNull(),
    title: text("title"),
    /** 每次 Spec PR merge 加 1；還沒有任何 merge 時為 0。 */
    version: integer("version").notNull().default(0),
    /** 最近一次 merge 的 commit SHA。 */
    committedSha: text("committed_sha"),
    /** 最近一次 merge 時這個檔案的 blob SHA，用來偵測 default branch 上被別人改過。 */
    committedBlobSha: text("committed_blob_sha"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("repo_specs_repo_id_path_unique").on(t.repoId, t.path)],
);
