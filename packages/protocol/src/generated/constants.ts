// 由 crates/orbis-protocol 產生（cargo gen-protocol），不可手改。
import type { DelegationMode } from "./DelegationMode";
import type { GateDecision } from "./GateDecision";
import type { GateKind } from "./GateKind";
import type { PermissionPolicy } from "./PermissionPolicy";
import type { RunStatus } from "./RunStatus";
import type { RunnerKind } from "./RunnerKind";

export const PROTOCOL_VERSION = 1;

export const RUN_STATUSES = ["queued", "dispatched", "starting", "running", "awaiting_permission", "rate_limited", "awaiting_gate", "completed", "failed", "canceled"] as const satisfies readonly RunStatus[];

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "canceled"] as const satisfies readonly RunStatus[];

export const PERMISSION_POLICIES = ["manual", "auto", "yolo"] as const satisfies readonly PermissionPolicy[];

export const DELEGATION_MODES = ["consult", "branch"] as const satisfies readonly DelegationMode[];

export const RUNNER_KINDS = ["local", "team"] as const satisfies readonly RunnerKind[];

export const GATE_KINDS = ["plan", "review"] as const satisfies readonly GateKind[];

export const GATE_DECISIONS = ["approved", "rejected"] as const satisfies readonly GateDecision[];
