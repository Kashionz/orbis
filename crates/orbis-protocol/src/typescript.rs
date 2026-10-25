//! 產生 `packages/protocol` 的 TS 型別。
//!
//! - `generated/*.ts`：ts-rs 產生的型別，每個型別一個檔案。
//! - `generated/index.ts`：重新匯出所有型別。
//! - `generated/constants.ts`：協定版本與列舉的值陣列（ts-rs 只產生型別，不產生值）。
//!
//! 執行 `cargo gen-protocol`（或 `pnpm gen:protocol`）重新產生；
//! `tests/generated_up_to_date.rs` 會在產生結果與 commit 的版本不一致時失敗。

use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use ts_rs::{Config, TS};

use crate::availability::{
    AgentCapability, DEFAULT_MAX_CONCURRENT_RUNS, LoginHintKind, ModelSource, ModelTag,
};
use crate::control::{
    RunControlAction, RunControlActionName, RunControlOutcome, RunControlRejectReason,
};
use crate::dispatch::DispatchRejectReason;
use crate::enums::{
    AcceptanceCriterionKind, DelegationMode, Effort, GateDecision, GateKind, LocalMergeStrategy,
    PermissionPolicy, PromptDelivery, PromptSource, RepoKind, RunOrigin, RunStatus, RunnerKind,
};
use crate::event::{
    EventEnvelope, EventKind, EventKindName, FileChange, MergeOutcome, PermissionOptionKind,
    PermissionPurpose, PlanEntryStatus, PlanSource, PreviewStopReason, RunErrorCode,
    RunSettingName, ToolCallStatus, ToolKind,
};
use crate::frame::{RunnerToServer, ServerToRunner};
use crate::names::Names;
use crate::preview::{
    PREVIEW_DATA_HEADER_LEN, PREVIEW_INITIAL_WINDOW, PREVIEW_MAX_CHUNK,
    PREVIEW_MAX_STREAMS_PER_RUN, PREVIEW_MAX_WS_MESSAGE, PreviewDataKind, PreviewResetReason,
    PreviewStreamKind,
};
use crate::repo_spec::{RepoSpecCommitFailure, RepoSpecCommitOutcome};
use crate::sidecar::{
    SIDECAR_EXIT_NEEDS_PAIRING, SIDECAR_EXIT_VERSION_MISMATCH, SIDECAR_FLAG, SidecarCommand,
    SidecarConnectionState, SidecarOutput,
};
use crate::terminal::{
    TERMINAL_IDLE_TIMEOUT_SECS, TERMINAL_MAX_CHUNK, TERMINAL_MAX_PER_RUN, TerminalExitReason,
};
use crate::tool::{DelegationPurpose, OrbisToolErrorCode, OrbisToolName};
use crate::verification::{VerificationEvidence, VerificationKind, VerificationOutcome};

const HEADER: &str = "// 由 crates/orbis-protocol 產生（cargo gen-protocol），不可手改。\n";

/// 產生結果在 repo 中的位置。
pub fn default_out_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/src/generated")
}

/// 清空 `out_dir` 後重新產生所有檔案。
pub fn generate(out_dir: &Path) -> io::Result<()> {
    if out_dir.exists() {
        fs::remove_dir_all(out_dir)?;
    }
    fs::create_dir_all(out_dir)?;

    let cfg = Config::new()
        .with_out_dir(out_dir)
        // seq、大小、token 數都遠小於 2^53，在 TS 端用 number，不用 bigint。
        .with_large_int("number");

    export_roots(&cfg).map_err(io::Error::other)?;

    let mut modules: Vec<String> = fs::read_dir(out_dir)?
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".ts").map(str::to_owned)
        })
        .collect();
    modules.sort();

    let mut index = String::from(HEADER);
    for module in &modules {
        writeln!(index, "export type * from \"./{module}\";").unwrap();
    }
    index.push_str("export * from \"./constants\";\n");
    fs::write(out_dir.join("index.ts"), index)?;

    fs::write(out_dir.join("constants.ts"), constants())?;
    Ok(())
}

/// 所有要匯出的根型別；它們依賴的型別會一併匯出。
/// 新增協定型別時，只要它能從這些根型別到達就會被匯出；獨立的型別要加在這裡。
fn export_roots(cfg: &Config) -> Result<(), ts_rs::ExportError> {
    RunnerToServer::export_all(cfg)?;
    ServerToRunner::export_all(cfg)?;
    Names::export_all(cfg)?;
    RunStatus::export_all(cfg)?;
    PermissionPolicy::export_all(cfg)?;
    DelegationMode::export_all(cfg)?;
    RunnerKind::export_all(cfg)?;
    GateKind::export_all(cfg)?;
    GateDecision::export_all(cfg)?;
    RunOrigin::export_all(cfg)?;
    PromptSource::export_all(cfg)?;
    AcceptanceCriterionKind::export_all(cfg)?;
    VerificationKind::export_all(cfg)?;
    VerificationOutcome::export_all(cfg)?;
    VerificationEvidence::export_all(cfg)?;
    OrbisToolName::export_all(cfg)?;
    Effort::export_all(cfg)?;
    PromptDelivery::export_all(cfg)?;
    RepoKind::export_all(cfg)?;
    LocalMergeStrategy::export_all(cfg)?;
    // `#[serde(flatten)]` 的型別會被 ts-rs 內嵌到外層，不會自己產生檔案，所以要列在這裡。
    EventEnvelope::export_all(cfg)?;
    EventKind::export_all(cfg)?;
    EventKindName::export_all(cfg)?;
    RunControlAction::export_all(cfg)?;
    RunControlActionName::export_all(cfg)?;
    RunControlOutcome::export_all(cfg)?;
    RepoSpecCommitOutcome::export_all(cfg)?;
    // Desktop ↔ Runner 的 sidecar 協定不在 Runner↔Server 的 frame 中，要另外列出。
    SidecarOutput::export_all(cfg)?;
    SidecarCommand::export_all(cfg)?;
    Ok(())
}

/// 一組要輸出成 TS 值陣列的列舉值，`ty` 是對應的 ts-rs 型別名稱。
struct ValueList {
    name: &'static str,
    ty: &'static str,
    values: Vec<&'static str>,
}

fn list<T: Copy>(
    name: &'static str,
    ty: &'static str,
    values: impl IntoIterator<Item = T>,
    as_str: fn(T) -> &'static str,
) -> ValueList {
    ValueList {
        name,
        ty,
        values: values.into_iter().map(as_str).collect(),
    }
}

/// 新增要給 TS 端使用的列舉時，在這裡加一行。
fn value_lists() -> Vec<ValueList> {
    vec![
        list(
            "RUN_STATUSES",
            "RunStatus",
            RunStatus::ALL.iter().copied(),
            RunStatus::as_str,
        ),
        list(
            "TERMINAL_RUN_STATUSES",
            "RunStatus",
            RunStatus::ALL.iter().copied().filter(|s| s.is_terminal()),
            RunStatus::as_str,
        ),
        list(
            "PERMISSION_POLICIES",
            "PermissionPolicy",
            PermissionPolicy::ALL.iter().copied(),
            PermissionPolicy::as_str,
        ),
        list(
            "DELEGATION_MODES",
            "DelegationMode",
            DelegationMode::ALL.iter().copied(),
            DelegationMode::as_str,
        ),
        list(
            "RUNNER_KINDS",
            "RunnerKind",
            RunnerKind::ALL.iter().copied(),
            RunnerKind::as_str,
        ),
        list(
            "GATE_KINDS",
            "GateKind",
            GateKind::ALL.iter().copied(),
            GateKind::as_str,
        ),
        list(
            "GATE_DECISIONS",
            "GateDecision",
            GateDecision::ALL.iter().copied(),
            GateDecision::as_str,
        ),
        list(
            "EVENT_KINDS",
            "EventKindName",
            EventKindName::ALL.iter().copied(),
            EventKindName::as_str,
        ),
        list(
            "RUN_CONTROL_ACTIONS",
            "RunControlActionName",
            RunControlActionName::ALL.iter().copied(),
            RunControlActionName::as_str,
        ),
        list(
            "RUN_CONTROL_REJECT_REASONS",
            "RunControlRejectReason",
            RunControlRejectReason::ALL.iter().copied(),
            RunControlRejectReason::as_str,
        ),
        list(
            "DISPATCH_REJECT_REASONS",
            "DispatchRejectReason",
            DispatchRejectReason::ALL.iter().copied(),
            DispatchRejectReason::as_str,
        ),
        list(
            "AGENT_CAPABILITIES",
            "AgentCapability",
            AgentCapability::ALL.iter().copied(),
            AgentCapability::as_str,
        ),
        list(
            "TOOL_KINDS",
            "ToolKind",
            ToolKind::ALL.iter().copied(),
            ToolKind::as_str,
        ),
        list(
            "TOOL_CALL_STATUSES",
            "ToolCallStatus",
            ToolCallStatus::ALL.iter().copied(),
            ToolCallStatus::as_str,
        ),
        list(
            "PLAN_ENTRY_STATUSES",
            "PlanEntryStatus",
            PlanEntryStatus::ALL.iter().copied(),
            PlanEntryStatus::as_str,
        ),
        list(
            "PERMISSION_OPTION_KINDS",
            "PermissionOptionKind",
            PermissionOptionKind::ALL.iter().copied(),
            PermissionOptionKind::as_str,
        ),
        list(
            "PERMISSION_PURPOSES",
            "PermissionPurpose",
            PermissionPurpose::ALL.iter().copied(),
            PermissionPurpose::as_str,
        ),
        list(
            "FILE_CHANGES",
            "FileChange",
            FileChange::ALL.iter().copied(),
            FileChange::as_str,
        ),
        list(
            "SIDECAR_CONNECTION_STATES",
            "SidecarConnectionState",
            SidecarConnectionState::ALL.iter().copied(),
            SidecarConnectionState::as_str,
        ),
        list(
            "RUN_ERROR_CODES",
            "RunErrorCode",
            RunErrorCode::ALL.iter().copied(),
            RunErrorCode::as_str,
        ),
        list(
            "RUN_ORIGINS",
            "RunOrigin",
            RunOrigin::ALL.iter().copied(),
            RunOrigin::as_str,
        ),
        list(
            "PROMPT_SOURCES",
            "PromptSource",
            PromptSource::ALL.iter().copied(),
            PromptSource::as_str,
        ),
        list(
            "ACCEPTANCE_CRITERION_KINDS",
            "AcceptanceCriterionKind",
            AcceptanceCriterionKind::ALL.iter().copied(),
            AcceptanceCriterionKind::as_str,
        ),
        list(
            "VERIFICATION_KINDS",
            "VerificationKind",
            VerificationKind::ALL.iter().copied(),
            VerificationKind::as_str,
        ),
        list(
            "VERIFICATION_OUTCOMES",
            "VerificationOutcome",
            VerificationOutcome::ALL.iter().copied(),
            VerificationOutcome::as_str,
        ),
        list(
            "PLAN_SOURCES",
            "PlanSource",
            PlanSource::ALL.iter().copied(),
            PlanSource::as_str,
        ),
        list(
            "MERGE_OUTCOMES",
            "MergeOutcome",
            MergeOutcome::ALL.iter().copied(),
            MergeOutcome::as_str,
        ),
        list(
            "PREVIEW_STOP_REASONS",
            "PreviewStopReason",
            PreviewStopReason::ALL.iter().copied(),
            PreviewStopReason::as_str,
        ),
        list(
            "MCP_TOOLS",
            "OrbisToolName",
            OrbisToolName::ALL.iter().copied(),
            OrbisToolName::as_str,
        ),
        list(
            "MCP_TOOL_ERROR_CODES",
            "OrbisToolErrorCode",
            OrbisToolErrorCode::ALL.iter().copied(),
            OrbisToolErrorCode::as_str,
        ),
        list(
            "DELEGATION_PURPOSES",
            "DelegationPurpose",
            DelegationPurpose::ALL.iter().copied(),
            DelegationPurpose::as_str,
        ),
        list(
            "PREVIEW_STREAM_KINDS",
            "PreviewStreamKind",
            PreviewStreamKind::ALL.iter().copied(),
            PreviewStreamKind::as_str,
        ),
        list(
            "PREVIEW_RESET_REASONS",
            "PreviewResetReason",
            PreviewResetReason::ALL.iter().copied(),
            PreviewResetReason::as_str,
        ),
        list(
            "EFFORTS",
            "Effort",
            Effort::ALL.iter().copied(),
            Effort::as_str,
        ),
        list(
            "PROMPT_DELIVERIES",
            "PromptDelivery",
            PromptDelivery::ALL.iter().copied(),
            PromptDelivery::as_str,
        ),
        list(
            "REPO_KINDS",
            "RepoKind",
            RepoKind::ALL.iter().copied(),
            RepoKind::as_str,
        ),
        list(
            "LOCAL_MERGE_STRATEGIES",
            "LocalMergeStrategy",
            LocalMergeStrategy::ALL.iter().copied(),
            LocalMergeStrategy::as_str,
        ),
        list(
            "MODEL_TAGS",
            "ModelTag",
            ModelTag::ALL.iter().copied(),
            ModelTag::as_str,
        ),
        list(
            "MODEL_SOURCES",
            "ModelSource",
            ModelSource::ALL.iter().copied(),
            ModelSource::as_str,
        ),
        list(
            "LOGIN_HINT_KINDS",
            "LoginHintKind",
            LoginHintKind::ALL.iter().copied(),
            LoginHintKind::as_str,
        ),
        list(
            "RUN_SETTING_NAMES",
            "RunSettingName",
            RunSettingName::ALL.iter().copied(),
            RunSettingName::as_str,
        ),
        list(
            "TERMINAL_EXIT_REASONS",
            "TerminalExitReason",
            TerminalExitReason::ALL.iter().copied(),
            TerminalExitReason::as_str,
        ),
        list(
            "REPO_SPEC_COMMIT_FAILURES",
            "RepoSpecCommitFailure",
            RepoSpecCommitFailure::ALL.iter().copied(),
            RepoSpecCommitFailure::as_str,
        ),
    ]
}

fn constants() -> String {
    let lists = value_lists();
    let mut out = String::from(HEADER);

    let mut types: Vec<&str> = lists.iter().map(|l| l.ty).collect();
    types.sort_unstable();
    types.dedup();
    for ty in types {
        writeln!(out, "import type {{ {ty} }} from \"./{ty}\";").unwrap();
    }

    writeln!(
        out,
        "\nexport const PROTOCOL_VERSION = {};",
        crate::PROTOCOL_VERSION
    )
    .unwrap();
    writeln!(
        out,
        "
export const RUNNER_WS_PATH = \"{}\";",
        crate::RUNNER_WS_PATH
    )
    .unwrap();
    writeln!(
        out,
        "
export const DEFAULT_MAX_CONCURRENT_RUNS = {DEFAULT_MAX_CONCURRENT_RUNS};"
    )
    .unwrap();
    writeln!(
        out,
        "\nexport const RUNNER_BLOB_PATH = \"{}\";",
        crate::RUNNER_BLOB_PATH
    )
    .unwrap();
    writeln!(
        out,
        "\nexport const RUNNER_BLOB_ROUTE = \"{}\";",
        crate::RUNNER_BLOB_ROUTE
    )
    .unwrap();
    writeln!(out, "\nexport const SIDECAR_FLAG = \"{SIDECAR_FLAG}\";").unwrap();
    writeln!(
        out,
        "\nexport const SIDECAR_EXIT_NEEDS_PAIRING = {SIDECAR_EXIT_NEEDS_PAIRING};"
    )
    .unwrap();
    writeln!(
        out,
        "\nexport const SIDECAR_EXIT_VERSION_MISMATCH = {SIDECAR_EXIT_VERSION_MISMATCH};"
    )
    .unwrap();
    writeln!(
        out,
        "
export const PREVIEW_INITIAL_WINDOW = {PREVIEW_INITIAL_WINDOW};"
    )
    .unwrap();
    writeln!(
        out,
        "
export const PREVIEW_MAX_CHUNK = {PREVIEW_MAX_CHUNK};"
    )
    .unwrap();
    writeln!(
        out,
        "
export const PREVIEW_MAX_STREAMS_PER_RUN = {PREVIEW_MAX_STREAMS_PER_RUN};"
    )
    .unwrap();
    writeln!(
        out,
        "
export const PREVIEW_DATA_HEADER_LEN = {PREVIEW_DATA_HEADER_LEN};"
    )
    .unwrap();
    writeln!(
        out,
        "
export const PREVIEW_MAX_WS_MESSAGE = {PREVIEW_MAX_WS_MESSAGE};"
    )
    .unwrap();
    writeln!(
        out,
        "
export const TERMINAL_MAX_PER_RUN = {TERMINAL_MAX_PER_RUN};"
    )
    .unwrap();
    writeln!(
        out,
        "
export const TERMINAL_IDLE_TIMEOUT_SECS = {TERMINAL_IDLE_TIMEOUT_SECS};"
    )
    .unwrap();
    writeln!(
        out,
        "
export const TERMINAL_MAX_CHUNK = {TERMINAL_MAX_CHUNK};"
    )
    .unwrap();
    // Preview binary 訊息第一個 byte 的值（見 crates/orbis-protocol/src/preview.rs）。
    let kinds: Vec<String> = PreviewDataKind::ALL
        .iter()
        .map(|k| format!("{}: {}", k.as_str(), *k as u8))
        .collect();
    writeln!(
        out,
        "
export const PREVIEW_DATA_KINDS = {{ {} }} as const;",
        kinds.join(", ")
    )
    .unwrap();
    for l in &lists {
        let values: Vec<String> = l.values.iter().map(|v| format!("\"{v}\"")).collect();
        writeln!(
            out,
            "\nexport const {} = [{}] as const satisfies readonly {}[];",
            l.name,
            values.join(", "),
            l.ty
        )
        .unwrap();
    }
    out
}
