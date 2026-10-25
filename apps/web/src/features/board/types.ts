// 看板用到、後端還沒有的 API 的暫定型別（不是契約）。

import { GateKind, RunStatus } from "@orbis/api-contract";
import { z } from "zod";

/** TODO(backend, board-summary)：`GET` 看板每列的最新 Run 與驗收進度。 */
export const BOARD_SUMMARY_ROUTE = "/api/projects/:projectId/board-summary";

/** 看板一列的摘要。 */
export const BoardSummaryItem = z.object({
  taskId: z.string(),
  latestRun: z
    .object({
      id: z.string(),
      status: RunStatus,
      gate: GateKind.nullable(),
      agent: z.string(),
    })
    .nullable(),
  acceptance: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});
export type BoardSummaryItem = z.infer<typeof BoardSummaryItem>;
export const BoardSummaryResponse = z.array(BoardSummaryItem);
