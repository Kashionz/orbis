//! 一個 Run 的生命週期（ARCHITECTURE §5、§6、§8）。
//!
//! ```text
//! starting ─ 建立 Worktree → worktree_ready → 信任核准（必要時問人）→ setup → 啟動 Agent
//!    │
//! running ─ 送出 prompt；權限請求依 Permission Policy 自動回覆或問人（awaiting_permission）
//!    │ 回合結束（end_turn）
//! run_diff → awaiting_gate(review)
//!    ├─ gate_result rejected ＋ prompt → 同一個 session 繼續（running）
//!    └─ gate_result approved → 結束 Agent、保留 Worktree → push_branch 成功 → completed
//! ```
//!
//! 任何時候收到 cancel：結束整個程序樹，Run 進入 `canceled`（保留 Worktree）。
//! 每次送出 prompt 前，先比對 Agent 自己的設定檔和 base commit，有差異就先問人。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use orbis_protocol::control::{
    RunControl, RunControlAction, RunControlOutcome, RunControlRejectReason, RunControlResult,
};
use orbis_protocol::dispatch::DispatchOffer;
use orbis_protocol::enums::{GateDecision, GateKind, RunStatus};
use orbis_protocol::event::{
    EventKind, PermissionOption, PermissionOptionKind, PermissionPurpose, RunErrorCode, TextBody,
    ToolCall, ToolCallContent, ToolCallStatus, ToolKind,
};
use orbis_protocol::frame::RunnerToServer;
use orbis_protocol::ids::{PermissionRequestId, RunId, Timestamp};
use tokio::sync::{mpsc, oneshot, watch};

use crate::agent::AgentProfile;
use crate::agent::acp::{AcpSession, AgentError, AgentNotice};
use crate::connection::now;
use crate::home::RunnerHome;
use crate::normalize::{self, Normalizer};
use crate::outbox::Outbox;
use crate::policy::{self, Decision, PolicyContext};
use crate::repo_config::CommitFields;
use crate::secrets::Redactor;
use crate::worktree::{Worktree, WorktreeManager, WorktreeRequest};

/// 送出 `session/cancel` 後等 Agent 自己結束回合的時間，超過就直接結束程序樹。
const CANCEL_GRACE: Duration = Duration::from_secs(10);
/// rate limit 沒有提供重試時間時的等待時間。
const DEFAULT_RATE_LIMIT_WAIT: Duration = Duration::from_secs(60);
/// rate limit 恢復後送給 Agent 的 prompt。
pub const RESUME_PROMPT: &str = "額度已恢復，請繼續剛才的工作。";
/// setup 的 tool call ID（Runner 自己產生）。
const SETUP_TOOL_CALL: &str = "orbis-setup";

/// Run 需要的共用元件。
#[derive(Clone)]
pub struct RunContext {
    pub home: Arc<RunnerHome>,
    pub worktrees: Arc<WorktreeManager>,
    pub outbox: Arc<Outbox>,
    /// RunControlResult 等非 Event 的 frame。
    pub frames: mpsc::UnboundedSender<RunnerToServer>,
}

/// 送給 Run 的訊息。
#[derive(Debug)]
pub enum RunInput {
    Control(RunControl),
    /// Runner 要結束：結束 Agent，不再送出 Event。
    Shutdown,
}

/// Supervisor 持有的 Run。
#[derive(Debug)]
pub struct RunHandle {
    pub run_id: RunId,
    pub dispatch_id: orbis_protocol::ids::DispatchId,
    pub agent: String,
    pub credential: String,
    pub tx: mpsc::UnboundedSender<RunInput>,
    pub status: watch::Receiver<RunStatus>,
    pub task: tokio::task::JoinHandle<()>,
}

impl RunHandle {
    pub fn is_active(&self) -> bool {
        !self.status.borrow().is_terminal() && !self.task.is_finished()
    }
}

/// 啟動一個 Run。呼叫端必須已經送出 DispatchAccept 並開啟 outbox 的暫存。
pub fn spawn(offer: DispatchOffer, profile: AgentProfile, ctx: RunContext) -> RunHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let (status_tx, status) = watch::channel(RunStatus::Starting);
    let handle_info = (
        offer.run_id.clone(),
        offer.dispatch_id.clone(),
        offer.agent.clone(),
        profile.credential.clone(),
    );
    let run = Run {
        redactor: Redactor::new(),
        offer,
        profile,
        ctx,
        rx,
        status_tx,
        worktree: None,
        normalizer: None,
        session: None,
        notices: None,
        pending: HashMap::new(),
        settings_baseline: HashMap::new(),
    };
    let task = tokio::spawn(run.main());
    RunHandle {
        run_id: handle_info.0,
        dispatch_id: handle_info.1,
        agent: handle_info.2,
        credential: handle_info.3,
        tx,
        status,
        task,
    }
}

/// Run 停下來的原因。
#[derive(Debug)]
enum Stop {
    Canceled,
    Failed {
        code: RunErrorCode,
        message: String,
    },
    /// Runner 要結束。
    Shutdown,
}

impl Stop {
    fn failed(code: RunErrorCode, message: impl Into<String>) -> Self {
        Self::Failed {
            code,
            message: message.into(),
        }
    }
}

/// 等待中的權限請求。
enum Pending {
    /// Agent 的權限請求，回覆會轉給 Agent。
    Agent {
        reply: oneshot::Sender<acp::RequestPermissionOutcome>,
        options: Vec<String>,
    },
}

/// 一個回合怎麼結束。
enum TurnEnd {
    Done(acp::StopReason),
    RateLimited {
        retry_after: Option<Duration>,
        message: String,
    },
}

struct Run {
    offer: DispatchOffer,
    profile: AgentProfile,
    ctx: RunContext,
    rx: mpsc::UnboundedReceiver<RunInput>,
    status_tx: watch::Sender<RunStatus>,
    worktree: Option<Worktree>,
    redactor: Redactor,
    normalizer: Option<Normalizer>,
    session: Option<AcpSession>,
    notices: Option<mpsc::UnboundedReceiver<AgentNotice>>,
    pending: HashMap<PermissionRequestId, Pending>,
    /// 受保護的 Agent 設定檔：已被接受的內容（`None` 表示檔案不存在）。
    settings_baseline: HashMap<String, Option<Vec<u8>>>,
}

impl Run {
    fn run_id(&self) -> &RunId {
        &self.offer.run_id
    }

    async fn main(mut self) {
        if self.offer.plan_gate {
            tracing::warn!(run_id = %self.run_id(), "Planning 屬於 A2，先忽略 plan_gate 直接執行");
        }
        self.set_status(RunStatus::Starting, None, None);
        let outcome = match self.start().await {
            Ok(()) => self.work().await,
            Err(stop) => Err(stop),
        };
        if let Some(session) = self.session.take() {
            session.shutdown().await;
        }
        match outcome {
            Ok(()) | Err(Stop::Shutdown) => {}
            Err(Stop::Canceled) => {
                self.set_status(RunStatus::Canceled, None, None);
            }
            Err(Stop::Failed { code, message }) => {
                let message = self.redactor.redact(&message);
                self.emit(EventKind::Error {
                    code,
                    message: message.clone(),
                    fatal: true,
                });
                self.set_status(RunStatus::Failed, None, Some(message));
            }
        }
        // 終止狀態之後仍可能收到 RunControl（例如晚到的 cancel）；一律回覆，不卡住 Server。
        if !matches!(*self.status_tx.borrow(), RunStatus::Completed) {
            self.ctx.outbox.finish_run(self.run_id());
            while let Some(input) = self.rx.recv().await {
                match input {
                    RunInput::Shutdown => break,
                    RunInput::Control(control) => self.reject(
                        &control,
                        RunControlRejectReason::InvalidState,
                        "Run 已經結束",
                    ),
                }
            }
        }
    }

    // ── Event 與狀態 ────────────────────────────────────────────────────────────

    fn emit(&self, kind: EventKind) {
        let name = kind.name().as_str();
        if let Err(e) = self.ctx.outbox.emit(self.run_id(), now(), kind) {
            tracing::error!(run_id = %self.run_id(), kind = name, error = %e, "無法記錄 Event");
        }
    }

    fn set_status(&self, status: RunStatus, gate: Option<GateKind>, message: Option<String>) {
        self.status_tx.send_replace(status);
        self.emit(EventKind::StatusChanged {
            status,
            gate,
            message,
        });
    }

    fn respond(&self, control: &RunControl, outcome: RunControlOutcome) {
        let _ = self
            .ctx
            .frames
            .send(RunnerToServer::RunControlResult(RunControlResult {
                control_id: control.control_id.clone(),
                run_id: control.run_id.clone(),
                dispatch_id: control.dispatch_id.clone(),
                outcome,
            }));
    }

    fn applied(&self, control: &RunControl) {
        self.respond(control, RunControlOutcome::Applied);
    }

    fn reject(&self, control: &RunControl, reason: RunControlRejectReason, message: &str) {
        self.respond(
            control,
            RunControlOutcome::Rejected {
                reason,
                message: self.redactor.redact(message),
            },
        );
    }

    fn wt(&self) -> &Worktree {
        self.worktree.as_ref().expect("Worktree 已經建立")
    }

    // ── 啟動 ───────────────────────────────────────────────────────────────────

    async fn start(&mut self) -> Result<(), Stop> {
        let request = WorktreeRequest {
            run_id: self.offer.run_id.clone(),
            task_key: self.offer.task.task_key.clone(),
            run_seq: self.offer.run_seq,
            repo: self.offer.repo.clone(),
            branch: self.offer.branch.clone(),
        };
        let manager = self.ctx.worktrees.clone();
        let mut wt = self
            .interruptible(async move { manager.create(&request).await })
            .await?
            .map_err(|e| Stop::failed(e.code, e.message))?;
        self.emit(EventKind::WorktreeReady {
            // Preview 的 port 由 E2 填入。
            preview_port: None,
            worktree_path: wt.path.to_string_lossy().into_owned(),
            branch: wt.branch.clone(),
            base_commit: wt.base_commit.clone(),
        });

        if !wt.scripts_approved {
            self.approve_config(&mut wt).await?;
        }
        let dotenv = self
            .ctx
            .worktrees
            .link_and_copy(&wt)
            .map_err(|e| Stop::failed(e.code, e.message))?;
        for text in &dotenv {
            self.redactor.add_dotenv(text);
        }
        self.normalizer = Some(Normalizer::new(&wt.path, self.redactor.clone()));
        self.worktree = Some(wt);
        self.run_setup().await?;
        self.load_settings_baseline().await;
        self.check_agent_settings().await?;
        self.start_agent().await
    }

    /// 信任核准（§6.2）：設定檔中的腳本第一次執行前、或內容改變後，要人核准。
    async fn approve_config(&mut self, wt: &mut Worktree) -> Result<(), Stop> {
        let scripts = wt
            .config
            .scripts()
            .iter()
            .map(|(name, script)| format!("{name}：{script}"))
            .collect::<Vec<_>>()
            .join("\n");
        let title = format!(
            "第一次執行 {} 的 {} 中的腳本（或內容已改變），需要核准：\n{scripts}",
            self.offer.repo.name,
            crate::repo_config::config_path()
        );
        let options = vec![
            option("allow_once", "這次允許", PermissionOptionKind::AllowOnce),
            option(
                "allow_always",
                "永遠允許這份設定",
                PermissionOptionKind::AllowAlways,
            ),
            option("reject_once", "拒絕", PermissionOptionKind::RejectOnce),
        ];
        let chosen = self
            .ask_human(PermissionPurpose::ConfigTrust, None, title, options)
            .await?;
        match chosen.as_str() {
            "allow_always" => {
                if let Err(e) = self
                    .ctx
                    .home
                    .trust(&self.offer.repo.clone_url, &wt.config.hash)
                {
                    tracing::warn!(error = %e, "無法保存信任紀錄");
                }
                wt.scripts_approved = true;
                Ok(())
            }
            "allow_once" => {
                wt.scripts_approved = true;
                Ok(())
            }
            _ => Err(Stop::failed(
                RunErrorCode::SetupFailed,
                "設定檔中的腳本沒有被核准",
            )),
        }
    }

    async fn run_setup(&mut self) -> Result<(), Stop> {
        let wt = self.wt().clone();
        let Some(script) = wt
            .config
            .config
            .worktree
            .setup
            .clone()
            .filter(|s| !s.trim().is_empty())
        else {
            return Ok(());
        };
        self.emit(EventKind::ToolCall(ToolCall {
            tool_call_id: SETUP_TOOL_CALL.into(),
            title: Some(format!("setup：{}", self.redactor.redact(&script))),
            tool_kind: Some(ToolKind::Execute),
            status: Some(ToolCallStatus::InProgress),
            content: None,
            locations: None,
        }));
        let manager = self.ctx.worktrees.clone();
        let outbox = self.ctx.outbox.clone();
        let run_id = self.offer.run_id.clone();
        let redactor = self.redactor.clone();
        let job = async move {
            let result = manager.run_setup(&wt).await;
            let (ok, output, exit_code) = match &result {
                Ok(Some(out)) => (out.success(), out.combined(), out.status.code()),
                Ok(None) => (true, String::new(), Some(0)),
                Err(e) => (false, e.message.clone(), None),
            };
            let event = EventKind::ToolCall(ToolCall {
                tool_call_id: SETUP_TOOL_CALL.into(),
                title: None,
                tool_kind: None,
                status: Some(if ok {
                    ToolCallStatus::Completed
                } else {
                    ToolCallStatus::Failed
                }),
                content: Some(vec![ToolCallContent::Terminal {
                    terminal_id: SETUP_TOOL_CALL.into(),
                    command: Some(redactor.redact(&script)),
                    output: TextBody::Inline {
                        text: redactor.redact(&output),
                    },
                    exit_code,
                }]),
                locations: None,
            });
            if let Err(e) = outbox.emit(&run_id, now(), event) {
                tracing::error!(error = %e, "無法記錄 setup 的結果");
            }
            (ok, output)
        };
        if self.wt().config.config.worktree.wait_for_setup {
            let (ok, output) = self.interruptible(job).await?;
            if !ok {
                return Err(Stop::failed(
                    RunErrorCode::SetupFailed,
                    format!("setup 失敗：{}", normalize::truncate(output, 4000)),
                ));
            }
        } else {
            // 不等 setup：在背景執行，結果仍以 Event 回報。
            tokio::spawn(job);
        }
        Ok(())
    }

    async fn start_agent(&mut self) -> Result<(), Stop> {
        let wt = self.wt().clone();
        let agents_dir = self.ctx.home.agents_dir();
        let profile = self.profile.clone();
        let (tx, rx) = mpsc::unbounded_channel();
        let start = async move {
            if let crate::agent::Launch::ManagedNpm {
                package,
                version,
                entry,
                ..
            } = &profile.launch
            {
                crate::agent::install::ensure_installed(&agents_dir, package, version, entry)
                    .await
                    .map_err(AgentError::Start)?;
            }
            let spec = profile
                .launch_spec(&agents_dir)
                .map_err(AgentError::Start)?
                .envs(wt.env())
                .unattended_git();
            AcpSession::start(&profile, spec, &wt.path, tx).await
        };
        let session = self
            .interruptible(start)
            .await?
            .map_err(|e| Stop::failed(RunErrorCode::AgentStartFailed, e.to_string()))?;
        tracing::info!(
            run_id = %self.run_id(),
            pid = ?session.pid(),
            agent = ?session.agent_info(),
            capabilities = ?session.capabilities(),
            "Agent 已啟動"
        );
        self.session = Some(session);
        self.notices = Some(rx);
        Ok(())
    }

    /// 執行一個不會碰到 Run 狀態的長時間工作，期間仍處理 cancel 與其他 RunControl。
    async fn interruptible<T>(
        &mut self,
        work: impl std::future::Future<Output = T>,
    ) -> Result<T, Stop> {
        tokio::pin!(work);
        loop {
            tokio::select! {
                out = &mut work => return Ok(out),
                input = self.rx.recv() => match input {
                    None | Some(RunInput::Shutdown) => return Err(Stop::Shutdown),
                    Some(RunInput::Control(control)) => {
                        if matches!(control.action, RunControlAction::Cancel) {
                            self.applied(&control);
                            return Err(Stop::Canceled);
                        }
                        self.reject(&control, RunControlRejectReason::InvalidState, "Run 還在啟動中");
                    }
                },
            }
        }
    }

    /// 送出 `permission_request` 並等人回覆（信任核准、Agent 設定檔變更）。回傳被選擇的 option ID。
    async fn ask_human(
        &mut self,
        purpose: PermissionPurpose,
        tool_call_id: Option<orbis_protocol::ids::ToolCallId>,
        title: String,
        options: Vec<PermissionOption>,
    ) -> Result<String, Stop> {
        let request_id: PermissionRequestId = uuid::Uuid::now_v7().to_string().into();
        let previous = *self.status_tx.borrow();
        self.emit(EventKind::PermissionRequest {
            request_id: request_id.clone(),
            tool_call_id,
            title: self.redactor.redact(&title),
            options: options.clone(),
            purpose,
        });
        self.set_status(RunStatus::AwaitingPermission, None, None);
        loop {
            let Some(input) = self.rx.recv().await else {
                return Err(Stop::Shutdown);
            };
            let control = match input {
                RunInput::Shutdown => return Err(Stop::Shutdown),
                RunInput::Control(control) => control,
            };
            match &control.action {
                RunControlAction::PermissionResponse {
                    request_id: id,
                    option_id,
                } if id == &request_id => {
                    if !options.iter().any(|o| &o.option_id == option_id) {
                        self.reject(
                            &control,
                            RunControlRejectReason::UnknownPermissionRequest,
                            "option_id 不在選項中",
                        );
                        continue;
                    }
                    self.applied(&control);
                    self.emit(EventKind::PermissionResolved {
                        request_id: request_id.clone(),
                        selected_option_id: Some(option_id.clone()),
                    });
                    self.set_status(previous, None, None);
                    return Ok(option_id.clone());
                }
                RunControlAction::Cancel => {
                    self.applied(&control);
                    self.emit(EventKind::PermissionResolved {
                        request_id,
                        selected_option_id: None,
                    });
                    return Err(Stop::Canceled);
                }
                RunControlAction::PermissionResponse { .. } => self.reject(
                    &control,
                    RunControlRejectReason::UnknownPermissionRequest,
                    "沒有這個權限請求",
                ),
                _ => self.reject(
                    &control,
                    RunControlRejectReason::InvalidState,
                    "Run 正在等待權限請求的回覆",
                ),
            }
        }
    }

    // ── Agent 設定檔的防護 ──────────────────────────────────────────────────────

    async fn load_settings_baseline(&mut self) {
        let wt = self.wt().clone();
        for path in &self.profile.protected_paths {
            let content = wt
                .git()
                .show_file(&wt.base_commit, path)
                .await
                .ok()
                .flatten()
                .map(String::into_bytes);
            self.settings_baseline.insert(path.clone(), content);
        }
    }

    /// 每次送出 prompt 前：Worktree 中 Agent 的設定檔和已接受的內容（一開始是 base commit）不同時，
    /// 先問人（`agent_settings_changed`），允許後才繼續。
    async fn check_agent_settings(&mut self) -> Result<(), Stop> {
        let wt_path = self.wt().path.clone();
        let mut changed = Vec::new();
        for (path, accepted) in &self.settings_baseline {
            let current = std::fs::read(wt_path.join(path)).ok();
            if &current != accepted {
                changed.push((path.clone(), current));
            }
        }
        if changed.is_empty() {
            return Ok(());
        }
        changed.sort_by(|a, b| a.0.cmp(&b.0));
        let list = changed
            .iter()
            .map(|(p, _)| p.as_str())
            .collect::<Vec<_>>()
            .join("、");
        let title = format!(
            "Worktree 中 Agent 的設定檔 {list} 和 base commit 不同，可能讓 Agent 繞過 Permission Policy。允許後才繼續。"
        );
        let options = vec![
            option("allow_once", "允許並繼續", PermissionOptionKind::AllowOnce),
            option(
                "reject_once",
                "拒絕並停止 Run",
                PermissionOptionKind::RejectOnce,
            ),
        ];
        let chosen = self
            .ask_human(
                PermissionPurpose::AgentSettingsChanged,
                None,
                title,
                options,
            )
            .await?;
        if chosen != "allow_once" {
            return Err(Stop::failed(
                RunErrorCode::AgentError,
                format!("Agent 設定檔的變更（{list}）沒有被允許"),
            ));
        }
        for (path, current) in changed {
            self.settings_baseline.insert(path, current);
        }
        Ok(())
    }

    // ── 執行與 Review ──────────────────────────────────────────────────────────

    async fn work(&mut self) -> Result<(), Stop> {
        let mut prompt = normalize::prompt_to_acp(&self.offer.prompt);
        loop {
            match self.turn(prompt).await? {
                TurnEnd::RateLimited {
                    retry_after,
                    message,
                } => {
                    self.wait_rate_limit(retry_after, message).await?;
                    prompt = vec![acp::ContentBlock::from(RESUME_PROMPT.to_owned())];
                }
                TurnEnd::Done(reason) => {
                    self.send_run_diff().await;
                    self.set_status(
                        RunStatus::AwaitingGate,
                        Some(GateKind::Review),
                        Some(stop_reason_text(reason)),
                    );
                    match self.await_review().await? {
                        Some(next) => prompt = next,
                        None => return self.await_push().await,
                    }
                }
            }
        }
    }

    /// 送出 prompt，處理期間的 update、權限請求與 RunControl，直到回合結束。
    async fn turn(&mut self, prompt: Vec<acp::ContentBlock>) -> Result<TurnEnd, Stop> {
        self.check_agent_settings().await?;
        self.set_status(RunStatus::Running, None, None);
        let session = self.session.as_ref().expect("Agent 已啟動");
        let mut closed = session.closed();
        let turn = session.prompt(prompt);
        tokio::pin!(turn);
        let mut notices = self.notices.take().expect("Agent 已啟動");
        let mut canceling: Option<tokio::time::Instant> = None;
        let result = loop {
            let deadline = canceling
                .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(86400 * 365));
            tokio::select! {
                result = &mut turn => break result,
                Some(notice) = notices.recv() => self.on_notice(notice),
                input = self.rx.recv() => match input {
                    None | Some(RunInput::Shutdown) => {
                        self.notices = Some(notices);
                        return Err(Stop::Shutdown);
                    }
                    Some(RunInput::Control(control)) => {
                        if self.on_control_while_running(control) && canceling.is_none() {
                            self.session.as_ref().expect("Agent 已啟動").cancel();
                            self.cancel_pending();
                            canceling = Some(tokio::time::Instant::now() + CANCEL_GRACE);
                        }
                    }
                },
                () = wait_closed(&mut closed) => {
                    // Agent 程序結束：回合不會再有回應。
                    // 讓 `turn` 有機會先回傳錯誤（例如 rate limit），再判定為當掉。
                    if let Ok(result) = tokio::time::timeout(Duration::from_millis(500), &mut turn).await {
                        break result;
                    }
                    self.notices = Some(notices);
                    if canceling.is_some() {
                        return Err(Stop::Canceled);
                    }
                    let tail = self.session.as_ref().map(AcpSession::stderr_tail).unwrap_or_default();
                    return Err(Stop::failed(RunErrorCode::AgentCrashed, format!("Agent 程序非預期結束\n{tail}")));
                }
                () = tokio::time::sleep_until(deadline), if canceling.is_some() => {
                    tracing::warn!(run_id = %self.run_id(), "Agent 沒有在寬限期內結束回合，直接結束程序樹");
                    self.notices = Some(notices);
                    return Err(Stop::Canceled);
                }
            }
        };
        // 處理回合結束前已送出的 update。
        while let Ok(notice) = notices.try_recv() {
            self.on_notice(notice);
        }
        self.notices = Some(notices);
        self.cancel_pending();
        if canceling.is_some() {
            return Err(Stop::Canceled);
        }
        match result {
            Ok(reason) => Ok(TurnEnd::Done(reason)),
            Err(error) => match rate_limit(&error) {
                Some(retry_after) => Ok(TurnEnd::RateLimited {
                    retry_after,
                    message: error.message.clone(),
                }),
                None => Err(Stop::failed(
                    RunErrorCode::AgentError,
                    format!(
                        "{} {}",
                        error.message,
                        error.data.map(|d| d.to_string()).unwrap_or_default()
                    ),
                )),
            },
        }
    }

    /// 回合進行中的 RunControl。回傳 `true` 表示要中止回合。
    fn on_control_while_running(&mut self, control: RunControl) -> bool {
        match &control.action {
            RunControlAction::Cancel => {
                self.applied(&control);
                true
            }
            RunControlAction::PermissionResponse {
                request_id,
                option_id,
            } => {
                let Some(Pending::Agent { options, .. }) = self.pending.get(request_id) else {
                    self.reject(
                        &control,
                        RunControlRejectReason::UnknownPermissionRequest,
                        "沒有這個權限請求，或請求已經結束",
                    );
                    return false;
                };
                if !options.contains(option_id) {
                    self.reject(
                        &control,
                        RunControlRejectReason::UnknownPermissionRequest,
                        "option_id 不在選項中",
                    );
                    return false;
                }
                let Some(Pending::Agent { reply, .. }) = self.pending.remove(request_id) else {
                    unreachable!("剛剛確認過");
                };
                let _ = reply.send(acp::RequestPermissionOutcome::Selected(
                    acp::SelectedPermissionOutcome::new(option_id.clone()),
                ));
                self.applied(&control);
                self.emit(EventKind::PermissionResolved {
                    request_id: request_id.clone(),
                    selected_option_id: Some(option_id.clone()),
                });
                if self.pending.is_empty() {
                    self.set_status(RunStatus::Running, None, None);
                }
                false
            }
            _ => {
                self.reject(
                    &control,
                    RunControlRejectReason::InvalidState,
                    "Run 正在執行，請等回合結束",
                );
                false
            }
        }
    }

    /// 取消所有等待中的權限請求（中止或回合結束時）。
    fn cancel_pending(&mut self) {
        for (request_id, pending) in self.pending.drain() {
            let Pending::Agent { reply, .. } = pending;
            let _ = reply.send(acp::RequestPermissionOutcome::Cancelled);
            self.ctx
                .outbox
                .emit(
                    &self.offer.run_id,
                    now(),
                    EventKind::PermissionResolved {
                        request_id,
                        selected_option_id: None,
                    },
                )
                .ok();
        }
    }

    fn on_notice(&mut self, notice: AgentNotice) {
        match notice {
            AgentNotice::Update(update) => {
                let events = self
                    .normalizer
                    .as_mut()
                    .expect("Worktree 已經建立")
                    .session_update(update);
                for event in events {
                    self.emit(event);
                }
            }
            AgentNotice::Permission { request, reply } => self.on_permission(request, reply),
        }
    }

    /// Agent 的權限請求：依 Permission Policy 自動回覆，或送出 `permission_request` 等人回覆。
    fn on_permission(
        &mut self,
        request: acp::RequestPermissionRequest,
        reply: oneshot::Sender<acp::RequestPermissionOutcome>,
    ) {
        let wt = self.wt().clone();
        let subject = self.profile.classify(&request, &wt.path);
        let decision = policy::decide(
            &subject,
            &PolicyContext {
                policy: self.offer.permission_policy,
                worktree: &wt.path,
                allow_commands: &wt.config.config.permissions.allow_commands,
                default_branch: &wt.default_branch,
                protected_paths: &self.profile.protected_paths,
            },
        );
        tracing::info!(run_id = %self.run_id(), ?subject, ?decision, "權限請求");
        let pick = |kinds: &[acp::PermissionOptionKind]| {
            kinds.iter().find_map(|kind| {
                request
                    .options
                    .iter()
                    .find(|o| o.kind == *kind)
                    .map(|o| o.option_id.clone())
            })
        };
        let auto = match &decision {
            // 允許只選「這次」，之後的請求仍會經過 Runner。
            Decision::Allow => Some(pick(&[
                acp::PermissionOptionKind::AllowOnce,
                acp::PermissionOptionKind::AllowAlways,
            ])),
            Decision::Deny { .. } => Some(pick(&[
                acp::PermissionOptionKind::RejectOnce,
                acp::PermissionOptionKind::RejectAlways,
            ])),
            Decision::Ask { .. } => None,
        };
        if let Some(choice) = auto {
            let outcome = match choice {
                Some(id) => {
                    acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(id))
                }
                None => acp::RequestPermissionOutcome::Cancelled,
            };
            let _ = reply.send(outcome);
            return;
        }
        let Decision::Ask { reason } = decision else {
            unreachable!("自動回覆已處理");
        };
        let normalizer = self.normalizer.as_mut().expect("Worktree 已經建立");
        if let Some(created) = normalizer.ensure_tool_call(&request.tool_call) {
            self.emit(created);
        }
        let tool_title = request
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| request.tool_call.tool_call_id.0.to_string());
        let request_id: PermissionRequestId = uuid::Uuid::now_v7().to_string().into();
        let options = normalize::permission_options(&request.options);
        self.pending.insert(
            request_id.clone(),
            Pending::Agent {
                reply,
                options: options.iter().map(|o| o.option_id.clone()).collect(),
            },
        );
        self.emit(EventKind::PermissionRequest {
            request_id,
            tool_call_id: Some(request.tool_call.tool_call_id.0.to_string().into()),
            title: self.redactor.redact(&format!("{tool_title}（{reason}）")),
            options,
            purpose: PermissionPurpose::Tool,
        });
        if self.pending.len() == 1 {
            self.set_status(RunStatus::AwaitingPermission, None, None);
        }
    }

    async fn wait_rate_limit(
        &mut self,
        retry_after: Option<Duration>,
        message: String,
    ) -> Result<(), Stop> {
        let wait = retry_after.unwrap_or(DEFAULT_RATE_LIMIT_WAIT);
        let resets_at = std::time::SystemTime::now() + wait;
        self.emit(EventKind::RateLimited {
            resets_at: Some(Timestamp(
                humantime::format_rfc3339_millis(resets_at).to_string(),
            )),
            message: self.redactor.redact(&message),
        });
        self.set_status(RunStatus::RateLimited, None, None);
        self.interruptible(tokio::time::sleep(wait)).await
    }

    async fn send_run_diff(&mut self) {
        let wt = self.wt().clone();
        match crate::diff::run_diff(
            &wt.path,
            &wt.base_commit,
            &self.redactor,
            &wt.local_only_paths(),
        )
        .await
        {
            Ok(diff) => self.emit(EventKind::RunDiff(diff)),
            Err(e) => self.emit(EventKind::Error {
                code: e.code,
                message: self.redactor.redact(&format!("無法計算 diff：{e}")),
                fatal: false,
            }),
        }
    }

    /// 等 Review Gate 的結果。回傳 `Some(prompt)` 表示退回後在同一個 session 繼續，`None` 表示核准。
    async fn await_review(&mut self) -> Result<Option<Vec<acp::ContentBlock>>, Stop> {
        loop {
            let control = match self.rx.recv().await {
                None | Some(RunInput::Shutdown) => return Err(Stop::Shutdown),
                Some(RunInput::Control(control)) => control,
            };
            match &control.action {
                RunControlAction::Cancel => {
                    self.applied(&control);
                    return Err(Stop::Canceled);
                }
                RunControlAction::GateResult {
                    gate: GateKind::Review,
                    decision: GateDecision::Rejected,
                } => {
                    // 退回的意見另外以 prompt 送出；在那之前維持 awaiting_gate。
                    self.applied(&control);
                }
                RunControlAction::GateResult {
                    gate: GateKind::Review,
                    decision: GateDecision::Approved,
                } => {
                    self.applied(&control);
                    if let Some(session) = self.session.take() {
                        session.shutdown().await;
                    }
                    return Ok(None);
                }
                RunControlAction::Prompt { prompt, .. } => {
                    self.applied(&control);
                    return Ok(Some(normalize::prompt_to_acp(prompt)));
                }
                RunControlAction::GateResult {
                    gate: GateKind::Plan,
                    ..
                } => self.reject(
                    &control,
                    RunControlRejectReason::InvalidState,
                    "這個 Run 沒有在等待 Plan Gate",
                ),
                RunControlAction::PushBranch => self.reject(
                    &control,
                    RunControlRejectReason::InvalidState,
                    "Review Gate 核准後才能 push",
                ),
                RunControlAction::PermissionResponse { .. } => self.reject(
                    &control,
                    RunControlRejectReason::UnknownPermissionRequest,
                    "沒有等待中的權限請求",
                ),
                // 協定版本 2 的動作，由 A2（verify、archive）與 E2（restart_preview）實作。
                RunControlAction::Verify(_)
                | RunControlAction::Archive
                | RunControlAction::RestartPreview => self.reject(
                    &control,
                    RunControlRejectReason::InvalidState,
                    "這個 Runner 還不支援這個動作",
                ),
            }
        }
    }

    /// Review 已核准：等 `push_branch`，push 成功後 Run 才進入 `completed`。
    async fn await_push(&mut self) -> Result<(), Stop> {
        let mut completed = false;
        loop {
            let control = match self.rx.recv().await {
                None | Some(RunInput::Shutdown) => return Err(Stop::Shutdown),
                Some(RunInput::Control(control)) => control,
            };
            match &control.action {
                RunControlAction::PushBranch => match self.push_branch().await {
                    Ok((branch, commit_sha)) => {
                        self.respond(
                            &control,
                            RunControlOutcome::BranchPushed { branch, commit_sha },
                        );
                        if !completed {
                            completed = true;
                            self.set_status(RunStatus::Completed, None, None);
                            self.ctx.outbox.finish_run(self.run_id());
                        }
                    }
                    Err(message) => self.reject(&control, RunControlRejectReason::Failed, &message),
                },
                RunControlAction::Cancel if !completed => {
                    self.applied(&control);
                    return Err(Stop::Canceled);
                }
                _ => self.reject(
                    &control,
                    RunControlRejectReason::InvalidState,
                    if completed {
                        "Run 已經完成"
                    } else {
                        "Review 已核准，只接受 push_branch"
                    },
                ),
            }
        }
    }

    /// 把 Run 的分支 push 到 remote。未 commit 的變更先以設定的訊息 commit（§6.3 `[git]`）。
    async fn push_branch(&self) -> Result<(String, String), String> {
        let wt = self.wt();
        let Some(branch) = wt.branch.clone() else {
            return Err("這個 Run 沒有自己的分支（consult 模式）".into());
        };
        if branch == wt.default_branch {
            return Err(format!("不可以 push 到主分支 {branch}"));
        }
        let git = wt.git();
        let fail = |e: crate::git::GitError| e.to_string();
        // 從 Member 的 checkout 複製進來的檔案（例如 .env）與共用目錄的連結，絕不 commit 或 push。
        let local_only = wt.local_only_paths();
        let dirty = git.run(["status", "--porcelain"]).await.map_err(fail)?;
        if !dirty.trim().is_empty() {
            let message = wt.config.config.git.commit_message(CommitFields {
                task_key: &self.offer.task.task_key,
                title: &self.offer.task.title,
                run_id: self.offer.run_id.as_str(),
                branch: &branch,
            });
            let mut add = vec!["add".to_owned(), "-A".into(), "--".into(), ".".into()];
            add.extend(local_only.iter().map(|p| format!(":(exclude,literal){p}")));
            git.run(add).await.map_err(fail)?;
            let staged = git.run(["diff", "--cached", "--quiet"]).await.is_err();
            if staged {
                git.run(["commit", "-m", &message]).await.map_err(fail)?;
            }
        }
        // Agent 自己 commit 的內容也要檢查，而且是要 push 的**每一個** commit（先 commit 再刪掉、
        // 或從側分支 merge 進來，都會留在歷史中）。不依賴 git 的歷史簡化：逐一檢查每個 commit 的
        // tree，只要某個本機檔案的內容和 base commit 不同就拒絕。
        if let Some(leak) = wt.local_only_leak().await.map_err(fail)? {
            return Err(format!(
                "分支上的 commit {leak} 含有只在本機使用的檔案（{}，來自 copy 或 shared_dirs），拒絕 push",
                local_only.join("、")
            ));
        }
        let ahead = git
            .run(["rev-list", "--count", &format!("{}..HEAD", wt.base_commit)])
            .await
            .map_err(fail)?;
        if ahead.trim() == "0" {
            return Err("分支上沒有任何變更可以 push".into());
        }
        git.run(["push", "origin", &format!("HEAD:refs/heads/{branch}")])
            .await
            .map_err(fail)?;
        let sha = git.rev_parse_commit("HEAD").await.map_err(fail)?;
        Ok((branch, sha))
    }
}

/// 等到 ACP 連線結束（不把 watch 的 guard 留在 await 之間）。
async fn wait_closed(closed: &mut watch::Receiver<bool>) {
    let _ = closed.wait_for(|c| *c).await;
}

fn option(id: &str, name: &str, kind: PermissionOptionKind) -> PermissionOption {
    PermissionOption {
        option_id: id.into(),
        name: name.into(),
        kind,
    }
}

fn stop_reason_text(reason: acp::StopReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("{reason:?}"))
}

/// 辨識 rate limit 錯誤，回傳建議的等待時間。
/// 目前認得 `data.type == "rate_limit"`（含 `retry_after_ms`）與訊息中的 rate limit／429。
/// 各 Agent 的格式在 A2 補齊。
fn rate_limit(error: &agent_client_protocol::Error) -> Option<Option<Duration>> {
    let data = error.data.as_ref();
    let typed = data
        .and_then(|d| d.get("type"))
        .and_then(|t| t.as_str())
        .is_some_and(|t| t == "rate_limit");
    let lower = error.message.to_ascii_lowercase();
    if !(typed || lower.contains("rate limit") || lower.contains("429")) {
        return None;
    }
    Some(
        data.and_then(|d| d.get("retry_after_ms"))
            .and_then(serde_json::Value::as_u64)
            .map(Duration::from_millis),
    )
}
