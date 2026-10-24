// 看板的列表與分欄（純函式）：篩選、依狀態分組、每一列要顯示的資料、欄寬。

import { type DraftTask, TASK_STATUSES, type Task, type TaskStatus } from "@orbis/api-contract";
import type { GateKind, RunStatus } from "@orbis/protocol";
import { unfinishedDependencies } from "../../lib/dependencies";

export const BOARD_FILTERS = ["all", "needs", "mine"] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

export const BOARD_VIEWS = ["list", "columns"] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

/** 列表與卡片上的 Run 摘要（最新的主 Run）。 */
export interface BoardRunSummary {
  id: string;
  status: RunStatus;
  gate: GateKind | null;
  agent: string;
}

/** 驗收進度。 */
export interface AcceptanceSummary {
  passed: number;
  failed: number;
  total: number;
}

export type BoardRow =
  | {
      kind: "task";
      key: string;
      task: Task;
      /** 有等待目前 Member 處理的項目。 */
      needs: boolean;
      run: BoardRunSummary | null;
      /** Run 正在執行（顯示脈動的點）；待我處理時不算。 */
      live: boolean;
      acceptance: AcceptanceSummary | null;
      /** 依賴中還沒 Done 的 Task Key。 */
      blockedBy: string[];
    }
  | { kind: "draft"; key: string; draft: DraftTask };

export interface BoardGroup {
  status: TaskStatus;
  rows: BoardRow[];
}

export interface BoardInput {
  tasks: readonly Task[];
  drafts: readonly DraftTask[];
  /** 有 Needs You 項目的 Task。 */
  needsTaskIds: ReadonlySet<string>;
  runs: ReadonlyMap<string, BoardRunSummary>;
  acceptance: ReadonlyMap<string, AcceptanceSummary>;
  meId: string | null;
  filter: BoardFilter;
}

const LIVE_STATUSES: readonly RunStatus[] = ["starting", "running", "verifying"];

/** Task 的列。 */
function taskRow(task: Task, input: BoardInput): BoardRow {
  const needs = input.needsTaskIds.has(task.id);
  const run = input.runs.get(task.id) ?? null;
  return {
    kind: "task",
    key: task.id,
    task,
    needs,
    run,
    live: !needs && run !== null && LIVE_STATUSES.includes(run.status),
    acceptance: input.acceptance.get(task.id) ?? null,
    blockedBy: unfinishedDependencies(task, input.tasks).map((t) => t.key),
  };
}

function visible(task: Task, input: BoardInput): boolean {
  switch (input.filter) {
    case "needs":
      return input.needsTaskIds.has(task.id);
    case "mine":
      return input.meId !== null && task.assigneeMemberId === input.meId;
    default:
      return true;
  }
}

/**
 * 依狀態分組，順序同 Task 的生命週期。Draft Task 只在「全部」時列在待辦的最後。
 * `includeEmpty` 為 false 時拿掉沒有任何列的組（列表檢視）；分欄檢視每一欄都要。
 */
export function boardGroups(input: BoardInput, includeEmpty: boolean): BoardGroup[] {
  const groups = TASK_STATUSES.map((status) => ({
    status,
    rows: input.tasks
      .filter((task) => task.status === status && visible(task, input))
      .map((task) => taskRow(task, input)),
  }));
  if (input.filter === "all" && input.drafts.length > 0) {
    const backlog = groups.find((g) => g.status === "backlog");
    backlog?.rows.push(
      ...input.drafts.map((draft): BoardRow => ({ kind: "draft", key: draft.id, draft })),
    );
  }
  return includeEmpty ? groups : groups.filter((g) => g.rows.length > 0);
}

/** 「待我處理」篩選的數字。 */
export function needsCount(input: Pick<BoardInput, "tasks" | "needsTaskIds">): number {
  return input.tasks.filter((t) => input.needsTaskIds.has(t.id)).length;
}

/** 可以在這一組直接新增 Task（待辦、就緒）。 */
export function canAddTo(status: TaskStatus): boolean {
  return status === "backlog" || status === "ready";
}

/** 列表檢視寬度夠時多顯示代理與更新時間兩欄。 */
export const BOARD_WIDE_MIN = 820;

export function boardListColumns(width: number | null): { wide: boolean; template: string } {
  const wide = (width ?? Number.POSITIVE_INFINITY) >= BOARD_WIDE_MIN;
  return {
    wide,
    template: wide
      ? "10px 60px minmax(160px,1fr) 112px 120px 72px 120px 64px"
      : "10px 60px minmax(120px,1fr) 96px 64px 104px",
  };
}

/** 驗收進度條的寬度（百分比）與顏色：有失敗時是紅色。 */
export function acceptanceBar(summary: AcceptanceSummary): { percent: number; failed: boolean } {
  return {
    percent: summary.total === 0 ? 0 : Math.round((summary.passed / summary.total) * 100),
    failed: summary.failed > 0,
  };
}
