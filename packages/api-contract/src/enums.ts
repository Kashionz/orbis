// 共用列舉的 zod schema 與值陣列。DB 的 pgEnum 與 Web UI 都從這裡取值，不要另抄一份。
//
// - Run 狀態、Permission Policy、Delegation 模式、Runner 種類、Gate 由 Rust 協定定義
//   （@orbis/protocol 產生），這裡只包成 zod。
// - 只有 Server↔Web 才用到的列舉（Task 狀態、Role 等）定義在這裡。

import {
  DELEGATION_MODES,
  GATE_DECISIONS,
  GATE_KINDS,
  PERMISSION_POLICIES,
  RUN_CONTROL_ACTIONS,
  RUN_STATUSES,
  RUNNER_KINDS,
} from "@orbis/protocol";
import { z } from "zod";

export {
  DELEGATION_MODES,
  GATE_DECISIONS,
  GATE_KINDS,
  PERMISSION_POLICIES,
  RUN_CONTROL_ACTIONS,
  RUN_STATUSES,
  RUNNER_KINDS,
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
export const ACCEPTANCE_CRITERION_KINDS = ["command", "agent", "browser", "manual"] as const;
export const AcceptanceCriterionKind = z.enum(ACCEPTANCE_CRITERION_KINDS);
export type AcceptanceCriterionKind = z.infer<typeof AcceptanceCriterionKind>;

/** Member 在 Team 中的 Role（ARCHITECTURE §12.2），權限由高到低。 */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/** Needs You 項目的種類：權限請求、待核准的 Gate、停下來的 Run。 */
export const NEEDS_YOU_KINDS = ["permission_request", "gate", "stopped_run"] as const;
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
