// 工作區路由的 search 參數（`/tasks/$taskKey`、`/runs/$runId`）。

/** 右側面板的分頁。 */
export const WORKSPACE_TABS = ["task", "diff", "preview", "terminal"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/**
 * `/runs/$runId?tab=` 另外接受舊的分頁名稱：Desktop 的桌面通知與 Needs You 用
 * `?tab=verification` 直接開 Verification 的決定（ARCHITECTURE §16.1）。
 */
export const RUN_LINK_TABS = [...WORKSPACE_TABS, "timeline", "verification"] as const;
export type RunLinkTab = (typeof RUN_LINK_TABS)[number];

export interface TaskWorkspaceSearch {
  /** 要顯示的 Run；省略時顯示最新的主 Run。 */
  run?: string;
  tab?: WorkspaceTab;
  /** 要捲到的事件（時間軸項目 key）。 */
  focus?: string;
}

export interface RunLinkSearch {
  focus?: string;
  tab?: RunLinkTab;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function parseTaskWorkspaceSearch(search: Record<string, unknown>): TaskWorkspaceSearch {
  return {
    ...(typeof search.run === "string" && search.run !== "" && { run: search.run }),
    ...(isOneOf(WORKSPACE_TABS, search.tab) && { tab: search.tab }),
    ...(typeof search.focus === "string" && { focus: search.focus }),
  };
}

export function parseRunLinkSearch(search: Record<string, unknown>): RunLinkSearch {
  return {
    ...(typeof search.focus === "string" && { focus: search.focus }),
    ...(isOneOf(RUN_LINK_TABS, search.tab) && { tab: search.tab }),
  };
}
