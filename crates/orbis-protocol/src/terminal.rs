//! 互動式終端機（協定版本 3，ARCHITECTURE「互動式終端機」、ADR-0014）。
//!
//! Runner 在 Run 的 Worktree 中開 PTY（Windows 用 ConPTY），輸入輸出經由既有的 Runner 連線轉送。
//! 一個終端機以 `terminal_id` 區分（由 Server 產生）。
//!
//! - Server→Runner：`terminal_open`、`terminal_input`、`terminal_resize`、`terminal_close`。
//! - Runner→Server：`terminal_output`、`terminal_exited`。
//! - `data` 是 base64（標準字母表、有 padding），解碼後最多 [`TERMINAL_MAX_CHUNK`] byte；
//!   更多的輸出分成多個 frame。沒有 credit 背壓：Runner 送往 Server 時排在 Event、control 與
//!   Heartbeat 之後（同 Preview）。
//! - 終端機是人自己下指令，不經過 Permission Policy；誰能開由 Server 判斷，Runner 不再檢查。
//!   Run 結束後只要 Worktree 還在就能開（Runner 依本機的 Worktree 紀錄找到路徑，同 `archive`）。
//! - shell：Windows 預設 PowerShell，其他平台用 `$SHELL`；`runner.toml` 可以覆寫。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::wire_enum;
use crate::ids::{RunId, TerminalId};

/// 每個 Run 同時開啟的終端機上限；超過時 Runner 以 `terminal_exited`（`limit_exceeded`）拒絕。
pub const TERMINAL_MAX_PER_RUN: u32 = 3;

/// 沒有輸入也沒有輸出超過這個秒數時，Runner 關閉終端機（`idle_timeout`）。
pub const TERMINAL_IDLE_TIMEOUT_SECS: u32 = 30 * 60;

/// 一個 frame 的 `data` 解碼後的上限，單位是 byte。
pub const TERMINAL_MAX_CHUNK: usize = 64 * 1024;

/// 開一個終端機（Server→Runner）。成功時直接開始送 `terminal_output`；失敗時回 `terminal_exited`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TerminalOpen {
    pub terminal_id: TerminalId,
    pub run_id: RunId,
    pub cols: u16,
    pub rows: u16,
}

/// 使用者的輸入（Server→Runner）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TerminalInput {
    pub terminal_id: TerminalId,
    /// base64 的位元組。
    pub data: String,
}

/// 改變終端機的大小（Server→Runner）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TerminalResize {
    pub terminal_id: TerminalId,
    pub cols: u16,
    pub rows: u16,
}

/// 關閉終端機（Server→Runner），例如使用者關閉分頁或 WebSocket 斷線。Runner 結束 shell 的程序樹後
/// 回 `terminal_exited`（`closed`）；不存在的終端機不回。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TerminalClose {
    pub terminal_id: TerminalId,
}

/// 終端機的輸出（Runner→Server）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TerminalOutput {
    pub terminal_id: TerminalId,
    /// base64 的位元組。
    pub data: String,
}

/// 終端機結束了，或無法開啟（Runner→Server）。每個 `terminal_open` 最後恰好有一個。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TerminalExited {
    pub terminal_id: TerminalId,
    /// shell 的 exit code；沒有啟動、被結束或沒有 exit code 時為 `null`。
    pub code: Option<i32>,
    pub reason: TerminalExitReason,
    /// 給人看的說明，例如 spawn 失敗的原因；其他為 `null`。
    pub message: Option<String>,
}

wire_enum! {
    /// 終端機結束的原因。
    /// 彈性：之後可能增加代碼，接收端遇到不認得的值要當成 `exited`。
    TerminalExitReason {
        /// shell 自己結束了。
        Exited => "exited",
        /// 收到 `terminal_close`。
        Closed => "closed",
        /// 閒置超過 [`TERMINAL_IDLE_TIMEOUT_SECS`]。
        IdleTimeout => "idle_timeout",
        /// 這台 Runner 上沒有這個 Run 的 Worktree（已封存或不在這台電腦）。
        WorktreeMissing => "worktree_missing",
        /// shell 或 PTY 無法啟動。
        SpawnFailed => "spawn_failed",
        /// 超過 [`TERMINAL_MAX_PER_RUN`]。
        LimitExceeded => "limit_exceeded",
        /// Runner 關閉或與 Server 的連線中斷。
        RunnerShutdown => "runner_shutdown",
    }
}
