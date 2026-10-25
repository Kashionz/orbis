// Task 狀態機（ARCHITECTURE §5）。純資料與純函式：哪個觸發來源可以把 Task 從哪個狀態轉到哪個狀態。
// 寫入資料庫由 TaskLifecycleService 負責，一律先經過這裡的檢查。
// 手動轉換（看板拖曳）以契約的 MANUAL_TASK_TRANSITIONS 為準，與 Web 共用。

import { MANUAL_TASK_TRANSITIONS, TASK_STATUSES, type TaskStatus } from "@orbis/api-contract";

/** 觸發狀態轉換的來源。 */
export const TRANSITION_TRIGGERS = [
  /** 使用者手動轉換（看板拖曳）。 */
  "manual",
  /** 派工。 */
  "dispatch",
  /** Planning 的結果（B1 為「直接通過」的掛鉤）。 */
  "planning",
  /** Runner 回報的 Run 狀態（Agent 做完、進入 Gate）。 */
  "run",
  /** Verification 的結果（B1 為「直接通過」的掛鉤）。 */
  "verification",
  /** 人對 Gate 的決定。 */
  "gate",
  /** Run 失敗或被中止。 */
  "run_stopped",
  /** GitHub 的 PR webhook（merge、未 merge 就關閉），由 D 軌呼叫。 */
  "pull_request",
  /** GitHub 的 Issue webhook（關閉、重開），由 D 軌呼叫。 */
  "issue",
  /** Feedback Loop 的修正 Run（ARCHITECTURE §5.2）。 */
  "feedback_loop",
  /** 本機 Repo 核准後，Runner 把 Run 的分支合併到本機 checkout 的基準分支（`local_merged`，ADR-0013）。 */
  "local_merge",
] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

export interface TaskTransition {
  from: TaskStatus;
  to: TaskStatus;
  trigger: TransitionTrigger;
  /** 給人看的說明。 */
  description: string;
}

/** Run 進行中的狀態：Run 失敗或中止時，Task 從這些狀態回到 Ready。 */
const IN_FLIGHT: readonly TaskStatus[] = [
  "planning",
  "plan_gate",
  "running",
  "verifying",
  "review_gate",
];

/** Done 以外的狀態：Issue 關閉、PR merge 時都可以轉成 Done（有進行中的 Run 時由服務層拒絕）。 */
const NOT_DONE: readonly TaskStatus[] = [
  "backlog",
  "ready",
  "planning",
  "plan_gate",
  "running",
  "verifying",
  "review_gate",
  "pr_open",
];

/** 所有合法的轉換。不在表中的轉換一律拒絕。 */
export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  ...TASK_STATUSES.flatMap((from) =>
    MANUAL_TASK_TRANSITIONS[from].map(
      (to): TaskTransition => ({ from, to, trigger: "manual", description: "看板上手動移動" }),
    ),
  ),
  { from: "ready", to: "planning", trigger: "dispatch", description: "派工" },
  { from: "planning", to: "running", trigger: "planning", description: "Plan Gate 關閉或直接通過" },
  { from: "planning", to: "plan_gate", trigger: "run", description: "plan 產出，等待核准" },
  { from: "plan_gate", to: "running", trigger: "gate", description: "plan 核准" },
  { from: "plan_gate", to: "planning", trigger: "gate", description: "plan 退回" },
  { from: "running", to: "verifying", trigger: "run", description: "Agent 回報完成" },
  {
    from: "verifying",
    to: "review_gate",
    trigger: "verification",
    description: "Verification 全數通過",
  },
  {
    from: "verifying",
    to: "running",
    trigger: "verification",
    description: "Verification 失敗，送回重試",
  },
  { from: "review_gate", to: "running", trigger: "gate", description: "Review Gate 退回" },
  { from: "review_gate", to: "pr_open", trigger: "gate", description: "Review Gate 核准" },
  {
    from: "review_gate",
    to: "done",
    trigger: "gate",
    description: "Review Gate 結束（沒有變更）：diff 為空，不 push、不開 PR",
  },
  {
    from: "review_gate",
    to: "done",
    trigger: "local_merge",
    description: "本機 Repo 的本機合併完成（不 push、不開 PR）",
  },
  {
    from: "pr_open",
    to: "review_gate",
    trigger: "pull_request",
    description: "PR 未 merge 就關閉",
  },
  {
    from: "review_gate",
    to: "pr_open",
    trigger: "pull_request",
    description: "PR 重新打開",
  },
  { from: "done", to: "backlog", trigger: "issue", description: "Issue 重開" },
  {
    from: "pr_open",
    to: "running",
    trigger: "feedback_loop",
    description: "Feedback Loop：PR 上的回饋送回 Agent 修正",
  },
  {
    from: "verifying",
    to: "pr_open",
    trigger: "feedback_loop",
    description:
      "Feedback Loop 的修正通過 Verification 直接 push（不經過 Review Gate），或 Run 沒有 push 就結束",
  },
  {
    from: "running",
    to: "pr_open",
    trigger: "feedback_loop",
    description: "Feedback Loop 的修正 Run 沒有 push 就結束，PR 維持原樣",
  },
  ...IN_FLIGHT.map(
    (from): TaskTransition => ({
      from,
      to: "ready",
      trigger: "run_stopped",
      description: "Run 失敗或被中止",
    }),
  ),
  ...NOT_DONE.map(
    (from): TaskTransition => ({
      from,
      to: "done",
      trigger: "issue",
      description: "Issue 關閉",
    }),
  ),
  // PR merge 通常發生在 PR Open；Task 被手動移回其他狀態後 PR 才 merge 時也轉成 Done
  // （有進行中的 Run 時由服務層拒絕）。
  ...NOT_DONE.map(
    (from): TaskTransition => ({
      from,
      to: "done",
      trigger: "pull_request",
      description: "PR merge",
    }),
  ),
];

export function findTransition(
  from: TaskStatus,
  to: TaskStatus,
  trigger: TransitionTrigger,
): TaskTransition | undefined {
  return TASK_TRANSITIONS.find((t) => t.from === from && t.to === to && t.trigger === trigger);
}

export function canTransition(
  from: TaskStatus,
  to: TaskStatus,
  trigger: TransitionTrigger,
): boolean {
  return findTransition(from, to, trigger) !== undefined;
}

/** Task 是否處在有 Run 進行中的狀態。 */
export function isInFlight(status: TaskStatus): boolean {
  return IN_FLIGHT.includes(status);
}
