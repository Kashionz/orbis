// 工作區的路由狀態（純函式）。
//
// - `/tasks/$taskKey?run&tab&focus`：工作區本身。
// - `/runs/$runId`、`/runs/$runId/review`：深連結（Desktop 通知、Needs You、通知中心），原地渲染同一個工作區。
//   舊的 `?tab=verification`（Needs You 的「Run 已停下」）對應 Task 分頁的驗收。

import type { Run } from "@orbis/api-contract";

export const WORKSPACE_TABS = ["task", "diff", "preview", "terminal"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/** 捲到 Task 分頁的驗收區塊。 */
export const VERIFICATION_FOCUS = "verification";

export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return typeof value === "string" && (WORKSPACE_TABS as readonly string[]).includes(value);
}

export interface WorkspaceView {
  tab: WorkspaceTab | undefined;
  focus: string | undefined;
}

/** `/runs/$runId` 與 `/runs/$runId/review` 的 search 對應到工作區的分頁與捲動目標。 */
export function runRouteView(
  route: "run" | "review",
  search: { tab?: unknown; focus?: unknown },
): WorkspaceView {
  const focus = typeof search.focus === "string" ? search.focus : undefined;
  if (route === "review") return { tab: "diff", focus };
  if (search.tab === "verification") return { tab: "task", focus: focus ?? VERIFICATION_FOCUS };
  if (isWorkspaceTab(search.tab)) return { tab: search.tab, focus };
  return { tab: undefined, focus };
}

/** 主 Run：人派工或 Feedback Loop 開的頂層 Run（不含 @agent 的 consult Run 與 Child Run）。 */
export function isMainRun(run: Pick<Run, "parentRunId" | "origin">): boolean {
  return run.parentRunId === null && run.origin !== "mention";
}

/**
 * 工作區要顯示的 Run：指定的 Run（在這個 Task 中找得到時），否則最新的主 Run；
 * 還沒有任何主 Run 時為 null。
 */
export function pickRun<R extends Pick<Run, "id" | "parentRunId" | "origin" | "createdAt">>(
  runs: readonly R[],
  requested: string | undefined,
): R | null {
  if (requested) {
    const found = runs.find((run) => run.id === requested);
    if (found) return found;
  }
  let latest: R | null = null;
  for (const run of runs) {
    if (!isMainRun(run)) continue;
    if (!latest || run.createdAt > latest.createdAt) latest = run;
  }
  return latest;
}
