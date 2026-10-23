//! 管理這台 Runner 上的所有 Run：驗證並接受 Dispatch、把 RunControl 交給對應的 Run、
//! 回報 Heartbeat 與 AgentAvailability（ARCHITECTURE §6.1、§7）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use orbis_protocol::availability::{AgentAvailability, AgentInfo, CredentialInfo};
use orbis_protocol::connection::Heartbeat;
use orbis_protocol::control::{
    RunControl, RunControlAction, RunControlOutcome, RunControlRejectReason, RunControlResult,
};
use orbis_protocol::dispatch::{
    DispatchAccept, DispatchOffer, DispatchReject, DispatchRejectReason,
};
use orbis_protocol::enums::RunStatus;
use orbis_protocol::event::{EventKind, RunErrorCode};
use orbis_protocol::frame::RunnerToServer;
use orbis_protocol::ids::RunId;
use tokio::sync::{mpsc, watch};

use crate::agent::{self, Profiles};
use crate::connection::now;
use crate::home::RunnerHome;
use crate::outbox::Outbox;
use crate::preview::PreviewRegistry;
use crate::run::{self, RunContext, RunHandle, RunInput};
use crate::worktree::WorktreeManager;

/// Supervisor 的狀態變化（sidecar 用來輸出狀態）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub active_runs: u32,
    pub claiming_paused: bool,
}

pub struct Supervisor {
    home: Arc<RunnerHome>,
    worktrees: Arc<WorktreeManager>,
    outbox: Arc<Outbox>,
    profiles: Profiles,
    runs: Mutex<HashMap<RunId, RunHandle>>,
    frames: mpsc::UnboundedSender<RunnerToServer>,
    previews: Arc<PreviewRegistry>,
    paused: watch::Sender<bool>,
    snapshot: watch::Sender<Snapshot>,
    detected: tokio::sync::Mutex<Option<Vec<(String, agent::Detected)>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Supervisor {
    /// 建立 Supervisor。回傳的 receiver 是要送給 Server 的非 Event frame（RunControlResult 等）。
    pub fn new(
        home: Arc<RunnerHome>,
    ) -> anyhow::Result<(Arc<Self>, mpsc::UnboundedReceiver<RunnerToServer>)> {
        let outbox = Arc::new(Outbox::open(home.spool_dir())?);
        let (frames, frames_rx) = mpsc::unbounded_channel();
        let profiles = Profiles::from_settings(home.settings());
        let supervisor = Arc::new(Self {
            worktrees: Arc::new(WorktreeManager::new(home.clone())),
            home,
            outbox,
            profiles,
            runs: Mutex::new(HashMap::new()),
            frames,
            previews: PreviewRegistry::new(),
            paused: watch::Sender::new(false),
            snapshot: watch::Sender::new(Snapshot {
                active_runs: 0,
                claiming_paused: false,
            }),
            detected: tokio::sync::Mutex::new(None),
        });
        supervisor.recover();
        Ok((supervisor, frames_rx))
    }

    pub fn outbox(&self) -> &Arc<Outbox> {
        &self.outbox
    }

    pub fn home(&self) -> &Arc<RunnerHome> {
        &self.home
    }

    /// 正在執行的 Preview（Preview 的 relay 使用）。
    pub fn previews(&self) -> &Arc<PreviewRegistry> {
        &self.previews
    }

    /// 上次 Runner 結束時還在進行的 Run：Agent 已經不在了，補上失敗的 Event 讓 Server 知道。
    fn recover(&self) {
        for (run_id, _dispatch, last) in self.outbox.recovered_runs() {
            let terminal = matches!(
                last,
                Some(EventKind::StatusChanged { status, .. }) if status.is_terminal()
            );
            if terminal {
                continue;
            }
            let message = "Runner 重新啟動，進行中的 Run 已中止".to_owned();
            for kind in [
                EventKind::Error {
                    code: RunErrorCode::AgentCrashed,
                    message: message.clone(),
                    fatal: true,
                },
                EventKind::StatusChanged {
                    status: RunStatus::Failed,
                    gate: None,
                    message: Some(message.clone()),
                },
            ] {
                if let Err(e) = self.outbox.emit(&run_id, now(), kind) {
                    tracing::warn!(error = %e, "無法補上 Run 中止的 Event");
                }
            }
        }
    }

    pub fn snapshot(&self) -> watch::Receiver<Snapshot> {
        self.snapshot.subscribe()
    }

    fn publish_snapshot(&self) {
        let active = self.active_run_ids().len() as u32;
        self.snapshot.send_replace(Snapshot {
            active_runs: active,
            claiming_paused: *self.paused.borrow(),
        });
    }

    /// 暫停／恢復領取新的 Run（sidecar 的指令）。
    pub fn set_paused(&self, paused: bool) {
        self.paused.send_replace(paused);
        self.publish_snapshot();
    }

    pub fn is_paused(&self) -> bool {
        *self.paused.borrow()
    }

    pub fn active_run_ids(&self) -> Vec<RunId> {
        let mut ids: Vec<RunId> = lock(&self.runs)
            .values()
            .filter(|h| h.is_active())
            .map(|h| h.run_id.clone())
            .collect();
        ids.sort();
        ids
    }

    pub fn heartbeat(&self) -> Heartbeat {
        self.publish_snapshot();
        Heartbeat {
            ts: now(),
            active_run_ids: self.active_run_ids(),
            accepting_dispatches: !self.is_paused(),
        }
    }

    async fn detected(&self) -> Vec<(String, agent::Detected)> {
        let mut cache = self.detected.lock().await;
        if let Some(list) = cache.as_ref() {
            return list.clone();
        }
        let mut list = Vec::new();
        for profile in self.profiles.iter() {
            list.push((profile.id.clone(), agent::detect(profile).await));
        }
        *cache = Some(list.clone());
        list
    }

    /// 這台 Runner 能跑的 Agent 與各 Credential 的並行狀況。
    pub async fn availability(&self) -> AgentAvailability {
        let detected = self.detected().await;
        let runs = lock(&self.runs);
        let active_by_credential = |label: &str| {
            runs.values()
                .filter(|h| h.is_active() && h.credential == label)
                .count() as u32
        };
        let mut agents = Vec::new();
        let mut credentials: Vec<CredentialInfo> = Vec::new();
        for profile in self.profiles.iter() {
            let found = detected
                .iter()
                .find(|(id, _)| id == &profile.id)
                .map(|(_, d)| d);
            let (available, version, reason) = found
                .map_or((false, None, Some("尚未偵測".into())), |d| {
                    (d.available, d.version.clone(), d.unavailable_reason.clone())
                });
            agents.push(AgentInfo {
                id: profile.id.clone(),
                version,
                available,
                unavailable_reason: reason,
                // 能力旗標要等 `initialize` 才知道；Agent 啟動後以 Run 的 log 記錄。
                // TODO(A2, #18)：啟動時先跑一次 initialize，回報實際的能力旗標。
                capabilities: Vec::new(),
                models: Vec::new(),
                permission_gaps: profile.permission_gaps.clone(),
                credential: Some(profile.credential.clone()),
            });
            if !credentials.iter().any(|c| c.label == profile.credential) {
                credentials.push(CredentialInfo {
                    label: profile.credential.clone(),
                    max_concurrent_runs: profile.max_concurrent_runs,
                    active_runs: active_by_credential(&profile.credential),
                });
            }
        }
        AgentAvailability {
            agents,
            credentials,
        }
    }

    /// 處理 DispatchOffer：驗證後接受並啟動 Run，或拒絕。回傳要送給 Server 的 frame。
    pub async fn handle_offer(&self, offer: DispatchOffer) -> RunnerToServer {
        match self.validate(&offer).await {
            Err((reason, message)) => {
                tracing::warn!(dispatch_id = %offer.dispatch_id, ?reason, %message, "拒絕 Dispatch");
                RunnerToServer::DispatchReject(DispatchReject {
                    dispatch_id: offer.dispatch_id,
                    reason,
                    message,
                })
            }
            Ok(profile) => {
                tracing::info!(
                    dispatch_id = %offer.dispatch_id,
                    run_id = %offer.run_id,
                    agent = %offer.agent,
                    "接受 Dispatch"
                );
                let accept = RunnerToServer::DispatchAccept(DispatchAccept {
                    dispatch_id: offer.dispatch_id.clone(),
                });
                self.outbox
                    .open_run(&offer.run_id, &offer.dispatch_id, offer.last_event_seq + 1);
                let handle = run::spawn(
                    offer,
                    profile,
                    RunContext {
                        home: self.home.clone(),
                        worktrees: self.worktrees.clone(),
                        outbox: self.outbox.clone(),
                        frames: self.frames.clone(),
                        previews: self.previews.clone(),
                    },
                );
                lock(&self.runs).insert(handle.run_id.clone(), handle);
                self.publish_snapshot();
                accept
            }
        }
    }

    async fn validate(
        &self,
        offer: &DispatchOffer,
    ) -> Result<agent::AgentProfile, (DispatchRejectReason, String)> {
        if is_expired(&offer.expires_at.0) {
            return Err((
                DispatchRejectReason::Expired,
                format!("Dispatch 已在 {} 過期", offer.expires_at.0),
            ));
        }
        if lock(&self.runs)
            .get(&offer.run_id)
            .is_some_and(RunHandle::is_active)
        {
            return Err((
                DispatchRejectReason::Duplicate,
                format!("這台 Runner 已在執行 Run {}", offer.run_id),
            ));
        }
        if self.is_paused() {
            return Err((
                DispatchRejectReason::AgentUnavailable,
                "這台 Runner 已暫停領取新的 Run".into(),
            ));
        }
        if offer.delegation.is_some() {
            return Err((
                DispatchRejectReason::Unsupported,
                "Delegation（Child Run）尚未支援".into(),
            ));
        }
        let Some(profile) = self.profiles.get(&offer.agent).cloned() else {
            return Err((
                DispatchRejectReason::AgentUnavailable,
                format!("這台 Runner 沒有 Agent {}", offer.agent),
            ));
        };
        let detected = self.detected().await;
        if let Some((_, d)) = detected.iter().find(|(id, _)| id == &profile.id)
            && !d.available
        {
            return Err((
                DispatchRejectReason::AgentUnavailable,
                format!(
                    "Agent {} 無法使用：{}",
                    profile.id,
                    d.unavailable_reason.clone().unwrap_or_default()
                ),
            ));
        }
        let active = lock(&self.runs)
            .values()
            .filter(|h| h.is_active() && h.credential == profile.credential)
            .count() as u32;
        if active >= profile.max_concurrent_runs {
            return Err((
                DispatchRejectReason::ConcurrencyLimit,
                format!(
                    "Credential {} 已達並行上限 {}",
                    profile.credential, profile.max_concurrent_runs
                ),
            ));
        }
        Ok(profile)
    }

    /// 把 RunControl 交給對應的 Run；沒有這個 Run 或 Dispatch 不符時直接拒絕。
    pub fn handle_control(&self, control: RunControl) {
        let runs = lock(&self.runs);
        let reject = |reason, message: String| {
            let _ = self
                .frames
                .send(RunnerToServer::RunControlResult(RunControlResult {
                    control_id: control.control_id.clone(),
                    run_id: control.run_id.clone(),
                    dispatch_id: control.dispatch_id.clone(),
                    outcome: RunControlOutcome::Rejected { reason, message },
                }));
        };
        let Some(handle) = runs.get(&control.run_id) else {
            return reject(
                RunControlRejectReason::UnknownRun,
                format!("這台 Runner 上沒有 Run {}", control.run_id),
            );
        };
        if handle.dispatch_id != control.dispatch_id {
            return reject(
                RunControlRejectReason::StaleDispatch,
                format!(
                    "Dispatch {} 不是這個 Run 目前的 Dispatch",
                    control.dispatch_id
                ),
            );
        }
        // 重新啟動 Preview（§13）在 Run 的任何狀態都可以做，不經過 Run 的狀態機
        if matches!(control.action, RunControlAction::RestartPreview) {
            if !handle.is_active() {
                return reject(RunControlRejectReason::InvalidState, "Run 已經結束".into());
            }
            if !self.previews.restart(&control.run_id) {
                return reject(
                    RunControlRejectReason::InvalidState,
                    "這個 Run 沒有設定 Preview".into(),
                );
            }
            let _ = self
                .frames
                .send(RunnerToServer::RunControlResult(RunControlResult {
                    control_id: control.control_id.clone(),
                    run_id: control.run_id.clone(),
                    dispatch_id: control.dispatch_id.clone(),
                    outcome: RunControlOutcome::Applied,
                }));
            return;
        }
        if handle.tx.send(RunInput::Control(control.clone())).is_err() {
            reject(RunControlRejectReason::InvalidState, "Run 已經結束".into());
        }
    }

    /// 新的連線完成交握：依 `resume` 補送 Event；Server 已不認得的 Run 一律中止（不再送 Event）。
    pub fn on_connected(&self, resume: &[orbis_protocol::connection::RunResume]) {
        let orphaned = self.outbox.begin_connection(resume);
        let mut runs = lock(&self.runs);
        for run_id in orphaned {
            if let Some(handle) = runs.remove(&run_id) {
                tracing::warn!(run_id = %run_id, "Server 已不認得這個 Run，中止");
                let _ = handle.tx.send(RunInput::Shutdown);
            }
        }
        drop(runs);
        self.publish_snapshot();
    }

    /// Runner 結束：中止所有 Run（結束 Agent 的程序樹）。
    pub async fn shutdown(&self) {
        let handles: Vec<RunHandle> = lock(&self.runs).drain().map(|(_, h)| h).collect();
        for handle in &handles {
            let _ = handle.tx.send(RunInput::Shutdown);
        }
        for handle in handles {
            let _ = tokio::time::timeout(Duration::from_secs(15), handle.task).await;
        }
    }
}

/// `expires_at`（RFC 3339）是否已經過了。無法解析時視為未過期，交給 Server 判斷。
fn is_expired(expires_at: &str) -> bool {
    humantime::parse_rfc3339_weak(expires_at.trim_end_matches('Z'))
        .or_else(|_| humantime::parse_rfc3339(expires_at))
        .is_ok_and(|t| t <= SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 判斷過期() {
        assert!(is_expired("2000-01-01T00:00:00.000Z"));
        assert!(!is_expired("2999-01-01T00:00:00.000Z"));
        assert!(!is_expired("不是時間"));
    }
}
