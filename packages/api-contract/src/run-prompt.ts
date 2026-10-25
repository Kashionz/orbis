// 執行中傳訊息給 Agent（後端缺口 `run-prompt`，ARCHITECTURE §7）。
//
// Run 在回合中或等待權限回覆時，訊息先排隊（`prompt_queued` Event），回合結束後直接以排隊的訊息開始
// 下一個回合；`interrupt` 先中斷目前的回合再送出。還在排隊的訊息可以收回（`prompt_withdrawn`）。
// Gate 等待時不用這個 API，改用 Gate 的退回（輸入框依 Run 的狀態決定送出的意思）。

import { z } from "zod";
import { Id } from "./common";
import { PromptDelivery } from "./enums";

/**
 * `POST` runPrompts。權限和中止 Run 相同（`edit_task`）。
 * - Run 已結束 → 409 `run_finished`。
 * - Run 在 `queued`、`dispatched`、`verifying`、`awaiting_gate` → 409 `run_not_accepting_prompts`。
 * - Runner 離線時照常接受，RunControl 等 Runner 重新連上後補送。
 */
export const CreateRunPromptInput = z
  .object({
    text: z.string().trim().min(1).max(100_000),
    delivery: PromptDelivery.default("queue"),
  })
  .strict();
export type CreateRunPromptInput = z.input<typeof CreateRunPromptInput>;

/**
 * `POST` runPrompts 的回應（202）。`controlId` 也是 `prompt_queued`／`prompt_submitted` Event 的
 * `control_id`，收回時放在 `DELETE` runPrompt 的路徑中。
 * `DELETE` runPrompt 送出收回的指令後回 202，結果以 `prompt_withdrawn`（收回成功）或
 * `prompt_submitted`（已經送出）Event 為準；Server 已經知道送出時回 409 `prompt_already_submitted`。
 */
export const RunPromptCreated = z.object({ controlId: Id });
export type RunPromptCreated = z.infer<typeof RunPromptCreated>;
