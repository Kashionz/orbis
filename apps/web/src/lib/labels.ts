// 列舉值在 UI 上顯示的文字。名詞沿用 GLOSSARY 與 ARCHITECTURE。

import type {
  AcceptanceCriterionKind,
  AcceptanceCriterionResult,
  PermissionPolicy,
  Role,
  RunnerKind,
  RunStatus,
  TaskStatus,
} from "@orbis/api-contract";
import type { RunErrorCode, ToolCallStatus, ToolKind } from "@orbis/protocol";
import type { DiffFileChange } from "../api/schemas";

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
  internal: "內部錯誤",
};

export const DIFF_CHANGE_LABELS: Record<DiffFileChange, string> = {
  added: "新增",
  modified: "修改",
  deleted: "刪除",
  renamed: "改名",
};
