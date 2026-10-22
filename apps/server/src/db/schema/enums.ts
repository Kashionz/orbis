// 資料庫列舉。值一律取自 @orbis/api-contract（其中一部分由 Rust 協定產生），不要另抄一份。

import {
  ACCEPTANCE_CRITERION_KINDS,
  DELEGATION_MODES,
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

// TODO(contract): Dispatch 狀態還沒有出現在 @orbis/api-contract 或協定中。
// 協定加入 DispatchOffer／Accept／Reject 後，改用契約匯出的值陣列。
export const DISPATCH_STATUSES = ["offered", "accepted", "rejected", "expired", "completed"] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];
export const dispatchStatusEnum = pgEnum("dispatch_status", DISPATCH_STATUSES);
