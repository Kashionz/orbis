// 共用列舉的 zod schema 與值陣列。DB 的 pgEnum 與 Web UI 都從這裡取值，不要另抄一份。
//
// - Run 狀態、Permission Policy、Delegation 模式、Runner 種類、Gate、Acceptance Criterion 類型、
//   Run 的來源、Verification 的結果由 Rust 協定定義（@orbis/protocol 產生），這裡只包成 zod。
// - 只有 Server↔Web 才用到的列舉（Task 狀態、Role 等）定義在這裡。

import {
  ACCEPTANCE_CRITERION_KINDS,
  DELEGATION_MODES,
  EFFORTS,
  GATE_DECISIONS,
  GATE_KINDS,
  LOCAL_MERGE_STRATEGIES,
  LOGIN_HINT_KINDS,
  MODEL_SOURCES,
  MODEL_TAGS,
  PERMISSION_POLICIES,
  PROMPT_DELIVERIES,
  PROMPT_SOURCES,
  REPO_KINDS,
  RUN_CONTROL_ACTIONS,
  RUN_ORIGINS,
  RUN_SETTING_NAMES,
  RUN_STATUSES,
  RUNNER_KINDS,
  TERMINAL_EXIT_REASONS,
  VERIFICATION_OUTCOMES,
} from "@orbis/protocol";
import { z } from "zod";

export {
  ACCEPTANCE_CRITERION_KINDS,
  DELEGATION_MODES,
  EFFORTS,
  GATE_DECISIONS,
  GATE_KINDS,
  LOCAL_MERGE_STRATEGIES,
  LOGIN_HINT_KINDS,
  MODEL_SOURCES,
  MODEL_TAGS,
  PERMISSION_POLICIES,
  PROMPT_DELIVERIES,
  PROMPT_SOURCES,
  REPO_KINDS,
  RUN_CONTROL_ACTIONS,
  RUN_ORIGINS,
  RUN_SETTING_NAMES,
  RUN_STATUSES,
  RUNNER_KINDS,
  TERMINAL_EXIT_REASONS,
  VERIFICATION_OUTCOMES,
};

export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

export const PermissionPolicy = z.enum(PERMISSION_POLICIES);
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const DelegationMode = z.enum(DELEGATION_MODES);
export type DelegationMode = z.infer<typeof DelegationMode>;

/** Runner 的種類；也用來表示 Run 要在哪裡跑（`local`＝我的電腦，`team`＝Team Runner）。 */
export const RunnerKind = z.enum(RUNNER_KINDS);
export type RunnerKind = z.infer<typeof RunnerKind>;

export const GateKind = z.enum(GATE_KINDS);
export type GateKind = z.infer<typeof GateKind>;

export const GateDecision = z.enum(GATE_DECISIONS);
export type GateDecision = z.infer<typeof GateDecision>;

/** Task 的狀態（ARCHITECTURE §5），依生命週期順序排列。 */
export const TASK_STATUSES = [
  "backlog",
  "ready",
  "planning",
  "plan_gate",
  "running",
  "verifying",
  "review_gate",
  "pr_open",
  "done",
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Acceptance Criterion 的類型（ARCHITECTURE §5.1）。 */
export const AcceptanceCriterionKind = z.enum(ACCEPTANCE_CRITERION_KINDS);
export type AcceptanceCriterionKind = z.infer<typeof AcceptanceCriterionKind>;

/** Member 在 Team 中的 Role（ARCHITECTURE §12.2），權限由高到低。 */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/**
 * Needs You 項目的種類：權限請求、待核准的 Gate、停下來的 Run，以及 Child Run 以 `ask_parent`
 * 提出、父 Run 的回合已經結束而改由人回答的問題（ARCHITECTURE §9）。
 */
export const NEEDS_YOU_KINDS = [
  "permission_request",
  "gate",
  "stopped_run",
  "child_question",
] as const;
export const NeedsYouKind = z.enum(NEEDS_YOU_KINDS);
export type NeedsYouKind = z.infer<typeof NeedsYouKind>;

/**
 * Dispatch 的狀態，由 Server 依協定的 frame 推進：送出 `dispatch_offer` → `offered`；
 * 收到 `dispatch_accept`／`dispatch_reject` → `accepted`／`rejected`；逾時未回應或心跳中斷 →
 * `expired`；Run 結束 → `completed`。
 */
export const DISPATCH_STATUSES = [
  "offered",
  "accepted",
  "rejected",
  "expired",
  "completed",
] as const;
export const DispatchStatus = z.enum(DISPATCH_STATUSES);
export type DispatchStatus = z.infer<typeof DispatchStatus>;

/**
 * Task 轉為 Done 的原因（ARCHITECTURE §11）：取自 GitHub Issue 關閉時的 `state_reason`；
 * 由 PR merge 而轉 Done 時為 `completed`。Task 離開 Done 時清空。
 */
export const TASK_DONE_REASONS = ["completed", "not_planned"] as const;
export const TaskDoneReason = z.enum(TASK_DONE_REASONS);
export type TaskDoneReason = z.infer<typeof TaskDoneReason>;

/** 行內留言在 diff 的哪一側：`old`＝修改前，`new`＝修改後。 */
export const REVIEW_COMMENT_SIDES = ["old", "new"] as const;
export const ReviewCommentSide = z.enum(REVIEW_COMMENT_SIDES);
export type ReviewCommentSide = z.infer<typeof ReviewCommentSide>;

/** 以 GitHub App 開出的 PR 的狀態。 */
export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;
export const PullRequestState = z.enum(PULL_REQUEST_STATES);
export type PullRequestState = z.infer<typeof PullRequestState>;

/** GitHub webhook delivery 的處理狀態（去重用）。 */
export const GITHUB_WEBHOOK_DELIVERY_STATUSES = ["processing", "completed"] as const;

/** Acceptance Criterion 最近一次判定的結果。`pending`＝尚未判定或程式碼變更後需要重新判定。 */
export const ACCEPTANCE_CRITERION_RESULTS = ["pending", "passed", "failed"] as const;
export const AcceptanceCriterionResult = z.enum(ACCEPTANCE_CRITERION_RESULTS);
export type AcceptanceCriterionResult = z.infer<typeof AcceptanceCriterionResult>;

/** Run 為什麼產生：人派工、Delegation、判定 Verification、@agent、Feedback Loop。 */
export const RunOrigin = z.enum(RUN_ORIGINS);
export type RunOrigin = z.infer<typeof RunOrigin>;

/** 送給 Agent 的 prompt 的來源（Review Gate 退回、Verification 重試、Feedback Loop 等）。 */
export const PromptSource = z.enum(PROMPT_SOURCES);
export type PromptSource = z.infer<typeof PromptSource>;

/** 一條條件的 Verification 結果。`error`＝無法判定（Server 算失敗，UI 另外標示）。 */
export const VerificationOutcome = z.enum(VERIFICATION_OUTCOMES);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

/** 一輪 Verification 的狀態。 */
export const VERIFICATION_STATUSES = ["running", "passed", "failed", "error", "canceled"] as const;
export const VerificationStatus = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/**
 * Verification 超過重試上限後人的決定（ARCHITECTURE §5.1）：附意見再試（次數重算）、
 * 略過失敗進入 Review Gate、中止。
 */
export const VERIFICATION_RESOLUTIONS = ["retry", "skip", "abort"] as const;
export const VerificationResolution = z.enum(VERIFICATION_RESOLUTIONS);
export type VerificationResolution = z.infer<typeof VerificationResolution>;

/** 通知的事件類型（ARCHITECTURE §12.3）。 */
export const NOTIFICATION_KINDS = [
  /** 權限請求（Needs You）。 */
  "permission_request",
  /** Gate 等待核准。 */
  "gate_pending",
  /** Verification 連續失敗達到上限。 */
  "verification_failed",
  /** Feedback Loop 達到次數上限。 */
  "feedback_limit_reached",
  "mentioned",
  "task_assigned",
  /** 自己的 Task 的 PR 被 merge。 */
  "task_merged",
  /** 自己的 Task 被退回（Gate 退回、PR 沒有 merge 就關閉）。 */
  "task_rejected",
  /** Run 停下來等人處理（例如 push 失敗）。 */
  "run_stopped",
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** 通知的發送管道（Channel）。Phase 1 只有 App 內與桌面推送。 */
export const NOTIFICATION_CHANNELS = ["in_app", "desktop"] as const;
export const NotificationChannel = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

/** @mention 出現的位置。 */
export const MENTION_SOURCES = ["task_comment", "review_comment", "collab_document"] as const;
export const MentionSource = z.enum(MENTION_SOURCES);
export type MentionSource = z.infer<typeof MentionSource>;

/** Task note 的來源：Agent 的 `update_task_note`，或 Feedback Loop 的自動修正紀錄。 */
export const TASK_NOTE_SOURCES = ["agent", "feedback_loop"] as const;
export const TaskNoteSource = z.enum(TASK_NOTE_SOURCES);
export type TaskNoteSource = z.infer<typeof TaskNoteSource>;

/** Feedback Loop 的觸發來源，兩者分開計數（ARCHITECTURE §5.2）。 */
export const FEEDBACK_SOURCES = ["review", "ci"] as const;
export const FeedbackSource = z.enum(FEEDBACK_SOURCES);
export type FeedbackSource = z.infer<typeof FeedbackSource>;

/**
 * 一次 Feedback Loop 自動修正的狀態：已開新的 Run 修正、修正已 push、失敗（沒有開成 Run，或 Run
 * 沒有 push 就結束）、已達次數上限而沒有送出。
 */
export const FEEDBACK_FIX_STATUSES = ["sent", "pushed", "failed", "limit_reached"] as const;
export const FeedbackFixStatus = z.enum(FEEDBACK_FIX_STATUSES);
export type FeedbackFixStatus = z.infer<typeof FeedbackFixStatus>;

/** Review Gate 留言的種類：diff 行內留言，或在 Preview 上點選元素的留言。 */
export const REVIEW_COMMENT_KINDS = ["diff", "preview"] as const;
export const ReviewCommentKind = z.enum(REVIEW_COMMENT_KINDS);
export type ReviewCommentKind = z.infer<typeof ReviewCommentKind>;

// 以下是新工作區介面後端缺口（協定 v3、API 版本 2）新增的列舉。

/** 推理強度：快速、標準、深度（協定的 Effort）。 */
export const Effort = z.enum(EFFORTS);
export type Effort = z.infer<typeof Effort>;

/** 執行中傳給 Agent 的訊息：排隊到回合結束（預設），或中斷目前的回合後送出。 */
export const PromptDelivery = z.enum(PROMPT_DELIVERIES);
export type PromptDelivery = z.infer<typeof PromptDelivery>;

/** Repo 的種類：GitHub repository，或本機 Repo（本機 git repository）。 */
export const RepoKind = z.enum(REPO_KINDS);
export type RepoKind = z.infer<typeof RepoKind>;

/** 本機 Repo 核准後合併到基準分支的方式（Project 設定）。 */
export const LocalMergeStrategy = z.enum(LOCAL_MERGE_STRATEGIES);
export type LocalMergeStrategy = z.infer<typeof LocalMergeStrategy>;

/** 模型目錄中 model 的標記。 */
export const ModelTag = z.enum(MODEL_TAGS);
export type ModelTag = z.infer<typeof ModelTag>;

/** 模型清單的來源：Agent Profile 的靜態清單，或最近一次真實 session 回報的 config option。 */
export const ModelSource = z.enum(MODEL_SOURCES);
export type ModelSource = z.infer<typeof ModelSource>;

/** 登入方式：Runner 代為登入（Desktop 執行），或在終端機執行 Agent 自己的 CLI。 */
export const LoginHintKind = z.enum(LOGIN_HINT_KINDS);
export type LoginHintKind = z.infer<typeof LoginHintKind>;

/** 執行中可以切換的設定。 */
export const RunSettingName = z.enum(RUN_SETTING_NAMES);
export type RunSettingName = z.infer<typeof RunSettingName>;

/** 終端機結束的原因（協定的 TerminalExitReason）。 */
export const TerminalExitReason = z.enum(TERMINAL_EXIT_REASONS);
export type TerminalExitReason = z.infer<typeof TerminalExitReason>;

/**
 * Run 停下來等人處理的原因（Needs You 的 `stopped_run`，UI 依代碼在地化）：
 * Verification 超過重試上限、push 失敗、開 PR 失敗、本機合併被擋下（工作目錄有變更或衝突）。
 */
export const STOPPED_RUN_REASONS = [
  "verification_limit",
  "push_failed",
  "pr_open_failed",
  "local_merge_blocked",
] as const;
export const StoppedRunReason = z.enum(STOPPED_RUN_REASONS);
export type StoppedRunReason = z.infer<typeof StoppedRunReason>;

/** Task 中的角色（Task 分享）：擁有者、可操作、可檢視。 */
export const TASK_SHARE_ROLES = ["owner", "edit", "view"] as const;
export const TaskShareRole = z.enum(TASK_SHARE_ROLES);
export type TaskShareRole = z.infer<typeof TaskShareRole>;

/** 加入或邀請時可以給的 Task 角色（擁有者只能轉移，不能邀請）。 */
export const TaskInviteRole = TaskShareRole.exclude(["owner"]);
export type TaskInviteRole = z.infer<typeof TaskInviteRole>;

/**
 * Task 的一般存取：僅受邀成員、Team 可檢視、Team 可操作（預設，和沒有 Task 分享時的行為相同）。
 * 限制時，不在 Task 成員中的人在這個 Task 上的權限降到對應的程度；Owner、Admin 不受影響。
 */
export const GENERAL_ACCESS_LEVELS = ["invited", "team_view", "team_edit"] as const;
export const GeneralAccess = z.enum(GENERAL_ACCESS_LEVELS);
export type GeneralAccess = z.infer<typeof GeneralAccess>;

/**
 * 目前登入者在某個 Task 上的有效權限（ADR-0012）：`manage`＝可以操作也能管理分享（Task 擁有者、
 * Admin 以上），`edit`＝可以操作（編輯、派工、核准關卡、傳訊息），`view`＝只能看。
 * Admin 層級的能力（權限策略、設定信任、Team Runner、Project 設定）不受 Task 角色影響。
 */
export const TASK_ACCESS_LEVELS = ["manage", "edit", "view"] as const;
export const TaskAccess = z.enum(TASK_ACCESS_LEVELS);
export type TaskAccess = z.infer<typeof TaskAccess>;

/** 預覽邀請的期限。 */
export const PREVIEW_INVITE_DURATIONS = ["1h", "24h", "7d"] as const;
export const PreviewInviteDuration = z.enum(PREVIEW_INVITE_DURATIONS);
export type PreviewInviteDuration = z.infer<typeof PreviewInviteDuration>;

/** 預覽邀請的狀態：有效、過期（含預覽停止或 Worktree 封存後失效）、已撤銷。 */
export const PREVIEW_INVITE_STATUSES = ["active", "expired", "revoked"] as const;
export const PreviewInviteStatus = z.enum(PREVIEW_INVITE_STATUSES);
export type PreviewInviteStatus = z.infer<typeof PreviewInviteStatus>;
