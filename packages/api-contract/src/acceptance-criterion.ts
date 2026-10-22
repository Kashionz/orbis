// Acceptance Criterion（ARCHITECTURE §5.1）：Task 上一條可判定的完成條件。

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { AcceptanceCriterionKind, AcceptanceCriterionResult } from "./enums";

const Description = z.string().trim().min(1);

/**
 * `command` 類型要執行的指令；null 表示沿用 `.orbis/config.toml` 的 `verify`。
 * 其他類型一律為 null。
 */
const Command = z.string().trim().min(1).nullable();

const commandOnlyForCommandKind = {
  error: "只有 command 類型可以設定指令",
  path: ["command"],
};

export const AcceptanceCriterion = z
  .object({
    id: Id,
    taskId: Id,
    kind: AcceptanceCriterionKind,
    description: Description,
    command: Command,
    /** 在 Task 中的排序，由 0 開始。 */
    position: z.number().int().nonnegative(),
    /** 最近一次 Verification（或 `manual` 在 Review Gate 打勾）的結果。 */
    result: AcceptanceCriterionResult,
    /** 結果最後更新的時間；尚未判定時為 null。 */
    resultUpdatedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .refine((c) => c.kind === "command" || c.command === null, commandOnlyForCommandKind);
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

/** 在 Task 上新增一條 Acceptance Criterion。Task 由路徑決定；未給 position 時加在最後。 */
export const CreateAcceptanceCriterionInput = z
  .object({
    kind: AcceptanceCriterionKind,
    description: Description,
    command: Command.default(null),
    position: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((c) => c.kind === "command" || c.command === null, commandOnlyForCommandKind);
export type CreateAcceptanceCriterionInput = z.input<typeof CreateAcceptanceCriterionInput>;

/**
 * 更新 Acceptance Criterion，只送要改的欄位，至少一個。
 * 改成非 `command` 類型時要同時把 `command` 設為 null；合併後的結果由 Server 再檢查一次。
 * 判定結果由 Verification 或 Review Gate 寫入，不在這裡改。
 */
export const UpdateAcceptanceCriterionInput = z
  .object({
    kind: AcceptanceCriterionKind,
    description: Description,
    command: Command,
    position: z.number().int().nonnegative(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { error: "至少要更新一個欄位" })
  .refine((c) => c.kind === undefined || c.kind === "command" || c.command === null, {
    error: "改成非 command 類型時，command 必須同時設為 null",
    path: ["command"],
  });
export type UpdateAcceptanceCriterionInput = z.input<typeof UpdateAcceptanceCriterionInput>;
