// Project（ARCHITECTURE §4）：一組相關 Repo 與 Task 的集合，擁有自己的看板與政策設定。

import { z } from "zod";
import { Id, Timestamp } from "./common";

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
});
export type ProjectPolicy = z.infer<typeof ProjectPolicy>;

export const Project = z.object({
  id: Id,
  teamId: Id,
  name: z.string().min(1),
  keyPrefix: ProjectKeyPrefix,
  description: z.string(),
  policy: ProjectPolicy,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = z.infer<typeof Project>;
