// 側欄 Task 分區的純邏輯：依狀態分組、搜尋、狀態點的顏色與閃爍。

import type { NeedsYouItem, Task, TaskStatus } from "@orbis/api-contract";

export const SIDEBAR_SECTIONS = ["active", "pr", "ready", "backlog", "done"] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

const SECTION_STATUSES: Record<SidebarSection, readonly TaskStatus[]> = {
  active: ["planning", "plan_gate", "running", "verifying", "review_gate"],
  pr: ["pr_open"],
  ready: ["ready"],
  backlog: ["backlog"],
  done: ["done"],
};

/** 預設收合的分區。 */
export const DEFAULT_COLLAPSED: readonly SidebarSection[] = ["backlog", "done"];

/** Task 狀態點的顏色（README：TS 對照表）。 */
export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  backlog: "var(--o8b9098)",
  ready: "var(--o8b9098)",
  planning: "var(--o7fb0fa)",
  plan_gate: "var(--od9a845)",
  running: "var(--o7fb0fa)",
  verifying: "var(--o7fb0fa)",
  review_gate: "var(--od9a845)",
  pr_open: "var(--o4fb86a)",
  done: "var(--o8b9098)",
};

/** 正在執行（狀態點閃爍）的 Task 狀態。 */
const LIVE_STATUSES: readonly TaskStatus[] = ["planning", "running", "verifying"];

export interface SidebarRow {
  task: Task;
  /** 有待我處理的項目（權限請求、Gate 等）。 */
  needsYou: boolean;
  live: boolean;
  dotColor: string;
}

export interface SidebarGroup {
  section: SidebarSection;
  rows: SidebarRow[];
}

/** 搜尋字串比對 Task Key 或標題（不分大小寫）。 */
export function matchesSearch(task: Pick<Task, "key" | "title">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return task.key.toLowerCase().includes(q) || task.title.toLowerCase().includes(q);
}

export function sidebarGroups(
  tasks: readonly Task[],
  needsYou: readonly NeedsYouItem[],
  query: string,
): SidebarGroup[] {
  const needsTaskIds = new Set(needsYou.map((item) => item.taskId));
  return SIDEBAR_SECTIONS.map((section) => ({
    section,
    rows: tasks
      .filter(
        (task) => SECTION_STATUSES[section].includes(task.status) && matchesSearch(task, query),
      )
      .map((task) => {
        const needs = needsTaskIds.has(task.id);
        return {
          task,
          needsYou: needs,
          live: !needs && LIVE_STATUSES.includes(task.status),
          dotColor: needs ? "var(--od9a845)" : TASK_STATUS_COLORS[task.status],
        };
      }),
  })).filter((group) => group.rows.length > 0);
}
