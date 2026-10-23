//! 等待契約 PR（`contract/protocol`）期間的暫時型別與常數。
//!
//! 這裡的每一項都會移到 `crates/orbis-protocol`，屆時改用協定的定義並刪掉這個模組。
//! 形狀依使用者核准的決定（見 PR 說明），名稱與欄位可能在契約 review 時微調。

use orbis_protocol::event::TextBody;
use orbis_protocol::ids::{DispatchId, RunId, Timestamp};
use serde::{Deserialize, Serialize};

// TODO(contract): 移到 `orbis_protocol::names`（Rust 與 TS 各一份）。
/// `~/<CONFIG_DIR>/` 下 Runner 的設定檔（給人編輯）。
pub const RUNNER_CONFIG_FILE: &str = "runner.toml";
// TODO(contract): 移到 `orbis_protocol::names`。
/// `~/<CONFIG_DIR>/` 下 Runner 的狀態目錄（Runner token、port 分配、信任紀錄、Event 暫存）。
pub const RUNNER_STATE_DIR: &str = "runner";

// TODO(contract): 移到 `orbis_protocol::names::ENV_RUNNER_STATE_DIR`。
/// 只覆寫狀態目錄的環境變數後綴（完整名稱由 `names::env_var` 組出）；
/// `RUNNER_CONFIG_FILE` 仍從 `~/<CONFIG_DIR>/`（或 `<前綴>HOME`）讀取。Desktop 代管的 Runner 用它。
pub const ENV_RUNNER_STATE_DIR: &str = "RUNNER_STATE_DIR";

// TODO(contract): 移到 `orbis_protocol`，與 `RUNNER_WS_PATH` 並列。
/// blob 上傳的 HTTP 路徑前綴：`PUT <server><RUNNER_BLOB_PATH>/<blob_id>?run_id=<run_id>&sha256=<sha256>`。
pub const RUNNER_BLOB_PATH: &str = "/api/runner/blobs";

// TODO(contract): 改用 `orbis_protocol::sidecar::SIDECAR_FLAG`。
/// 啟用 sidecar 模式的命令列旗標。
pub const SIDECAR_FLAG: &str = "--sidecar";

// TODO(contract): 改用 `orbis_protocol::sidecar::SIDECAR_EXIT_NEEDS_PAIRING`。
/// sidecar：Runner token 無效或已被撤銷、需要重新 Pairing 時的結束碼（BSD 的 `EX_CONFIG`）。
pub const SIDECAR_EXIT_NEEDS_PAIRING: u8 = 78;

// TODO(contract): 改用 `orbis_protocol::sidecar::SIDECAR_EXIT_VERSION_MISMATCH`。
/// sidecar：協定版本不相容、需要更新 Runner 時的結束碼（BSD 的 `EX_PROTOCOL`）。
pub const SIDECAR_EXIT_VERSION_MISMATCH: u8 = 76;

/// Heartbeat（含暫停領取的旗標）。
// TODO(contract): 併入 `orbis_protocol::connection::Heartbeat` 的 `accepting_dispatches`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Heartbeat {
    pub ts: Timestamp,
    pub active_run_ids: Vec<RunId>,
    /// `false` 時 Server 不再派工給這台 Runner（sidecar 的「暫停領取」）。
    pub accepting_dispatches: bool,
}

/// Review Gate 用的整份 diff，Runner 在回合結束、進入 `awaiting_gate` 之前送出。
// TODO(contract): 改成 `orbis_protocol::event::EventKind` 的新 kind。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunDiff {
    /// Worktree 開出時的 commit。
    pub base_commit: String,
    pub files: Vec<RunDiffFile>,
}

/// 一個檔案的變更，帶完整的新舊內容（Monaco DiffEditor 需要）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunDiffFile {
    /// 相對於 Worktree 根目錄、以 `/` 分隔。
    pub path: String,
    /// `renamed` 時的舊路徑，其他為 `null`。
    pub old_path: Option<String>,
    pub change: FileChange,
    /// 二進位檔案。為 `true` 時 `old` 與 `new` 一律為 `null`。
    pub binary: bool,
    /// 修改前的內容；新增的檔案為 `null`。
    pub old: Option<TextBody>,
    /// 修改後的內容；刪除的檔案為 `null`。
    pub new: Option<TextBody>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// 權限請求的用途。Server 依此決定誰可以回覆（例如信任核准要 Admin 以上）。
// TODO(contract): 併入 `EventKind::PermissionRequest` 的 `purpose` 欄位（名稱以契約 PR 為準）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPurpose {
    /// Agent 的 tool call。
    Tool,
    /// 第一次執行（或內容改變後）`<CONFIG_DIR>/<CONFIG_FILE>` 中的腳本。
    ConfigTrust,
    /// Worktree 中 Agent 自己的設定檔（例如 `.claude/settings.json`）和 base commit 不同。
    AgentSettingsChanged,
}

/// 帶 `purpose` 的 `permission_request`。
// TODO(contract): 改回 `EventKind::PermissionRequest`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "permission_request")]
pub struct PermissionRequestKind {
    pub request_id: orbis_protocol::ids::PermissionRequestId,
    pub tool_call_id: Option<orbis_protocol::ids::ToolCallId>,
    pub title: String,
    pub options: Vec<orbis_protocol::event::PermissionOption>,
    pub purpose: PermissionPurpose,
}

/// Runner 送出的 Event 內容：協定已有的 kind，或還在等契約的 kind。
// TODO(contract): 契約合併後只剩 `orbis_protocol::event::EventKind`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OutgoingKind {
    Protocol(orbis_protocol::event::EventKind),
    RunDiff(RunDiffKind),
    PermissionRequest(PermissionRequestKind),
}

/// `run_diff` 的傳輸格式：`kind` 與欄位放在同一層。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename = "run_diff")]
pub struct RunDiffKind {
    #[serde(flatten)]
    pub diff: RunDiff,
}

impl From<orbis_protocol::event::EventKind> for OutgoingKind {
    fn from(kind: orbis_protocol::event::EventKind) -> Self {
        Self::Protocol(kind)
    }
}

impl OutgoingKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Protocol(kind) => kind.name().as_str(),
            Self::RunDiff(_) => "run_diff",
            Self::PermissionRequest(_) => "permission_request",
        }
    }
}

/// `event` frame 的暫時版本（`kind` 可以是還在等契約的 kind）。
// TODO(contract): 改回 `orbis_protocol::event::EventFrame`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventFrame {
    pub dispatch_id: DispatchId,
    pub run_id: RunId,
    pub seq: u64,
    pub ts: Timestamp,
    #[serde(flatten)]
    pub kind: OutgoingKind,
}

/// sidecar 模式寫到 stdout 的一行，以 `type` 區分種類。
// TODO(contract): 改用 `orbis_protocol::sidecar::SidecarOutput`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarOutput {
    Status(SidecarStatus),
}

/// sidecar 模式的狀態。
// TODO(contract): 改用 `orbis_protocol::sidecar::SidecarStatus`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SidecarStatus {
    pub state: SidecarState,
    pub runner_id: Option<String>,
    pub active_runs: u32,
    pub claiming_paused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarState {
    Connecting,
    Connected,
    Offline,
}

/// sidecar 模式的指令（stdin 每行一個 JSON），以 `type` 區分種類。
// TODO(contract): 改用 `orbis_protocol::sidecar::SidecarCommand`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarCommand {
    PauseClaiming,
    ResumeClaiming,
    Shutdown,
}

#[cfg(test)]
mod tests {
    use orbis_protocol::event::EventKind;

    use super::*;

    #[test]
    fn run_diff_kind_sits_beside_envelope_fields() {
        let frame = EventFrame {
            dispatch_id: "d".into(),
            run_id: "r".into(),
            seq: 3,
            ts: "2026-10-23T08:00:00.000Z".into(),
            kind: OutgoingKind::RunDiff(RunDiffKind {
                diff: RunDiff {
                    base_commit: "a".repeat(40),
                    files: vec![RunDiffFile {
                        path: "a.txt".into(),
                        old_path: None,
                        change: FileChange::Added,
                        binary: false,
                        old: None,
                        new: Some(TextBody::Inline { text: "x".into() }),
                    }],
                },
            }),
        };
        let value = serde_json::to_value(&frame).unwrap();
        assert_eq!(value["kind"], "run_diff");
        assert_eq!(value["seq"], 3);
        assert_eq!(value["files"][0]["change"], "added");
    }

    #[test]
    fn protocol_kinds_serialize_like_the_protocol_frame() {
        let kind = EventKind::ThoughtChunk { text: "想".into() };
        let ours = EventFrame {
            dispatch_id: "d".into(),
            run_id: "r".into(),
            seq: 1,
            ts: "t".into(),
            kind: kind.clone().into(),
        };
        let theirs = orbis_protocol::event::EventFrame {
            dispatch_id: "d".into(),
            event: orbis_protocol::event::EventEnvelope {
                run_id: "r".into(),
                seq: 1,
                ts: "t".into(),
                kind,
            },
        };
        assert_eq!(
            serde_json::to_value(&ours).unwrap(),
            serde_json::to_value(&theirs).unwrap()
        );
    }

    #[test]
    fn sidecar_commands_parse_from_json_lines() {
        let command: SidecarCommand = serde_json::from_str(r#"{"type":"pause_claiming"}"#).unwrap();
        assert_eq!(command, SidecarCommand::PauseClaiming);
    }

    #[test]
    fn sidecar_status_line_is_tagged_with_type() {
        let line = SidecarOutput::Status(SidecarStatus {
            state: SidecarState::Connected,
            runner_id: Some("r1".into()),
            active_runs: 1,
            claiming_paused: false,
        });
        assert_eq!(
            serde_json::to_value(&line).unwrap(),
            serde_json::json!({
                "type": "status",
                "state": "connected",
                "runner_id": "r1",
                "active_runs": 1,
                "claiming_paused": false,
            })
        );
    }
}
