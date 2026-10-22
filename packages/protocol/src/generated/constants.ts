// 由 crates/orbis-protocol 產生（cargo gen-protocol），不可手改。
import type { AgentCapability } from "./AgentCapability";
import type { DelegationMode } from "./DelegationMode";
import type { DispatchRejectReason } from "./DispatchRejectReason";
import type { EventKindName } from "./EventKindName";
import type { GateDecision } from "./GateDecision";
import type { GateKind } from "./GateKind";
import type { PermissionOptionKind } from "./PermissionOptionKind";
import type { PermissionPolicy } from "./PermissionPolicy";
import type { PlanEntryStatus } from "./PlanEntryStatus";
import type { RunControlActionName } from "./RunControlActionName";
import type { RunControlRejectReason } from "./RunControlRejectReason";
import type { RunErrorCode } from "./RunErrorCode";
import type { RunStatus } from "./RunStatus";
import type { RunnerKind } from "./RunnerKind";
import type { ToolCallStatus } from "./ToolCallStatus";
import type { ToolKind } from "./ToolKind";

export const PROTOCOL_VERSION = 1;

export const RUNNER_WS_PATH = "/runner";

export const DEFAULT_MAX_CONCURRENT_RUNS = 30;

export const RUN_STATUSES = ["queued", "dispatched", "starting", "running", "awaiting_permission", "rate_limited", "awaiting_gate", "completed", "failed", "canceled"] as const satisfies readonly RunStatus[];

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "canceled"] as const satisfies readonly RunStatus[];

export const PERMISSION_POLICIES = ["manual", "auto", "yolo"] as const satisfies readonly PermissionPolicy[];

export const DELEGATION_MODES = ["consult", "branch"] as const satisfies readonly DelegationMode[];

export const RUNNER_KINDS = ["local", "team"] as const satisfies readonly RunnerKind[];

export const GATE_KINDS = ["plan", "review"] as const satisfies readonly GateKind[];

export const GATE_DECISIONS = ["approved", "rejected"] as const satisfies readonly GateDecision[];

export const EVENT_KINDS = ["message_chunk", "thought_chunk", "tool_call", "permission_request", "permission_resolved", "plan", "usage", "status_changed", "error", "rate_limited", "preview_ready", "worktree_ready"] as const satisfies readonly EventKindName[];

export const RUN_CONTROL_ACTIONS = ["cancel", "prompt", "permission_response", "gate_result", "push_branch"] as const satisfies readonly RunControlActionName[];

export const RUN_CONTROL_REJECT_REASONS = ["unknown_run", "stale_dispatch", "invalid_state", "unknown_permission_request", "failed"] as const satisfies readonly RunControlRejectReason[];

export const DISPATCH_REJECT_REASONS = ["concurrency_limit", "agent_unavailable", "expired", "duplicate", "unsupported", "internal"] as const satisfies readonly DispatchRejectReason[];

export const AGENT_CAPABILITIES = ["load_session", "plan_mode", "image_prompt", "usage_report"] as const satisfies readonly AgentCapability[];

export const TOOL_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"] as const satisfies readonly ToolKind[];

export const TOOL_CALL_STATUSES = ["pending", "in_progress", "completed", "failed"] as const satisfies readonly ToolCallStatus[];

export const PLAN_ENTRY_STATUSES = ["pending", "in_progress", "completed"] as const satisfies readonly PlanEntryStatus[];

export const PERMISSION_OPTION_KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"] as const satisfies readonly PermissionOptionKind[];

export const RUN_ERROR_CODES = ["agent_start_failed", "agent_crashed", "agent_error", "worktree_failed", "setup_failed", "git_failed", "path_too_long", "internal"] as const satisfies readonly RunErrorCode[];
