// 執行中切換模型、推理強度、Permission Policy 與 Agent（後端缺口 `run-settings`、`agent-switch`，
// ARCHITECTURE §7、§8）。切換以 RunControl 送給 Runner，生效時 Runner 送 `run_settings_changed`／
// `agent_switched` Event，所以 API 只回 202，結果以 Event 為準。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { Effort, PermissionPolicy, RunSettingName } from "./enums";

/** 某個時間點的設定。 */
export const RunSettingsSnapshot = z.object({
  agent: z.string().min(1),
  /** null 表示 Agent 的預設值。 */
  model: z.string().min(1).nullable(),
  /** null 表示 Agent 的預設值，或模型不支援推理強度。 */
  effort: Effort.nullable(),
  permissionPolicy: PermissionPolicy,
});
export type RunSettingsSnapshot = z.infer<typeof RunSettingsSnapshot>;

/**
 * 一次已生效的切換，由 `run_settings_changed` 或 `agent_switched` Event 組出（事件串流顯示成系統事件）。
 * 值為 null 的欄位表示這次沒有改變。
 */
export const RunSettingsChange = z.object({
  /** 對應的 Event。 */
  seq: z.number().int().positive(),
  ts: Timestamp,
  /** 切換的 Member；派工時的設定或系統切換時為 null。 */
  actorMemberId: Id.nullable(),
  /** 換成的 Agent；只有換 Agent（`agent_switched`）時有值。 */
  agent: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  effort: Effort.nullable(),
  permissionPolicy: PermissionPolicy.nullable(),
  /** 要求了但 Agent 不支援、沒有套用的項目。 */
  notApplied: z.array(RunSettingName),
});
export type RunSettingsChange = z.infer<typeof RunSettingsChange>;

/** `GET` runSettings 的回應。 */
export const RunSettings = z.object({
  /** 派工時的設定。 */
  initial: RunSettingsSnapshot,
  /** 目前已生效的設定。 */
  current: RunSettingsSnapshot,
  /** 依時間排序（舊的在前）。 */
  changes: z.array(RunSettingsChange),
});
export type RunSettings = z.infer<typeof RunSettings>;

/**
 * `PATCH` runSettings：只送要改的欄位，至少一個。換 Agent 用 `POST` runSwitchAgent。
 * - 模型與推理強度：`edit_task`，下一個回合開始前生效；目前 Agent 的模型目錄中沒有這個模型，
 *   或模型不支援推理強度時回 422 `option_unsupported`。
 * - Permission Policy：和派工時能不能選這個策略同一條規則（Project 允許的策略、`manage_permission_policy`），
 *   從下一個權限請求開始套用；Team Runner 不能用 `yolo`。
 * - Run 已結束 → 409 `run_finished`。
 */
export const UpdateRunSettingsInput = z
  .object({
    model: z.string().trim().min(1),
    effort: Effort,
    permissionPolicy: PermissionPolicy,
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { error: "至少要改一個設定" });
export type UpdateRunSettingsInput = z.input<typeof UpdateRunSettingsInput>;

/** `PATCH` runSettings 的回應（202）：送出的 RunControl（模型與推理強度一個、Permission Policy 一個）。 */
export const RunSettingsUpdated = z.object({ controlIds: z.array(Id).min(1).max(2) });
export type RunSettingsUpdated = z.infer<typeof RunSettingsUpdated>;

/**
 * `POST` runSwitchAgent：換成同一台 Runner 上可以用的另一個 Agent，接續同一個 Run 與 Worktree
 * （ADR-0016）。回合中送出時等回合結束才換。
 * - `edit_task`，而且新的 Agent 要符合派工的限制。
 * - 這台 Runner 上沒有這個 Agent 或不可用 → 422 `agent_unavailable`；Run 已結束 → 409 `run_finished`。
 */
export const SwitchAgentInput = z
  .object({
    agent: z.string().trim().min(1),
    /** null 表示新 Agent 的預設模型。 */
    model: z.string().trim().min(1).nullable().default(null),
    effort: Effort.nullable().default(null),
  })
  .strict();
export type SwitchAgentInput = z.input<typeof SwitchAgentInput>;

/** `POST` runSwitchAgent 的回應（202）。`controlId` 也是 `agent_switched` Event 的 `control_id`。 */
export const AgentSwitchRequested = z.object({ controlId: Id });
export type AgentSwitchRequested = z.infer<typeof AgentSwitchRequested>;
