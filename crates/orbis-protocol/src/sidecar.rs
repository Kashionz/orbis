//! Desktop ↔ Runner 的 sidecar 協定（ARCHITECTURE §16）。
//!
//! Desktop（Electron）以子程序啟動 Runner，並加上 [`SIDECAR_FLAG`]：
//!
//! - Runner 的 stdout 每行一個 [`SidecarOutput`] JSON；log 一律走 stderr。
//!   **啟動後立刻送出一行 status**（`connecting`），之後狀態有變化時再送，不要等到第一次變化。
//! - Desktop 從 stdin 每行送一個 [`SidecarCommand`] JSON。Runner **一啟動就要接受指令**：
//!   Desktop 會在 spawn 後馬上送 `pause_claiming`，恢復使用者上次的暫停狀態，
//!   所以連上 Server 之前收到的指令也要生效。
//! - Server 網址與 Pairing token 以環境變數傳入（[`crate::names::ENV_SERVER_URL`]、
//!   [`crate::names::ENV_PAIRING_TOKEN`]），不放在命令列。
//! - stdin 關閉（EOF）視為 [`SidecarCommand::Shutdown`]：Desktop 當掉時 Runner 會自己結束，
//!   並結束它啟動的所有 Run。
//! - 結束碼：0＝正常結束；[`SIDECAR_EXIT_NEEDS_PAIRING`]＝Runner token 無效或已被撤銷，
//!   需要重新 Pairing（Desktop 不重啟，改為重新取得 Pairing token）；其他非 0 視為當掉。
//!
//! 和 Runner↔Server 的 frame 一樣，每一行都是以 `type` 區分種類的 JSON 物件。
//! 接收端遇到不認得的 `type` 或欄位要忽略，不能因此結束。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::wire_enum;
use crate::ids::RunnerId;

/// 啟用 sidecar 模式的命令列旗標。沒有這個旗標時，Runner 不輸出狀態行、不讀 stdin 指令。
pub const SIDECAR_FLAG: &str = "--sidecar";

/// Runner token 無效或已被撤銷、需要重新 Pairing 時的結束碼。
/// 取 BSD 的 `EX_CONFIG`（78），避免和參數錯誤（clap 為 2）、panic（101）、一般錯誤（1）混淆。
pub const SIDECAR_EXIT_NEEDS_PAIRING: i32 = 78;

/// Runner 寫到 stdout 的一行。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarOutput {
    /// 目前的狀態。狀態有變化時送出；Desktop 以最後收到的一行為準。
    Status(SidecarStatus),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct SidecarStatus {
    pub state: SidecarConnectionState,
    /// Pairing 完成後才有。
    pub runner_id: Option<RunnerId>,
    /// 目前正在執行的 Run 數。
    pub active_runs: u32,
    /// 是否已暫停領取新的 Run（[`SidecarCommand::PauseClaiming`]）。
    pub claiming_paused: bool,
}

wire_enum! {
    /// Runner 與 Server 的連線狀態。
    SidecarConnectionState {
        /// 正在連線，或斷線後等待重新連線。
        Connecting => "connecting",
        /// 已完成 Hello，可以領取 Dispatch。
        Connected => "connected",
        /// 連不上 Server。
        Offline => "offline",
    }
}

/// Desktop 寫到 stdin 的一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarCommand {
    /// 不再領取新的 Run；正在執行的 Run 不受影響。Runner 會在心跳中回報
    /// `accepting_dispatches: false`（[`crate::connection::Heartbeat`]）。
    PauseClaiming,
    /// 恢復領取新的 Run。
    ResumeClaiming,
    /// 結束 Runner：先結束所有 Run 的程序樹，再以結束碼 0 結束。
    Shutdown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_line_is_tagged_with_type() {
        let line = SidecarOutput::Status(SidecarStatus {
            state: SidecarConnectionState::Connected,
            runner_id: Some("0192f3a0-0000-7000-8000-000000000001".into()),
            active_runs: 2,
            claiming_paused: false,
        });
        assert_eq!(
            serde_json::to_value(&line).unwrap(),
            serde_json::json!({
                "type": "status",
                "state": "connected",
                "runner_id": "0192f3a0-0000-7000-8000-000000000001",
                "active_runs": 2,
                "claiming_paused": false,
            })
        );
    }

    #[test]
    fn commands_parse_from_json_lines() {
        for (line, expected) in [
            (
                r#"{"type":"pause_claiming"}"#,
                SidecarCommand::PauseClaiming,
            ),
            (
                r#"{"type":"resume_claiming"}"#,
                SidecarCommand::ResumeClaiming,
            ),
            (r#"{"type":"shutdown"}"#, SidecarCommand::Shutdown),
        ] {
            assert_eq!(
                serde_json::from_str::<SidecarCommand>(line).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn exit_code_does_not_collide_with_common_codes() {
        assert!(![0, 1, 2, 101].contains(&SIDECAR_EXIT_NEEDS_PAIRING));
    }
}
