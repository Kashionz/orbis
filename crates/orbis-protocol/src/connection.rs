//! 連線：Hello（含 Pairing）、Heartbeat（ARCHITECTURE §6.1）。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::RunnerKind;
use crate::ids::{RunId, RunnerId, Timestamp};

/// Runner 連上 Server 後送出的第一個 frame。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Hello {
    /// Runner 編譯時的 [`crate::PROTOCOL_VERSION`]。
    pub protocol_version: u32,
    pub runner: RunnerInfo,
    pub pairing: Pairing,
}

/// Runner 自我描述，用於 UI 顯示與除錯。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RunnerInfo {
    /// 顯示名稱，預設是主機名稱。
    pub name: String,
    /// Runner 執行檔的版本。
    pub runner_version: String,
    /// `windows`、`macos`、`linux`。
    pub os: String,
    /// 例如 `x86_64`、`aarch64`。
    pub arch: String,
}

/// Runner 證明自己身分的方式。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Pairing {
    /// 第一次連線：用 Pairing token 綁定到 Member（Local Runner）或 Team（Team Runner）。
    /// Server 依 token 決定 Runner 的種類與綁定對象。
    PairingToken { token: String },
    /// 已完成 Pairing：用 Server 在 [`HelloAck`] 發給的 Runner token 重新連線。
    RunnerToken { runner_id: RunnerId, token: String },
}

/// Server 接受 Hello。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct HelloAck {
    pub protocol_version: u32,
    pub runner_id: RunnerId,
    /// 第一次 Pairing 時發給 Runner 的長期 token，Runner 要存在本機設定中；
    /// 以 Runner token 重新連線時為 `null`。
    pub runner_token: Option<String>,
    /// Runner 送 Heartbeat 的間隔。
    pub heartbeat_interval_ms: u32,
    /// Server 端每個進行中的 Run 已收到的最後 seq。Runner 重新連上後，
    /// 從 `last_seq + 1` 開始補送暫存的 Event（ARCHITECTURE §14）。
    pub resume: Vec<RunResume>,
    /// 這台 Runner 的種類（Server 依 Pairing 決定）。Runner 據此決定 `runner.toml` 中依種類而定的預設值，
    /// 例如 `allow_terminal`（ARCHITECTURE §6.5）。缺少時（舊的 Server）Runner 當成不知道，一律採用較嚴格的預設值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runner_kind: Option<RunnerKind>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RunResume {
    pub run_id: RunId,
    /// 還沒收到任何 Event 時為 0。
    pub last_seq: u64,
}

/// Server 拒絕 Hello，送出後關閉連線。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct HelloRejected {
    pub reason: HelloRejectReason,
    /// Server 支援的協定版本，UI 用來提示更新。
    pub server_protocol_version: u32,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum HelloRejectReason {
    VersionMismatch,
    InvalidPairingToken,
    InvalidRunnerToken,
    /// 連線後第一個 frame 不是 Hello。
    HelloExpected,
}

/// Runner 定時送出的心跳。Server 以它判斷 Runner 是否在線、Dispatch 是否過期。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Heartbeat {
    /// Runner 送出時的時間。
    pub ts: Timestamp,
    /// Runner 目前正在執行的 Run。
    pub active_run_ids: Vec<RunId>,
    /// Runner 是否接受新的 Dispatch。`false` 時 Server 不派工給這台 Runner
    /// （Desktop 的「暫停領取」，ARCHITECTURE §6.1）；正在執行的 Run 不受影響。
    pub accepting_dispatches: bool,
}
