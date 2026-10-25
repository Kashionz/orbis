// 看板每一列的 Run 與驗收進度：一次取得 Project 的看板摘要（看不到的 Task 不在其中）。
// Run 狀態或 Verification 結果改變時，工作區會讓這個 query 失效重抓；其他時候定期更新。

import { API_ROUTES, apiPath, BoardSummaryResponse } from "@orbis/api-contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiRequest } from "../../api/client";
import { POLL_INTERVAL_MS } from "../../api/resources";
import type { AcceptanceSummary, BoardRunSummary } from "./board-model";

export const boardSummaryKey = (projectId: string) =>
  ["projects", projectId, "board-summary"] as const;

export const boardSummaryQuery = (projectId: string) =>
  queryOptions({
    queryKey: boardSummaryKey(projectId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.projectBoardSummary, { projectId }), BoardSummaryResponse, {
        signal,
      }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export interface BoardSummaries {
  runs: ReadonlyMap<string, BoardRunSummary>;
  acceptance: ReadonlyMap<string, AcceptanceSummary>;
}

/** 看板的 Run 與驗收摘要。 */
export function useBoardSummaries(projectId: string): BoardSummaries {
  const summary = useQuery(boardSummaryQuery(projectId));
  return useMemo(() => {
    const runs = new Map<string, BoardRunSummary>();
    const acceptance = new Map<string, AcceptanceSummary>();
    for (const item of summary.data?.tasks ?? []) {
      if (item.latestRun) runs.set(item.taskId, item.latestRun);
      // 沒有任何條件時不顯示驗收進度
      if (item.acceptance.total > 0) acceptance.set(item.taskId, item.acceptance);
    }
    return { runs, acceptance };
  }, [summary.data]);
}
