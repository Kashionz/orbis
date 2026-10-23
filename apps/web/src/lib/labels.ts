// 列舉值在 UI 上顯示的文字。名詞沿用 GLOSSARY 與 ARCHITECTURE。

import type {
  AcceptanceCriterionKind,
  AcceptanceCriterionResult,
  DelegationMode,
  DiffFileChange,
  NotificationKind,
  PermissionPolicy,
  QueueWaitingReason,
  READY_REQUIREMENTS,
  Role,
  RunnerKind,
  RunOrigin,
  RunStatus,
  TaskDoneReason,
  TaskStatus,
  VerificationResolution,
  VerificationStatus,
} from "@orbis/api-contract";
import type {
  MergeOutcome,
  PermissionPurpose,
  PlanSource,
  PreviewStopReason,
  PromptSource,
  RunErrorCode,
  ToolCallStatus,
  ToolKind,
  VerificationOutcome,
} from "@orbis/protocol";

/** 看板欄位標題，沿用 ARCHITECTURE §5 的狀態名稱。 */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  planning: "Planning",
  plan_gate: "Plan Gate",
  running: "Running",
  verifying: "Verifying",
  review_gate: "Review Gate",
  pr_open: "PR Open",
  done: "Done",
};

/** Done 的關閉原因（ARCHITECTURE §11），看板與 Task 頁以不同標記區分。 */
export const TASK_DONE_REASON_LABELS: Record<TaskDoneReason, string> = {
  completed: "已完成",
  not_planned: "不處理",
};

/** Task 進入 Ready 的條件（ARCHITECTURE §5），Server 回 `missing` 時列出缺少的項目。 */
export const READY_REQUIREMENT_LABELS: Record<(typeof READY_REQUIREMENTS)[number], string> = {
  repo: "指定 Repo",
  description: "描述或 Spec",
  acceptance_criteria: "至少一條 Acceptance Criterion",
};

/** 權限請求的用途（ARCHITECTURE §6.2、§8）。 */
export const PERMISSION_PURPOSE_LABELS: Record<PermissionPurpose, string> = {
  tool: "權限請求",
  config_trust: "設定的信任核准",
  agent_settings_changed: "Agent 設定檔變更確認",
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "排隊中",
  dispatched: "已派工",
  starting: "啟動中",
  running: "執行中",
  verifying: "Verification 中",
  awaiting_permission: "等待權限回覆",
  rate_limited: "Rate limit",
  awaiting_gate: "等待 Gate",
  completed: "已完成",
  failed: "失敗",
  canceled: "已中止",
};

export const RUNNER_KIND_LABELS: Record<RunnerKind, string> = {
  local: "我的電腦",
  team: "Team Runner",
};

export const PERMISSION_POLICY_LABELS: Record<PermissionPolicy, string> = {
  manual: "manual：每個操作都問我",
  auto: "auto：Worktree 內自動允許，其他問我",
  yolo: "yolo：全部自動允許",
};

export const AC_KIND_LABELS: Record<AcceptanceCriterionKind, string> = {
  command: "command：執行指令",
  agent: "agent：由 Agent 判定",
  browser: "browser：操作 Preview",
  manual: "manual：人工打勾",
};

export const AC_RESULT_LABELS: Record<AcceptanceCriterionResult, string> = {
  pending: "尚未判定",
  passed: "通過",
  failed: "失敗",
};

export const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  read: "讀取",
  edit: "編輯",
  delete: "刪除",
  move: "移動",
  search: "搜尋",
  execute: "執行",
  think: "思考",
  fetch: "擷取",
  other: "其他",
};

export const TOOL_CALL_STATUS_LABELS: Record<ToolCallStatus, string> = {
  pending: "等待中",
  in_progress: "進行中",
  completed: "完成",
  failed: "失敗",
};

export const RUN_ERROR_LABELS: Record<RunErrorCode, string> = {
  agent_start_failed: "Agent 無法啟動",
  agent_crashed: "Agent 異常結束",
  agent_error: "Agent 回報錯誤",
  worktree_failed: "Worktree 建立失敗",
  setup_failed: "Worktree 設定失敗",
  git_failed: "git 操作失敗",
  path_too_long: "路徑太長",
  merge_child_conflict: "合併 Child Run 時的衝突未解決",
  session_resume_failed: "無法恢復原本的 session",
  internal: "內部錯誤",
};

export const DIFF_CHANGE_LABELS: Record<DiffFileChange, string> = {
  added: "新增",
  modified: "修改",
  deleted: "刪除",
  renamed: "改名",
};

/** Run 為什麼產生（Child Run 樹與 Run 頁標示）。 */
export const RUN_ORIGIN_LABELS: Record<RunOrigin, string> = {
  dispatch: "派工",
  delegation: "Delegation",
  verification: "Verification",
  mention: "@agent",
  feedback_loop: "Feedback Loop",
};

export const DELEGATION_MODE_LABELS: Record<DelegationMode, string> = {
  consult: "consult（唯讀）",
  branch: "branch（子分支）",
};

/** 送給 Agent 的 prompt 的來源。 */
export const PROMPT_SOURCE_LABELS: Record<PromptSource, string> = {
  user: "派工",
  plan_gate: "Plan Gate 退回",
  review_gate: "Review Gate 退回",
  verification_retry: "Verification 重試",
  feedback_review: "Feedback Loop（review 留言）",
  feedback_ci: "Feedback Loop（CI 失敗）",
  child_question: "回答 Child Run 的問題",
};

export const PLAN_SOURCE_LABELS: Record<PlanSource, string> = {
  plan_mode: "plan 模式",
  prompt_fallback: "回合最後的訊息",
};

/** 一條條件的 Verification 結果。 */
export const VERIFICATION_OUTCOME_LABELS: Record<VerificationOutcome, string> = {
  passed: "通過",
  failed: "失敗",
  error: "無法判定",
};

/** 一輪 Verification 的狀態。 */
export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  running: "進行中",
  passed: "通過",
  failed: "失敗",
  error: "無法判定",
  canceled: "已中止",
};

/** Verification 超過重試上限後人的決定。 */
export const VERIFICATION_RESOLUTION_LABELS: Record<VerificationResolution, string> = {
  retry: "附意見再試",
  skip: "略過失敗，進入 Review Gate",
  abort: "中止",
};

export const MERGE_OUTCOME_LABELS: Record<MergeOutcome, string> = {
  merged: "已合併",
  conflict: "有衝突",
};

export const PREVIEW_STOP_REASON_LABELS: Record<PreviewStopReason, string> = {
  exited: "程序已結束",
  ready_timeout: "等待就緒逾時",
  spawn_failed: "無法啟動",
};

/** 通知的事件類型（通知中心與通知設定）。 */
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  permission_request: "權限請求",
  gate_pending: "Gate 等待核准",
  verification_failed: "Verification 連續失敗",
  feedback_limit_reached: "Feedback Loop 達到次數上限",
  mentioned: "被 @mention",
  task_assigned: "被指派 Task",
  task_merged: "自己的 Task 被 merge",
  task_rejected: "自己的 Task 被退回",
  run_stopped: "Run 停下來等人處理",
};

/** Team Runner 佇列中的 Run 在等什麼。 */
export const QUEUE_WAITING_REASON_LABELS: Record<QueueWaitingReason, string> = {
  no_runner: "沒有在線的 Runner",
  agent_unavailable: "沒有 Runner 能跑這個 Agent",
  concurrency_limit: "Credential 已達並行上限",
  rate_limited: "Credential 在 rate limit 中",
};
