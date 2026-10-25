// 看板摘要（後端缺口 `board-summary`）：一次取得 Project 中每個 Task 的最新主 Run 與驗收進度，
// 取代逐 Task 查詢。Run 狀態或 Verification 結果變化時，Web 讓這個 query 失效重抓。

import { z } from "zod";
import { Id } from "./common";
import { GateKind, RunStatus } from "./enums";

const Count = z.number().int().nonnegative();

export const BoardSummaryItem = z.object({
  taskId: Id,
  /** 最新的主 Run（不算 Child Run 與判定用的 Run）；還沒有 Run 時為 null。 */
  latestRun: z
    .object({
      id: Id,
      status: RunStatus,
      /** `awaiting_gate` 時等待的 Gate；其他狀態為 null。 */
      gate: GateKind.nullable(),
      /** 目前的 Agent。 */
      agent: z.string().min(1),
    })
    .nullable(),
  /** Acceptance Criterion 最近一次判定的結果；`total` 包含還沒判定的。 */
  acceptance: z.object({ passed: Count, failed: Count, total: Count }),
});
export type BoardSummaryItem = z.infer<typeof BoardSummaryItem>;

/** `GET` projectBoardSummary 的回應（`view`）。看不到的 Task（Task 分享）不出現。 */
export const BoardSummaryResponse = z.object({ tasks: z.array(BoardSummaryItem) });
export type BoardSummaryResponse = z.infer<typeof BoardSummaryResponse>;
