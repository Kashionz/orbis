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

use crate::agent::acp::AcpSession;
use crate::agent::{self, Learned, LearnedAgents, Profiles};
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
    /// 自己（父 Run 結束時中止 Child Run 的背景工作用）。
    me: std::sync::Weak<Supervisor>,
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
    /// 從 `initialize` 得知的能力旗標與版本（issue #18）。
    learned: Arc<LearnedAgents>,
    /// AgentAvailability 的內容改變了（並行數、能力旗標），連線要重送一次完整清單。
    availability_changed: Arc<tokio::sync::Notify>,
    /// 各組 Credential 的 rate limit（issue #33）。
    rate_limits: Arc<crate::rate_limit::RateLimits>,
    /// 從 Server 下載 blob（prompt 中的圖片）。
    blobs: Arc<crate::blobs::BlobFetcher>,
    /// Orbis MCP 的工具呼叫（ARCHITECTURE §9）。
    mcp: Arc<crate::orbis_mcp::hub::McpHub>,
    /// 已經開始探測 Agent 的能力旗標（第一次連上 Server 後才開始）。
    probing: std::sync::atomic::AtomicBool,
    /// 模型目錄（session 回報的 config option 與登入狀態，ARCHITECTURE §7）。
    catalog: Arc<crate::catalog::CatalogStore>,
    /// 上次看到的「由 Runner 代為登入」的登入標記。`<Runner> login` 是另一個程序（例如 Desktop 執行的），
    /// Heartbeat 時比對，有變化就重送 AgentAvailability。
    login_seen: Mutex<Option<Vec<(String, bool)>>>,
}

/// 啟動時探測一個 Agent 的逾時：Agent 第一次啟動可能比較慢，逾時只記 log、不當成無法使用。
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

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
        let mcp = crate::orbis_mcp::hub::McpHub::start(frames.clone(), outbox.clone())?;
        let catalog = Arc::new(crate::catalog::CatalogStore::new(home.agents_dir()));
        let supervisor = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            catalog,
            login_seen: Mutex::new(None),
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
            learned: Arc::new(LearnedAgents::default()),
            availability_changed: Arc::new(tokio::sync::Notify::new()),
            rate_limits: Arc::new(crate::rate_limit::RateLimits::default()),
            blobs: Arc::new(crate::blobs::BlobFetcher::default()),
            mcp,
            probing: std::sync::atomic::AtomicBool::new(false),
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

    /// Orbis MCP 的 hub（連線收到 `tool_result` 時交給它）。
    pub fn mcp(&self) -> &Arc<crate::orbis_mcp::hub::McpHub> {
        &self.mcp
    }

    /// 下載 blob 用的 client（連線交握後設定 Server 網址與 Runner token）。
    pub fn blobs(&self) -> &Arc<crate::blobs::BlobFetcher> {
        &self.blobs
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
        self.check_logins();
        Heartbeat {
            ts: now(),
            active_run_ids: self.active_run_ids(),
            accepting_dispatches: !self.is_paused(),
        }
    }

    /// 「由 Runner 代為登入」的 Agent 的登入標記有變化（另一個程序執行了 `<Runner> login`）時，
    /// 重送 AgentAvailability（ARCHITECTURE §7「重新登入」）。
    fn check_logins(&self) {
        let now: Vec<(String, bool)> = self
            .profiles
            .iter()
            .filter(|p| p.auth_method.is_some())
            .map(|p| (p.id.clone(), crate::login::logged_in(&self.home, &p.id)))
            .collect();
        let mut seen = lock(&self.login_seen);
        if seen.as_ref().is_some_and(|before| *before != now) {
            tracing::info!("Agent 的登入狀態改變，重送 AgentAvailability");
            self.availability_changed.notify_one();
        }
        *seen = Some(now);
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

    /// 探測每個偵測為可用的 Agent；無法啟動的改成無法使用。完成後通知重送 AgentAvailability。
    async fn probe_all(&self) {
        let detected = self.detected().await;
        let mut failed = Vec::new();
        for profile in self.profiles.iter() {
            let available = detected
                .iter()
                .any(|(id, d)| id == &profile.id && d.available);
            if available && let Err(reason) = self.probe(profile).await {
                tracing::warn!(agent = %profile.id, %reason, "Agent 無法啟動");
                failed.push((profile.id.clone(), reason));
            }
        }
        if !failed.is_empty() {
            let mut cache = self.detected.lock().await;
            for (id, d) in cache.iter_mut().flatten() {
                if let Some((_, reason)) = failed.iter().find(|(f, _)| f == id) {
                    d.available = false;
                    d.unavailable_reason = Some(reason.clone());
                }
            }
        }
        self.availability_changed.notify_one();
    }

    /// 啟動 Agent 跑一次 `initialize`，記下實際的能力旗標（issue #18）。Runner 代管、還沒安裝的
    /// adapter 跳過（第一次派工時才安裝，之後由 Run 更新）。回傳 `Err` 表示 Agent 無法啟動。
    async fn probe(&self, profile: &agent::AgentProfile) -> Result<(), String> {
        let agents_dir = self.home.agents_dir();
        if !profile.launch.installed(&agents_dir) {
            return Ok(());
        }
        let spec = profile
            .launch_spec(&agents_dir)
            .map_err(|e| format!("無法啟動：{e:#}"))?
            .unattended_git();
        // 在 Runner 狀態目錄下一個全新的空目錄中探測：共用的暫存目錄可能有別人放的設定檔
        // （Agent 會讀 cwd 的專案設定）。
        let cwd = self.home.state_dir().join("probe").join(&profile.id);
        let _ = std::fs::remove_dir_all(&cwd);
        std::fs::create_dir_all(&cwd).map_err(|e| format!("無法建立 {}：{e}", cwd.display()))?;
        let result =
            tokio::time::timeout(PROBE_TIMEOUT, AcpSession::probe(profile, spec, &cwd)).await;
        let _ = std::fs::remove_dir_all(&cwd);
        match result {
            Ok(Ok(probe)) => {
                self.learned.record(
                    &profile.id,
                    Learned {
                        capabilities: probe.capabilities,
                        version: probe.agent_info.map(|(_, version)| version),
                    },
                );
                Ok(())
            }
            Ok(Err(error)) => Err(format!("無法啟動：{error}")),
            Err(_) => {
                tracing::warn!(agent = %profile.id, "探測 Agent 逾時，能力旗標要等第一次派工後才知道");
                Ok(())
            }
        }
    }

    /// 等到 AgentAvailability 的內容改變（連線收到後重送一次完整清單）。
    pub async fn availability_changed(&self) {
        self.availability_changed.notified().await;
    }

    /// 這台 Runner 能跑的 Agent 與各 Credential 的並行狀況。
    pub async fn availability(&self) -> AgentAvailability {
        let detected = self.detected().await;
        let runs = lock(&self.runs);
        let active_by_credential = |label: &str| {
            runs.values()
                .filter(|h| h.is_active() && h.credential() == label)
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
            let learned = self.learned.get(&profile.id).unwrap_or_default();
            // 需要由 Runner 代為登入的 Agent：登入之前無法使用。
            let (available, reason) = match crate::login::unavailable_reason(&self.home, profile) {
                Some(login) if available => (false, Some(login)),
                _ => (available, reason),
            };
            // 同一組 Credential 撞到 rate limit：到恢復時間之前不接受這個 Agent 的 Dispatch。
            let (available, reason) = match self.rate_limits.active(&profile.credential) {
                Some(until) if available => (
                    false,
                    Some(format!(
                        "額度用完，預計 {} 恢復",
                        crate::rate_limit::display_time(until)
                    )),
                ),
                _ => (available, reason),
            };
            let entry = self.catalog.get(&profile.id);
            // 由 Runner 代為登入的 Agent 看登入標記；其他看最近一次 session 的結果（還沒跑過時不知道）。
            let signed_in = if profile.auth_method.is_some() {
                Some(crate::login::logged_in(&self.home, &profile.id))
            } else {
                entry.signed_in
            };
            agents.push(AgentInfo {
                id: profile.id.clone(),
                version: version.or(learned.version),
                available,
                unavailable_reason: reason,
                // 啟動時探測的結果；還沒探測過（代管的 adapter 尚未安裝）時，第一次派工後更新。
                capabilities: learned.capabilities,
                models: crate::catalog::model_infos(profile, &entry),
                permission_gaps: profile.permission_gaps.clone(),
                credential: Some(profile.credential.clone()),
                display_name: profile.display_name.clone(),
                vendor: profile.vendor.map(str::to_owned),
                cli: profile.cli.map(str::to_owned),
                signed_in,
                login_hint: profile.login_hint.clone(),
            });
            if !credentials.iter().any(|c| c.label == profile.credential) {
                credentials.push(CredentialInfo {
                    label: profile.credential.clone(),
                    max_concurrent_runs: profile.max_concurrent_runs,
                    active_runs: active_by_credential(&profile.credential),
                });
            }
        }
        let mut mapped_repos: Vec<String> = self.home.settings().repos.keys().cloned().collect();
        mapped_repos.sort();
        AgentAvailability {
            agents,
            credentials,
            mapped_repos,
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
                        learned: self.learned.clone(),
                        availability_changed: self.availability_changed.clone(),
                        rate_limits: self.rate_limits.clone(),
                        blobs: self.blobs.clone(),
                        mcp: self.mcp.clone(),
                        catalog: self.catalog.clone(),
                    },
                );
                // 父 Run 結束（中止、失敗、完成或 Runner 不再執行它）時，連同 Child Run 一起中止（§9）。
                let mut status = handle.status.clone();
                let me = self.me.clone();
                let ended = handle.run_id.clone();
                tokio::spawn(async move {
                    let _ = status.wait_for(|s| s.is_terminal()).await;
                    if let Some(supervisor) = me.upgrade() {
                        supervisor.cancel_children(&ended);
                    }
                });
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
        // 本機 Repo 只依 runner.toml 的 [repos.<名稱>] 找 checkout（ARCHITECTURE §6.2）。
        if offer.repo.kind() == orbis_protocol::enums::RepoKind::Local
            && let Err(message) = self.local_checkout(offer.repo.name())
        {
            return Err((DispatchRejectReason::RepoUnavailable, message));
        }
        if let Some(delegation) = &offer.delegation {
            use crate::orbis_mcp::hub::{MAX_CHILDREN, MAX_DEPTH};
            if delegation.depth.unwrap_or(1) > MAX_DEPTH {
                return Err((
                    DispatchRejectReason::Unsupported,
                    format!("Delegation 最多 {MAX_DEPTH} 層"),
                ));
            }
            if self.mcp.caller(&delegation.parent_run_id).is_none() {
                return Err((
                    DispatchRejectReason::Unsupported,
                    format!(
                        "父 Run {} 不在這台 Runner 上執行（Child Run 一律在父 Run 的 Runner 上執行）",
                        delegation.parent_run_id
                    ),
                ));
            }
            let children = lock(&self.runs)
                .values()
                .filter(|h| h.is_active() && h.parent.as_ref() == Some(&delegation.parent_run_id))
                .count();
            if children >= MAX_CHILDREN {
                return Err((
                    DispatchRejectReason::Unsupported,
                    format!("每個 Run 同時最多 {MAX_CHILDREN} 個 Child Run"),
                ));
            }
        }
        self.usable_agent(&offer.agent, None).await
    }

    /// 這台 Runner 現在能不能用 `agent`（派工與換 Agent 共用）：有這個 Agent Profile、偵測為可用、
    /// 需要時已登入、Credential 沒有在 rate limit 中、沒有超過並行上限。`except` 是換 Agent 的 Run 本身
    /// （它原本佔用的名額不算）。
    async fn usable_agent(
        &self,
        agent: &str,
        except: Option<&RunId>,
    ) -> Result<agent::AgentProfile, (DispatchRejectReason, String)> {
        let Some(profile) = self.profiles.get(agent).cloned() else {
            return Err((
                DispatchRejectReason::AgentUnavailable,
                format!("這台 Runner 沒有 Agent {agent}"),
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
        if let Some(reason) = crate::login::unavailable_reason(&self.home, &profile) {
            return Err((
                DispatchRejectReason::AgentUnavailable,
                format!("Agent {} 無法使用：{reason}", profile.id),
            ));
        }
        if let Some(until) = self.rate_limits.active(&profile.credential) {
            return Err((
                DispatchRejectReason::RateLimited,
                format!(
                    "Credential {} 的額度用完，預計 {} 恢復",
                    profile.credential,
                    crate::rate_limit::display_time(until)
                ),
            ));
        }
        let active = lock(&self.runs)
            .values()
            .filter(|h| {
                h.is_active() && Some(&h.run_id) != except && h.credential() == profile.credential
            })
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

    /// `switch_agent`：確認這台 Runner 能用新的 Agent 後交給 Run（附上 Agent Profile），不能用時
    /// 回 `rejected(failed)`（ARCHITECTURE §7）。
    async fn handle_switch(&self, control: RunControl) {
        let RunControlAction::SwitchAgent { agent, .. } = &control.action else {
            return;
        };
        let reject = |message: String| {
            let _ = self
                .frames
                .send(RunnerToServer::RunControlResult(RunControlResult {
                    control_id: control.control_id.clone(),
                    run_id: control.run_id.clone(),
                    dispatch_id: control.dispatch_id.clone(),
                    outcome: RunControlOutcome::Rejected {
                        reason: RunControlRejectReason::Failed,
                        message,
                    },
                }));
        };
        let profile = match self.usable_agent(agent, Some(&control.run_id)).await {
            Ok(profile) => profile,
            Err((_, message)) => return reject(message),
        };
        let sent = lock(&self.runs).get(&control.run_id).map(|handle| {
            handle.tx.send(RunInput::Switch {
                control: control.clone(),
                profile: Box::new(profile),
            })
        });
        if !matches!(sent, Some(Ok(()))) {
            reject("Run 已經結束".into());
        }
    }

    /// 本機 Repo 在 `runner.toml` 中對應的 checkout；沒有對應或不是 git checkout 時回傳原因。
    fn local_checkout(&self, name: &str) -> Result<std::path::PathBuf, String> {
        let Some(path) = self.home.settings().local_checkout(name) else {
            return Err(format!(
                "runner.toml 中沒有本機 Repo {name} 的對應（[repos.{name}]）"
            ));
        };
        let path = crate::paths::normalize(path);
        if !path.join(".git").exists() {
            return Err(format!(
                "runner.toml 中 {name} 對應的 {} 不是 git checkout",
                path.display()
            ));
        }
        Ok(path)
    }

    /// 本機 Repo 的 Repo Spec 提交（frame `repo_spec_commit`，ARCHITECTURE §12.1）：在背景 commit 到
    /// 基準分支，回 `repo_spec_commit_result`。
    pub fn handle_repo_spec_commit(&self, commit: orbis_protocol::repo_spec::RepoSpecCommit) {
        let Some(me) = self.me.upgrade() else {
            return;
        };
        tokio::spawn(async move {
            let outcome = me.repo_spec_commit(&commit).await;
            let _ = me.frames.send(RunnerToServer::RepoSpecCommitResult(
                orbis_protocol::repo_spec::RepoSpecCommitResult {
                    commit_id: commit.commit_id,
                    outcome,
                },
            ));
        });
    }

    async fn repo_spec_commit(
        &self,
        commit: &orbis_protocol::repo_spec::RepoSpecCommit,
    ) -> orbis_protocol::repo_spec::RepoSpecCommitOutcome {
        use crate::local_merge::{LocalError, SpecCommit};
        use orbis_protocol::repo_spec::{RepoSpecCommitFailure, RepoSpecCommitOutcome};
        let failed = |reason, message: String| RepoSpecCommitOutcome::Failed {
            reason,
            message: crate::secrets::Redactor::new().redact(&message),
        };
        let checkout = match self.local_checkout(&commit.repo) {
            Ok(path) => path,
            Err(message) => return failed(RepoSpecCommitFailure::RepoUnavailable, message),
        };
        let path = match crate::local_merge::spec_path(&commit.path) {
            Ok(path) => path,
            Err(message) => return failed(RepoSpecCommitFailure::Failed, message),
        };
        let invalid_branch = commit.base_branch.is_empty()
            || commit.base_branch.starts_with('-')
            || !crate::git::Git::new(".")
                .succeeds(["check-ref-format", "--branch", &commit.base_branch])
                .await;
        if invalid_branch {
            return failed(
                RepoSpecCommitFailure::Failed,
                format!("基準分支 {:?} 不合法", commit.base_branch),
            );
        }
        let temp_root = match crate::worktree::path_segment(&commit.repo, "Repo 名稱") {
            Ok(name) => self.worktrees.root().join(name),
            Err(e) => return failed(RepoSpecCommitFailure::Failed, e.message),
        };
        let lock = self.worktrees.repo_lock(&checkout);
        let _guard = lock.lock().await;
        match crate::local_merge::commit_file(
            &checkout,
            &temp_root,
            &commit.base_branch,
            &path,
            &commit.content,
            &commit.message,
        )
        .await
        {
            Ok(SpecCommit::Committed(commit_sha)) => {
                RepoSpecCommitOutcome::Committed { commit_sha }
            }
            Ok(SpecCommit::Unchanged(commit_sha)) => {
                RepoSpecCommitOutcome::Unchanged { commit_sha }
            }
            Err(e @ LocalError::Dirty { .. }) => {
                failed(RepoSpecCommitFailure::WorkingTreeDirty, e.to_string())
            }
            Err(e) => failed(RepoSpecCommitFailure::Failed, e.to_string()),
        }
    }

    /// 中止 `parent` 還在進行中的 Child Run（以 Runner 內部的 RunControl，不回 `run_control_result`）。
    fn cancel_children(&self, parent: &RunId) {
        for handle in lock(&self.runs).values() {
            if handle.parent.as_ref() != Some(parent) || !handle.is_active() {
                continue;
            }
            tracing::info!(run_id = %handle.run_id, parent = %parent, "父 Run 已結束，中止 Child Run");
            let _ = handle.tx.send(RunInput::Control(RunControl {
                control_id: format!(
                    "{}parent-ended-{}",
                    run::INTERNAL_CONTROL_PREFIX,
                    uuid::Uuid::now_v7()
                )
                .into(),
                run_id: handle.run_id.clone(),
                dispatch_id: handle.dispatch_id.clone(),
                action: orbis_protocol::control::RunControlAction::Cancel,
            }));
        }
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
        // 封存（§6.2）在 Run 結束後才做，Run 可能已經不在記憶體中：依本機的 Worktree 紀錄處理。
        if matches!(control.action, RunControlAction::Archive) {
            if let Some(handle) = runs.get(&control.run_id) {
                if handle.dispatch_id != control.dispatch_id {
                    return reject(
                        RunControlRejectReason::StaleDispatch,
                        format!(
                            "Dispatch {} 不是這個 Run 目前的 Dispatch",
                            control.dispatch_id
                        ),
                    );
                }
                if handle.is_active() {
                    return reject(
                        RunControlRejectReason::InvalidState,
                        "Run 還在執行，先取消再封存".into(),
                    );
                }
            } else if self
                .home
                .run_worktree(control.run_id.as_str())
                .is_some_and(|r| r.dispatch_id != control.dispatch_id.as_str())
            {
                return reject(
                    RunControlRejectReason::StaleDispatch,
                    format!(
                        "Dispatch {} 不是這個 Run 最後的 Dispatch",
                        control.dispatch_id
                    ),
                );
            }
            // 執行中的 Run 正在用的 Worktree（例如 Feedback Loop 的新 Run 沿用的）不能刪。
            let active: Vec<(String, std::path::PathBuf)> = runs
                .values()
                .filter(|h| h.is_active())
                .filter_map(|h| {
                    let record = self.home.run_worktree(h.run_id.as_str())?;
                    Some((h.run_id.to_string(), record.path))
                })
                .collect();
            drop(runs);
            let (home, worktrees, frames) = (
                self.home.clone(),
                self.worktrees.clone(),
                self.frames.clone(),
            );
            tokio::spawn(async move {
                let in_use = |path: &std::path::Path| {
                    active
                        .iter()
                        .find(|(_, p)| crate::paths::same_path(p, path))
                        .map(|(id, _)| id.clone())
                };
                let outcome = match crate::archive::archive(
                    &home,
                    &worktrees,
                    control.run_id.as_str(),
                    in_use,
                )
                .await
                {
                    Ok(()) => RunControlOutcome::Applied,
                    Err(e) => RunControlOutcome::Rejected {
                        reason: e.reason,
                        message: e.message,
                    },
                };
                let _ = frames.send(RunnerToServer::RunControlResult(RunControlResult {
                    control_id: control.control_id,
                    run_id: control.run_id,
                    dispatch_id: control.dispatch_id,
                    outcome,
                }));
            });
            return;
        }
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
        // 換 Agent 要先確認這台 Runner 能用新的 Agent（偵測、登入、並行數），在背景做完再交給 Run。
        if matches!(control.action, RunControlAction::SwitchAgent { .. }) {
            drop(runs);
            if let Some(me) = self.me.upgrade() {
                tokio::spawn(async move { me.handle_switch(control).await });
            }
            return;
        }
        if handle.tx.send(RunInput::Control(control.clone())).is_err() {
            reject(RunControlRejectReason::InvalidState, "Run 已經結束".into());
        }
    }

    /// 新的連線完成交握：依 `resume` 補送 Event；Server 已不認得的 Run 一律中止（不再送 Event）。
    pub fn on_connected(&self, resume: &[orbis_protocol::connection::RunResume]) {
        // 第一次被 Server 接受後，在背景探測各 Agent 的能力旗標：不拖慢第一次的 AgentAvailability
        // （每個 Agent 最多等 PROBE_TIMEOUT），探測完再重送一次。連線被拒絕的 Runner 會馬上結束，
        // 不啟動任何 Agent 程序（結束時還沒放進 Job Object 的子程序會留下來）。
        if !self.probing.swap(true, std::sync::atomic::Ordering::SeqCst)
            && let Some(me) = self.me.upgrade()
        {
            tokio::spawn(async move { me.probe_all().await });
        }
        let orphaned = self.outbox.begin_connection(resume);
        self.mcp.resend_pending();
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
