// 看板每一列的 Run 與驗收進度。
//
// 後端有 board-summary 之前（TODO(backend, board-summary)），真實模式逐 Task 取得 Run 與
// Acceptance Criterion：只對畫面上看得到的列，30 秒內不重新取得（協調者 Q6）。

import type { AcceptanceCriterion, Run } from "@orbis/api-contract";
import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiRequest } from "../../api/client";
import { acceptanceCriteriaQuery, POLL_INTERVAL_MS, taskRunsQuery } from "../../api/resources";
import { draftPath } from "../run/types";
import { isMainRun } from "../run/workspace/route-state";
import type { AcceptanceSummary, BoardRunSummary } from "./board-model";
import { BOARD_SUMMARY_ROUTE, BoardSummaryResponse } from "./types";

/** 逐 Task 取得時的快取時間。 */
const FALLBACK_STALE_MS = 30_000;

export const boardSummaryQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "board-summary"] as const,
    queryFn: ({ signal }) =>
      apiRequest(draftPath(BOARD_SUMMARY_ROUTE, { projectId }), BoardSummaryResponse, { signal }),
    refetchInterval: POLL_INTERVAL_MS,
  });

export interface BoardSummaries {
  runs: ReadonlyMap<string, BoardRunSummary>;
  acceptance: ReadonlyMap<string, AcceptanceSummary>;
}

/** 最新主 Run 的摘要。Gate 從 Run 的狀態看不出種類，`awaiting_gate` 時依 Task 的狀態判斷。 */
export function latestRunSummary(runs: readonly Run[], taskStatus: string): BoardRunSummary | null {
  let latest: Run | null = null;
  for (const run of runs) {
    if (isMainRun(run) && (!latest || run.createdAt > latest.createdAt)) latest = run;
  }
  if (!latest) return null;
  const gate =
    latest.status !== "awaiting_gate"
      ? null
      : taskStatus === "plan_gate"
        ? "plan"
        : taskStatus === "review_gate"
          ? "review"
          : null;
  return { id: latest.id, status: latest.status, gate, agent: latest.agent };
}

export function acceptanceSummary(criteria: readonly AcceptanceCriterion[]): AcceptanceSummary {
  return {
    passed: criteria.filter((c) => c.result === "passed").length,
    failed: criteria.filter((c) => c.result === "failed").length,
    total: criteria.length,
  };
}

/**
 * 看板的 Run 與驗收摘要。`summaryAvailable` 為 true（後端有 board-summary）時一次取得；
 * 否則只為 `visible` 中的 Task 逐一取得。
 */
export function useBoardSummaries(
  projectId: string,
  visible: readonly { id: string; status: string }[],
  summaryAvailable: boolean,
): BoardSummaries {
  const summary = useQuery({ ...boardSummaryQuery(projectId), enabled: summaryAvailable });
  const fallback = !summaryAvailable;
  const runData = useQueries({
    queries: visible.map((task) => ({
      ...taskRunsQuery(task.id),
      enabled: fallback,
      staleTime: FALLBACK_STALE_MS,
      refetchInterval: false as const,
    })),
    combine: dataOf<Run[]>,
  });
  const criteriaData = useQueries({
    queries: visible.map((task) => ({
      ...acceptanceCriteriaQuery(task.id),
      enabled: fallback,
      staleTime: FALLBACK_STALE_MS,
    })),
    combine: dataOf<AcceptanceCriterion[]>,
  });

  return useMemo(() => {
    const runs = new Map<string, BoardRunSummary>();
    const acceptance = new Map<string, AcceptanceSummary>();
    if (summary.data) {
      for (const item of summary.data) {
        if (item.latestRun) runs.set(item.taskId, item.latestRun);
        acceptance.set(item.taskId, item.acceptance);
      }
      return { runs, acceptance };
    }
    visible.forEach((task, index) => {
      const taskRuns = runData[index];
      const criteria = criteriaData[index];
      const run = taskRuns ? latestRunSummary(taskRuns, task.status) : null;
      if (run) runs.set(task.id, run);
      if (criteria && criteria.length > 0) acceptance.set(task.id, acceptanceSummary(criteria));
    });
    return { runs, acceptance };
  }, [summary.data, visible, runData, criteriaData]);
}

function dataOf<T>(results: readonly { data: T | undefined }[]): (T | undefined)[] {
  return results.map((result) => result.data);
}
