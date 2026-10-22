//! Desktop（E1）代管 Runner 時的 stdio 協定，只在 `--sidecar` 時啟用。
//!
//! - stdout：每行一個 JSON 狀態（[`SidecarStatus`]），狀態改變時輸出。log 一律走 stderr。
//! - stdin：每行一個 JSON 指令（[`SidecarCommand`]）：`pause_claiming`、`resume_claiming`、`shutdown`。
//!   stdin EOF 也視為 `shutdown`（Electron 當掉時 Runner 自己結束，並結束自己的 Run）。
//! - 結束碼：見 [`ExitCode`]。

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;

use crate::contract::{SidecarCommand, SidecarState, SidecarStatus};
use crate::supervisor::Supervisor;

/// Runner 的結束碼（E1 依此決定要不要重新啟動）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCode {
    /// 正常結束（收到 shutdown、stdin EOF 或中斷訊號）。
    Normal = 0,
    /// 其他錯誤（E1 可以重新啟動）。
    Error = 1,
    /// Server 拒絕 Pairing token／Runner token，或沒有可用的身分：需要重新 Pairing，不要直接重啟。
    NeedsPairing = 2,
    /// 協定版本不相容：需要更新 Runner，不要直接重啟。
    VersionMismatch = 3,
}

/// 狀態輸出：連線狀態或 Supervisor 的狀態改變時，在 stdout 寫一行 JSON。
pub async fn report_status(
    supervisor: Arc<Supervisor>,
    mut connection: watch::Receiver<(SidecarState, Option<String>)>,
) {
    let mut snapshot = supervisor.snapshot();
    let mut stdout = tokio::io::stdout();
    let mut last: Option<SidecarStatus> = None;
    loop {
        let (state, runner_id) = connection.borrow_and_update().clone();
        let snap = snapshot.borrow_and_update().clone();
        let status = SidecarStatus {
            state,
            runner_id,
            active_runs: snap.active_runs,
            claiming_paused: snap.claiming_paused,
        };
        if last.as_ref() != Some(&status) {
            if let Ok(mut line) = serde_json::to_string(&status) {
                line.push('\n');
                if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err()
                {
                    return;
                }
            }
            last = Some(status);
        }
        tokio::select! {
            r = connection.changed() => if r.is_err() { return },
            r = snapshot.changed() => if r.is_err() { return },
        }
    }
}

/// 讀 stdin 的指令。收到 `shutdown` 或 EOF 時把 `shutdown` 設為 `true`。
pub async fn read_commands(supervisor: Arc<Supervisor>, shutdown: watch::Sender<bool>) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) if line.trim().is_empty() => {}
            Ok(Some(line)) => match serde_json::from_str::<SidecarCommand>(&line) {
                Ok(SidecarCommand::PauseClaiming) => supervisor.set_paused(true),
                Ok(SidecarCommand::ResumeClaiming) => supervisor.set_paused(false),
                Ok(SidecarCommand::Shutdown) => break,
                Err(e) => tracing::warn!(error = %e, line, "無法解析 sidecar 指令，略過"),
            },
            Ok(None) | Err(_) => {
                tracing::info!("stdin 已關閉，結束 Runner");
                break;
            }
        }
    }
    shutdown.send_replace(true);
}
