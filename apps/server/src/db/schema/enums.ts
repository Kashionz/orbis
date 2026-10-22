// 資料庫列舉。值一律取自 @orbis/api-contract（其中一部分由 Rust 協定產生），不要另抄一份。

import {
  ACCEPTANCE_CRITERION_KINDS,
  DELEGATION_MODES,
  DISPATCH_STATUSES,
  GATE_DECISIONS,
  GATE_KINDS,
  GITHUB_WEBHOOK_DELIVERY_STATUSES,
  NEEDS_YOU_KINDS,
  PERMISSION_POLICIES,
  PULL_REQUEST_STATES,
  REVIEW_COMMENT_SIDES,
  ROLES,
  RUN_CONTROL_ACTIONS,
  RUN_STATUSES,
  RUNNER_KINDS,
  TASK_DONE_REASONS,
  TASK_STATUSES,
} from "@orbis/api-contract";
import { pgEnum } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ROLES);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUSES);
export const acceptanceCriterionKindEnum = pgEnum(
  "acceptance_criterion_kind",
  ACCEPTANCE_CRITERION_KINDS,
);
export const runStatusEnum = pgEnum("run_status", RUN_STATUSES);
export const permissionPolicyEnum = pgEnum("permission_policy", PERMISSION_POLICIES);
export const delegationModeEnum = pgEnum("delegation_mode", DELEGATION_MODES);
export const runnerKindEnum = pgEnum("runner_kind", RUNNER_KINDS);
export const gateKindEnum = pgEnum("gate_kind", GATE_KINDS);
export const gateDecisionEnum = pgEnum("gate_decision", GATE_DECISIONS);
export const needsYouKindEnum = pgEnum("needs_you_kind", NEEDS_YOU_KINDS);

export const dispatchStatusEnum = pgEnum("dispatch_status", DISPATCH_STATUSES);

export const taskDoneReasonEnum = pgEnum("task_done_reason", TASK_DONE_REASONS);
export const reviewCommentSideEnum = pgEnum("review_comment_side", REVIEW_COMMENT_SIDES);
export const runControlActionEnum = pgEnum("run_control_action", RUN_CONTROL_ACTIONS);
export const pullRequestStateEnum = pgEnum("pull_request_state", PULL_REQUEST_STATES);
export const githubWebhookDeliveryStatusEnum = pgEnum(
  "github_webhook_delivery_status",
  GITHUB_WEBHOOK_DELIVERY_STATUSES,
);
