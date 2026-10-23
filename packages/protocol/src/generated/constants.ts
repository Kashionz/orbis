// 由 crates/orbis-protocol 產生（cargo gen-protocol），不可手改。
import type { AcceptanceCriterionKind } from "./AcceptanceCriterionKind";
import type { AgentCapability } from "./AgentCapability";
import type { DelegationMode } from "./DelegationMode";
import type { DelegationPurpose } from "./DelegationPurpose";
import type { DispatchRejectReason } from "./DispatchRejectReason";
import type { EventKindName } from "./EventKindName";
import type { FileChange } from "./FileChange";
import type { GateDecision } from "./GateDecision";
import type { GateKind } from "./GateKind";
import type { MergeOutcome } from "./MergeOutcome";
import type { OrbisToolErrorCode } from "./OrbisToolErrorCode";
import type { OrbisToolName } from "./OrbisToolName";
import type { PermissionOptionKind } from "./PermissionOptionKind";
import type { PermissionPolicy } from "./PermissionPolicy";
import type { PermissionPurpose } from "./PermissionPurpose";
import type { PlanEntryStatus } from "./PlanEntryStatus";
import type { PlanSource } from "./PlanSource";
import type { PreviewResetReason } from "./PreviewResetReason";
import type { PreviewStopReason } from "./PreviewStopReason";
import type { PreviewStreamKind } from "./PreviewStreamKind";
import type { PromptSource } from "./PromptSource";
import type { RunControlActionName } from "./RunControlActionName";
import type { RunControlRejectReason } from "./RunControlRejectReason";
import type { RunErrorCode } from "./RunErrorCode";
import type { RunOrigin } from "./RunOrigin";
import type { RunStatus } from "./RunStatus";
import type { RunnerKind } from "./RunnerKind";
import type { SidecarConnectionState } from "./SidecarConnectionState";
import type { ToolCallStatus } from "./ToolCallStatus";
import type { ToolKind } from "./ToolKind";
import type { VerificationKind } from "./VerificationKind";
import type { VerificationOutcome } from "./VerificationOutcome";

export const PROTOCOL_VERSION = 2;

export const RUNNER_WS_PATH = "/runner";

export const DEFAULT_MAX_CONCURRENT_RUNS = 30;

export const RUNNER_BLOB_PATH = "/api/runner/blobs";

export const RUNNER_BLOB_ROUTE = "/api/runner/blobs/:blobId";

export const SIDECAR_FLAG = "--sidecar";

export const SIDECAR_EXIT_NEEDS_PAIRING = 78;

export const SIDECAR_EXIT_VERSION_MISMATCH = 76;

export const PREVIEW_INITIAL_WINDOW = 262144;

export const PREVIEW_MAX_CHUNK = 65536;

export const PREVIEW_MAX_STREAMS_PER_RUN = 256;

export const PREVIEW_DATA_HEADER_LEN = 5;

export const PREVIEW_MAX_WS_MESSAGE = 16777216;

export const PREVIEW_DATA_KINDS = { body: 0, ws_text: 1, ws_binary: 2, ws_fragment: 3 } as const;

export const RUN_STATUSES = ["queued", "dispatched", "starting", "running", "verifying", "awaiting_permission", "rate_limited", "awaiting_gate", "completed", "failed", "canceled"] as const satisfies readonly RunStatus[];

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "canceled"] as const satisfies readonly RunStatus[];

export const PERMISSION_POLICIES = ["manual", "auto", "yolo"] as const satisfies readonly PermissionPolicy[];

export const DELEGATION_MODES = ["consult", "branch"] as const satisfies readonly DelegationMode[];

export const RUNNER_KINDS = ["local", "team"] as const satisfies readonly RunnerKind[];

export const GATE_KINDS = ["plan", "review"] as const satisfies readonly GateKind[];

export const GATE_DECISIONS = ["approved", "rejected"] as const satisfies readonly GateDecision[];

export const EVENT_KINDS = ["message_chunk", "thought_chunk", "tool_call", "permission_request", "permission_resolved", "plan", "usage", "status_changed", "error", "rate_limited", "preview_ready", "worktree_ready", "run_diff", "plan_proposed", "verification_result", "verification_completed", "child_merged", "final_message", "agent_session", "prompt_submitted", "preview_stopped"] as const satisfies readonly EventKindName[];

export const RUN_CONTROL_ACTIONS = ["cancel", "prompt", "permission_response", "gate_result", "push_branch", "verify", "archive", "restart_preview"] as const satisfies readonly RunControlActionName[];

export const RUN_CONTROL_REJECT_REASONS = ["unknown_run", "stale_dispatch", "invalid_state", "unknown_permission_request", "failed"] as const satisfies readonly RunControlRejectReason[];

export const DISPATCH_REJECT_REASONS = ["concurrency_limit", "rate_limited", "agent_unavailable", "expired", "duplicate", "unsupported", "internal"] as const satisfies readonly DispatchRejectReason[];

export const AGENT_CAPABILITIES = ["load_session", "plan_mode", "image_prompt", "usage_report"] as const satisfies readonly AgentCapability[];

export const TOOL_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"] as const satisfies readonly ToolKind[];

export const TOOL_CALL_STATUSES = ["pending", "in_progress", "completed", "failed"] as const satisfies readonly ToolCallStatus[];

export const PLAN_ENTRY_STATUSES = ["pending", "in_progress", "completed"] as const satisfies readonly PlanEntryStatus[];

export const PERMISSION_OPTION_KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"] as const satisfies readonly PermissionOptionKind[];

export const PERMISSION_PURPOSES = ["tool", "config_trust", "agent_settings_changed"] as const satisfies readonly PermissionPurpose[];

export const FILE_CHANGES = ["added", "modified", "deleted", "renamed"] as const satisfies readonly FileChange[];

export const SIDECAR_CONNECTION_STATES = ["connecting", "connected", "offline"] as const satisfies readonly SidecarConnectionState[];

export const RUN_ERROR_CODES = ["agent_start_failed", "agent_crashed", "agent_error", "worktree_failed", "setup_failed", "git_failed", "path_too_long", "merge_child_conflict", "session_resume_failed", "internal"] as const satisfies readonly RunErrorCode[];

export const RUN_ORIGINS = ["dispatch", "delegation", "verification", "mention", "feedback_loop"] as const satisfies readonly RunOrigin[];

export const PROMPT_SOURCES = ["user", "plan_gate", "review_gate", "verification_retry", "feedback_review", "feedback_ci", "child_question"] as const satisfies readonly PromptSource[];

export const ACCEPTANCE_CRITERION_KINDS = ["command", "agent", "browser", "manual"] as const satisfies readonly AcceptanceCriterionKind[];

export const VERIFICATION_KINDS = ["command", "agent", "browser"] as const satisfies readonly VerificationKind[];

export const VERIFICATION_OUTCOMES = ["passed", "failed", "error"] as const satisfies readonly VerificationOutcome[];

export const PLAN_SOURCES = ["plan_mode", "prompt_fallback"] as const satisfies readonly PlanSource[];

export const MERGE_OUTCOMES = ["merged", "conflict"] as const satisfies readonly MergeOutcome[];

export const PREVIEW_STOP_REASONS = ["exited", "ready_timeout", "spawn_failed"] as const satisfies readonly PreviewStopReason[];

export const MCP_TOOLS = ["delegate", "get_run", "wait_run", "list_runs", "merge_child", "ask_parent", "answer_child", "propose_tasks", "update_task_note"] as const satisfies readonly OrbisToolName[];

export const MCP_TOOL_ERROR_CODES = ["delegation_disabled", "agent_not_allowed", "agent_unavailable", "depth_exceeded", "child_limit_exceeded", "permission_not_narrower", "not_found", "not_child", "invalid_state", "internal"] as const satisfies readonly OrbisToolErrorCode[];

export const DELEGATION_PURPOSES = ["tool", "verification"] as const satisfies readonly DelegationPurpose[];

export const PREVIEW_STREAM_KINDS = ["http", "websocket"] as const satisfies readonly PreviewStreamKind[];

export const PREVIEW_RESET_REASONS = ["canceled", "upstream_error", "not_running", "too_many_streams", "protocol_error"] as const satisfies readonly PreviewResetReason[];
