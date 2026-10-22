// 資料庫列舉。值一律取自 @orbis/api-contract（其中一部分由 Rust 協定產生），不要另抄一份。

import {
  ACCEPTANCE_CRITERION_KINDS,
  DELEGATION_MODES,
  DISPATCH_STATUSES,
  GATE_DECISIONS,
  GATE_KINDS,
  NEEDS_YOU_KINDS,
  PERMISSION_POLICIES,
  ROLES,
  RUN_STATUSES,
  RUNNER_KINDS,
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
