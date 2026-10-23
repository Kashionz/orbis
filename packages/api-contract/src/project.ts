// Project（ARCHITECTURE §4）：一組相關 Repo 與 Task 的集合，擁有自己的看板與政策設定。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { PermissionPolicy, Role } from "./enums";

/**
 * Task Key 的 Project 前綴，例如 `ORB-12` 的 `ORB`。
 * 大寫英文字母開頭，後接大寫英文字母或數字，共 2–10 個字元。
 */
export const ProjectKeyPrefix = z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, {
  error: "Project 前綴必須是 2–10 個大寫英文字母或數字，並以字母開頭",
});
export type ProjectKeyPrefix = z.infer<typeof ProjectKeyPrefix>;

/** Project 的政策設定（§5 Plan Gate、§9 Delegation、§10 Review、§12.2 Role）。 */
export const ProjectPolicy = z.object({
  /** 是否需要 Plan Gate；關閉時 plan 產出後直接進入 Running。Task 可以覆寫。 */
  planGateEnabled: z.boolean(),
  /** 是否允許 Delegation。 */
  delegationEnabled: z.boolean(),
  /** 允許分派的 Agent；null 表示不限制。 */
  delegationAgents: z.array(z.string().min(1)).nullable(),
  /** 是否禁止 Member 核准自己的 Task。 */
  forbidSelfApproval: z.boolean(),
  /** Role 為 Member 的人是否可以派工到 Team Runner。 */
  memberCanDispatchToTeamRunner: z.boolean(),
  /** 派工時的預設 Permission Policy；修改需要 Admin 以上（§8、§12.2）。 */
  defaultPermissionPolicy: PermissionPolicy,
  /** 有 Repo 的 Task 是否自動建立對應的 GitHub Issue（§11）。 */
  autoCreateIssues: z.boolean(),
});
export type ProjectPolicy = z.infer<typeof ProjectPolicy>;

export const Project = z.object({
  id: Id,
  teamId: Id,
  name: z.string().min(1),
  keyPrefix: ProjectKeyPrefix,
  description: z.string(),
  policy: ProjectPolicy,
  /**
   * 目前登入者在這個 Project 的有效 Role：有 Project 的 Role 覆寫時用覆寫，否則用 Team Role（§12.2）。
   * Web UI 依它隱藏操作；實際權限一律以 Server 的判斷為準。
   */
  viewerRole: Role,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

/** 建立 Project（Admin 以上）。政策未指定的欄位用 Server 的預設值。 */
export const CreateProjectInput = z
  .object({
    name: z.string().trim().min(1),
    keyPrefix: ProjectKeyPrefix,
    description: z.string().default(""),
    policy: ProjectPolicy.partial().default({}),
  })
  .strict();
export type CreateProjectInput = z.input<typeof CreateProjectInput>;

/** 修改 Project（Admin 以上），至少一個欄位。Task Key 前綴建立後不能改。 */
export const UpdateProjectInput = z
  .object({
    name: z.string().trim().min(1),
    description: z.string(),
    policy: ProjectPolicy.partial(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { error: "至少要更新一個欄位" });
export type UpdateProjectInput = z.input<typeof UpdateProjectInput>;

/** Project 對某位 Member 的 Role 覆寫（Admin 以上）。不能覆寫成 Owner（§12.2）。 */
export const SetProjectRoleInput = z.object({ role: Role.exclude(["owner"]) }).strict();
export type SetProjectRoleInput = z.infer<typeof SetProjectRoleInput>;

export const ProjectMemberRole = z.object({
  projectId: Id,
  memberId: Id,
  role: Role.exclude(["owner"]),
});
export type ProjectMemberRole = z.infer<typeof ProjectMemberRole>;
