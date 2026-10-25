// 派工（建立 Run）與派工對話框的選項（ARCHITECTURE §6.1、§8）。

import { z } from "zod";
import { Effort, PermissionPolicy, RunnerKind } from "./enums";

/**
 * 派工。Task 由路徑決定。
 * - `permissionPolicy` 省略時用 Project 的預設政策。
 * - `yolo` 只能配「在我的電腦跑」（`runnerKind = local`）；Team Runner 的 `yolo` 留到 Phase 2。
 */
export const CreateRunInput = z
  .object({
    /** Agent Profile 的 id，例如 `claude-code`。 */
    agent: z.string().trim().min(1),
    /** 使用的 model；null 表示 Agent 的預設值。 */
    model: z.string().trim().min(1).nullable().default(null),
    runnerKind: RunnerKind,
    permissionPolicy: PermissionPolicy.optional(),
    /** 推理強度；null 表示 Agent 的預設值。 */
    effort: Effort.nullable().default(null),
  })
  .strict()
  .refine((input) => input.permissionPolicy !== "yolo" || input.runnerKind === "local", {
    error: "Team Runner 不能使用 yolo",
    path: ["permissionPolicy"],
  });
export type CreateRunInput = z.input<typeof CreateRunInput>;

/** 派工對話框中的一個 Agent（Server 彙整各 Runner 回報的 AgentAvailability）。 */
export const AgentOption = z.object({
  /** Agent Profile 的 id。 */
  id: z.string().min(1),
  version: z.string().nullable(),
  available: z.boolean(),
  /** 不可用的原因，例如「未安裝」；可用時為 null。 */
  unavailableReason: z.string().nullable(),
  /** 可以選的 model 的 id；空陣列表示只能用 Agent 的預設值。顯示名稱與推理強度見模型目錄（agentCatalog）。 */
  models: z.array(z.string().min(1)),
  /** 這個 Agent 在 Permission Policy 下無法攔截的操作（ARCHITECTURE §8），派工對話框顯示警告。 */
  permissionGaps: z.array(z.string()),
});
export type AgentOption = z.infer<typeof AgentOption>;

export const DISPATCH_TARGET_UNAVAILABLE_REASONS = ["repo_not_mapped"] as const;

/** 某一種 Runner 目前能跑哪些 Agent。 */
export const DispatchTarget = z.object({
  /** 是否至少有一台這種 Runner 在線，而且接受新的 Dispatch。 */
  online: z.boolean(),
  agents: z.array(AgentOption),
  /**
   * 這個 target 不能派工的原因；可以派工時為 null。`repo_not_mapped`：Task 的 Repo 是本機 Repo，
   * 但這台 Local Runner 的 `runner.toml` 沒有對應（查詢帶 `taskId` 時才會判斷）。
   */
  unavailableReason: z.enum(DISPATCH_TARGET_UNAVAILABLE_REASONS).nullable(),
});
export type DispatchTarget = z.infer<typeof DispatchTarget>;

/**
 * 派工對話框的選項，Server 依目前的 Member、Role 與 Project 政策彙整。查詢參數 `taskId`（選填）：
 * 帶上時依那個 Task 的 Repo 判斷（本機 Repo 只能派到有對應的 Local Runner）。
 * - `local`：目前 Member 自己的 Local Runner；還沒有完成 Pairing 時為 null。
 * - `team`：Team Runner；沒有任何 Team Runner、Project 不允許這個 Member 派工到 Team Runner，
 *   或 Task 的 Repo 是本機 Repo 時為 null。
 */
export const DispatchOptions = z.object({
  local: DispatchTarget.nullable(),
  team: DispatchTarget.nullable(),
  /** Project 的預設政策，派工對話框的預設選項。 */
  defaultPermissionPolicy: PermissionPolicy,
});
export type DispatchOptions = z.infer<typeof DispatchOptions>;
