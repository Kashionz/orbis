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
use orbis_protocol::availability::AgentCapability;
use orbis_protocol::control::{
    RunControl, RunControlAction, RunControlOutcome, RunControlRejectReason, RunControlResult,
};
use orbis_protocol::dispatch::DispatchOffer;
use orbis_protocol::enums::{DelegationMode, GateDecision, GateKind, PromptSource, RunStatus};
use orbis_protocol::event::{
    ContentBlock, EventKind, PermissionOption, PermissionOptionKind, PermissionPurpose, PlanSource,
    RunErrorCode, TextBody, ToolCall, ToolCallContent, ToolCallStatus, ToolKind,
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
use crate::preview::{
    Preview, PreviewNotice, PreviewRegistry, PreviewSpec, PreviewTiming, Registration,
};
use crate::repo_config::CommitFields;
use crate::secrets::Redactor;
use crate::worktree::{Worktree, WorktreeManager, WorktreeRequest};

/// Runner 自己產生的 RunControl（例如父 Run 結束時中止 Child Run）的 `control_id` 前綴：
/// 照一般的 RunControl 處理，但不回 `run_control_result`。
pub const INTERNAL_CONTROL_PREFIX: &str = "runner-internal:";

/// 送出 `session/cancel` 後等 Agent 自己結束回合的時間，超過就直接結束程序樹。
const CANCEL_GRACE: Duration = Duration::from_secs(10);
/// rate limit 沒有提供恢復時間時的等待時間。
const DEFAULT_RATE_LIMIT_WAIT: Duration = Duration::from_secs(60);
/// 恢復時間已經過了（或很快就到）時，至少等這麼久再繼續。
const MIN_RATE_LIMIT_WAIT: Duration = Duration::from_secs(1);
/// rate limit 恢復後送給 Agent 的 prompt。
pub const RESUME_PROMPT: &str = "額度已恢復，請繼續剛才的工作。";
/// session 中途 Agent 的設定檔被改、人處理完之後送給 Agent 的 prompt。
pub const SETTINGS_RESUME_PROMPT: &str = "Agent 的設定檔已依 Orbis 的決定處理（接受或還原），請繼續剛才的工作，不要修改 Agent 的設定檔。";
/// 還原設定檔後 Agent 重新啟動、但無法接續原本的 session 時，接在原本的 prompt 後面的說明。
pub const SETTINGS_RESTART_NOTE: &str = "（Agent 因為修改了自己的設定檔而被重新啟動，設定檔已還原。之前的修改都還在 Worktree 中，請先檢查目前的狀態再繼續，不要修改 Agent 的設定檔。）";
/// Planning（Agent 沒有可靠的 plan 模式時）：接在第一個 prompt 後面，要 Agent 只產出 plan。
pub const PLAN_ONLY_PROMPT: &str = "這是 Planning 階段：請先閱讀需要的檔案，產出實作計畫（markdown），列出要修改的檔案、步驟與驗證方式。這個階段不要修改任何檔案，也不要執行會改變狀態的指令。回覆的最後一則訊息就是計畫全文。";
/// Plan Gate 核准後送給 Agent 的 prompt。
pub const PLAN_APPROVED_PROMPT: &str = "Plan 已核准，請依照核准的計畫開始實作。";
/// Verification 的一條指令最多執行這麼久。
const VERIFY_COMMAND_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Verification 失敗時摘要中保留的輸出行數（完整輸出在證據中）。
const VERIFY_SUMMARY_LINES: usize = 20;
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
    /// 正在執行的 Preview（relay 依此轉送，§13）。
    pub previews: Arc<PreviewRegistry>,
    /// 從 `initialize` 得知的能力旗標（啟動 Agent 後更新）。
    pub learned: Arc<crate::agent::LearnedAgents>,
    /// 通知連線重送 AgentAvailability（能力旗標或並行數改變時）。
    pub availability_changed: Arc<tokio::sync::Notify>,
    /// 各組 Credential 的 rate limit（到恢復時間之前不接受新的 Dispatch）。
    pub rate_limits: Arc<crate::rate_limit::RateLimits>,
    /// 從 Server 下載 blob（prompt 中的圖片）。
    pub blobs: Arc<crate::blobs::BlobFetcher>,
    /// Orbis MCP 的工具呼叫（ARCHITECTURE §9）。
    pub mcp: Arc<crate::orbis_mcp::hub::McpHub>,
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
    /// Child Run 的父 Run。
    pub parent: Option<RunId>,
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
    let parent = offer.delegation.as_ref().map(|d| d.parent_run_id.clone());
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
        preview: None,
        approved_settings_writes: HashMap::new(),
        rate_limit_hint: None,
        rate_limit_set: None,
        planning: false,
        plan_text: None,
        turn_text: String::new(),
        last_source: PromptSource::User,
        approved_verify_commands: std::collections::HashSet::new(),
        mcp_token: None,
        read_only: false,
        fresh_continuation: false,
    };
    let task = tokio::spawn(run.main());
    RunHandle {
        parent,
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
        options: Vec<(String, PermissionOptionKind)>,
        tool_call_id: String,
        /// 這個請求會動到的受保護設定檔；人允許時記進 `approved_settings_writes`。
        protected: Vec<String>,
    },
}

/// 要送給 Agent 的 prompt（協定的內容區塊）與它的來源（`prompt_submitted` Event 用）。
#[derive(Debug, Clone)]
struct Prompt {
    blocks: Vec<ContentBlock>,
    source: PromptSource,
}

impl Prompt {
    fn text(text: &str, source: PromptSource) -> Self {
        Self {
            blocks: vec![ContentBlock::Text {
                text: text.to_owned(),
            }],
            source,
        }
    }
}

/// Plan Gate 的結果。
enum PlanDecision {
    Approved,
    /// 退回：依附帶的意見在同一個 session 重新產出 plan。
    Revise(Prompt),
}

/// 一個回合怎麼結束。
enum TurnEnd {
    Done(acp::StopReason),
    /// 回合中 Agent 的設定檔被改（例如 Claude Code 自己寫入 `.claude/settings.local.json`），
    /// Runner 中止了這個回合，要先問人（issue #52）。
    SettingsChanged,
    RateLimited {
        resets_at: Option<std::time::SystemTime>,
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
    /// Preview 的 dev server（§13），隨 Run 結束。
    preview: Option<Preview>,
    /// 經權限請求允許（人或政策）、會寫入受保護設定檔的 tool call：tool call ID → 設定檔。
    /// 這些 tool call 結束時的寫入視為已接受，不算 session 中途被改（issue #52）。
    approved_settings_writes: HashMap<String, Vec<String>>,
    /// 這個回合中 Agent 以事件回報過額度用完（Claude Code 的 rate limit 事件）。
    rate_limit_hint: Option<crate::rate_limit::RateLimit>,
    /// 這個 Run 設下的 Credential 暫停（恢復時間），結束時解除。
    rate_limit_set: Option<std::time::SystemTime>,
    /// Planning 中（`plan_gate` 的 Run，Plan Gate 核准之前）：寫入一律拒絕。
    planning: bool,
    /// plan 模式下 Agent 交出的 plan（例如 Claude Code 的 ExitPlanMode）。
    plan_text: Option<String>,
    /// 這個回合 Agent 回覆的文字（`final_message` 與 Planning 的 plan 用）。
    turn_text: String,
    /// 最近一個 prompt 的來源。Runner 自己補送的 prompt（rate limit 恢復後的「請繼續」等）沿用它。
    last_source: PromptSource,
    /// 這個 Run 中已經被允許的 Verification 指令（Task 指定、不在 Repo 設定檔中的指令）。
    approved_verify_commands: std::collections::HashSet<String>,
    /// Orbis MCP 的 token（Agent 啟動時登記，Run 結束時取消）。
    mcp_token: Option<String>,
    /// `consult` 模式的 Child Run：在父 Run 的 Worktree 中唯讀，寫入一律拒絕。
    read_only: bool,
    /// Feedback Loop 的新 Run 沒有接續到原本的 session：第一個 prompt 要附上 Task 與目前的變更。
    fresh_continuation: bool,
}

impl Run {
    fn run_id(&self) -> &RunId {
        &self.offer.run_id
    }

    async fn main(mut self) {
        self.set_status(RunStatus::Starting, None, None);
        let outcome = match self.start().await {
            Ok(()) => self.work().await,
            Err(stop) => Err(stop),
        };
        if let Some(session) = self.session.take() {
            session.shutdown().await;
        }
        if let Some(preview) = self.preview.take() {
            preview.stop().await;
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
        if let Some(token) = self.mcp_token.take() {
            self.ctx.mcp.unregister(&token);
        }
        // Run 不再佔用並行數。
        self.ctx.availability_changed.notify_one();
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
        if control
            .control_id
            .as_str()
            .starts_with(INTERNAL_CONTROL_PREFIX)
        {
            return;
        }
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
        let parent = self.parent_caller()?;
        // `consult` 模式的 Child Run：在父 Run 的 Worktree 中唯讀執行，不另外開 Worktree、不跑 setup
        // （父 Run 都做過了）。
        if let Some(parent) = &parent
            && parent.1 == DelegationMode::Consult
        {
            let mut wt = parent.0.worktree.clone();
            wt.run_id = self.offer.run_id.clone();
            wt.branch = None;
            self.read_only = true;
            self.emit(EventKind::WorktreeReady {
                preview_port: None,
                worktree_path: wt.path.to_string_lossy().into_owned(),
                branch: None,
                base_commit: wt.base_commit.clone(),
            });
            self.normalizer = Some(Normalizer::new(&wt.path, self.redactor.clone()));
            self.worktree = Some(wt);
            self.load_settings_baseline().await;
            self.planning = self.offer.plan_gate;
            self.start_agent(None).await?;
            return self.enter_plan_mode().await;
        }
        // `branch` 模式的 Child Run：從父 Run 當下的 HEAD 開出子 Worktree，設定檔沿用父 Run 的
        // base commit 與信任核准。
        let base = match &parent {
            Some((caller, _)) => {
                let head = caller
                    .worktree
                    .git()
                    .rev_parse_commit("HEAD")
                    .await
                    .map_err(|e| Stop::failed(RunErrorCode::GitFailed, e.to_string()))?;
                Some(crate::worktree::BaseOverride {
                    commit: head,
                    config_commit: caller.worktree.base_commit.clone(),
                })
            }
            None => None,
        };
        // Feedback Loop 的新 Run：沿用前一個 Run 的 Worktree 與 base commit（§5.2）。
        let continuation = self.offer.continuation.clone();
        let base = base.or_else(|| {
            continuation
                .as_ref()
                .map(|c| crate::worktree::BaseOverride {
                    commit: c.base_commit.clone(),
                    config_commit: c.base_commit.clone(),
                })
        });
        let path = continuation
            .as_ref()
            .and_then(|c| self.ctx.home.run_worktree(c.previous_run_id.as_str()));
        if self.offer.origin == Some(orbis_protocol::enums::RunOrigin::Mention) {
            self.read_only = true;
        }
        let request = WorktreeRequest {
            run_id: self.offer.run_id.clone(),
            task_key: self.offer.task.task_key.clone(),
            run_seq: self.offer.run_seq,
            repo: self.offer.repo.clone(),
            branch: self.offer.branch.clone(),
            base,
            path,
        };
        let manager = self.ctx.worktrees.clone();
        let mut wt = self
            .interruptible(async move { manager.create(&request).await })
            .await?
            .map_err(|e| Stop::failed(e.code, e.message))?;
        if let Err(e) = self
            .ctx
            .home
            .record_run_worktree(self.offer.run_id.as_str(), &wt.path)
        {
            tracing::warn!(error = %e, "無法記下 Run 的 Worktree 位置");
        }
        // 沿用父 Run 的信任核准，只在子 Worktree 的內容和核准時的 base commit 完全相同時：
        // 父 Run 的 Agent 改過的檔案（例如 package.json 的 script）可能讓已核准的 setup 執行別的東西。
        if let Some((caller, _)) = &parent
            && caller.worktree.scripts_approved
            && wt
                .git()
                .succeeds([
                    "diff",
                    "--quiet",
                    &caller.worktree.base_commit,
                    &wt.base_commit,
                ])
                .await
        {
            wt.scripts_approved = true;
        }
        self.emit(EventKind::WorktreeReady {
            // 設定了 [preview] 時是分配給這個 Worktree 的 port（Server 據此區分「沒有設定」與「啟動中」）
            preview_port: PreviewSpec::from_worktree(&wt).map(|spec| spec.port),
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
        let setup_in_background = self.run_setup().await?;
        self.start_preview(setup_in_background);
        self.load_settings_baseline().await;
        self.check_agent_settings(SettingsCheck::BeforePrompt)
            .await?;
        self.planning = self.offer.plan_gate;
        let resume = self
            .offer
            .continuation
            .as_ref()
            .and_then(|c| c.session_id.clone());
        let wanted_resume = resume.is_some();
        let resumed = self.start_agent(resume).await?;
        if self.offer.continuation.is_some() && !resumed {
            // 沒辦法接續原本的 session：開新的 session，第一個 prompt 附上 Task 與目前的變更（§5.2）。
            if wanted_resume {
                self.emit(EventKind::Error {
                    code: RunErrorCode::SessionResumeFailed,
                    message: "無法恢復前一個 Run 的 session，改開新的 session".into(),
                    fatal: false,
                });
            }
            self.fresh_continuation = true;
        }
        self.enter_plan_mode().await
    }

    /// 主 Run：推動 Task 生命週期的 Run（人派工與 Feedback Loop 的 Run）。Child Run、判定
    /// Verification 與 @agent 的 consult Run 不經過 Review Gate，回合結束就完成（Server 等它們進入
    /// 終止狀態：`wait_run` 回傳、`merge_child` 可以合併、@agent 的回覆貼出）。
    fn is_primary(&self) -> bool {
        use orbis_protocol::enums::RunOrigin;
        self.offer.delegation.is_none()
            && self.offer.consult_of_run_id.is_none()
            && !matches!(
                self.offer.origin,
                Some(RunOrigin::Delegation | RunOrigin::Verification | RunOrigin::Mention)
            )
    }

    /// Child Run 的父 Run（在這台 Runner 上，hub 中有登記）與 Delegation 模式；一般 Run 為 `None`。
    fn parent_caller(
        &self,
    ) -> Result<Option<(crate::orbis_mcp::hub::Caller, DelegationMode)>, Stop> {
        let Some(delegation) = &self.offer.delegation else {
            // @agent 的 consult Run：要讀的 Run 還在這台 Runner 上時用它的 Worktree（唯讀）；
            // 已經不在時從 base_ref 開出唯讀的 Worktree（§12.3）。
            return Ok(self
                .offer
                .consult_of_run_id
                .as_ref()
                .and_then(|id| self.ctx.mcp.caller(id))
                .map(|caller| (caller, DelegationMode::Consult)));
        };
        match self.ctx.mcp.caller(&delegation.parent_run_id) {
            Some(caller) => Ok(Some((caller, delegation.mode))),
            None => Err(Stop::failed(
                RunErrorCode::WorktreeFailed,
                format!("父 Run {} 不在這台 Runner 上執行", delegation.parent_run_id),
            )),
        }
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
            option("allow_once", "允許這次", PermissionOptionKind::AllowOnce),
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

    /// 執行 setup。`wait_for_setup = false` 時在背景執行，回傳它的結果（成功與否）。
    async fn run_setup(&mut self) -> Result<Option<oneshot::Receiver<bool>>, Stop> {
        let wt = self.wt().clone();
        let Some(script) = wt
            .config
            .config
            .worktree
            .setup
            .clone()
            .filter(|s| !s.trim().is_empty())
        else {
            return Ok(None);
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
            let (done, done_rx) = oneshot::channel();
            tokio::spawn(async move {
                let (ok, _) = job.await;
                let _ = done.send(ok);
            });
            return Ok(Some(done_rx));
        }
        Ok(None)
    }

    /// 啟動 Preview（§13）：有 `[preview].command` 而且腳本已核准時，setup 成功後啟動。
    fn start_preview(&mut self, after: Option<oneshot::Receiver<bool>>) {
        let wt = self.wt();
        if !wt.scripts_approved {
            return;
        }
        let Some(spec) = PreviewSpec::from_worktree(wt) else {
            return;
        };
        let outbox = self.ctx.outbox.clone();
        let run_id = self.offer.run_id.clone();
        let notify = move |notice| {
            let kind = match notice {
                PreviewNotice::Ready { port, url } => EventKind::PreviewReady { port, url },
                PreviewNotice::Stopped {
                    reason,
                    exit_code,
                    output,
                } => EventKind::PreviewStopped {
                    reason,
                    exit_code,
                    output: normalize::truncate(output, 4000),
                },
            };
            if let Err(e) = outbox.emit(&run_id, now(), kind) {
                tracing::error!(run_id = %run_id, error = %e, "無法記錄 Preview 的 Event");
            }
        };
        let registration = Registration {
            registry: self.ctx.previews.clone(),
            run_id: self.offer.run_id.clone(),
        };
        self.preview = Some(Preview::start(
            spec,
            after,
            Some(registration),
            self.redactor.clone(),
            self.status_tx.subscribe(),
            PreviewTiming::default(),
            notify,
        ));
    }

    /// 啟動 Agent。`resume` 是要接續的 session ID；回傳是否真的接續了（Agent 不支援時開新的）。
    async fn start_agent(&mut self, resume: Option<String>) -> Result<bool, Stop> {
        let wt = self.wt().clone();
        let mcp_servers = vec![self.orbis_mcp_server()];
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
            AcpSession::start(&profile, spec, &wt.path, tx, resume.as_deref(), mcp_servers).await
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
        let resumed = session.resumed();
        self.emit(EventKind::AgentSession {
            session_id: session.session_id().to_owned(),
        });
        let learned = crate::agent::Learned {
            capabilities: session.capabilities().to_vec(),
            version: session.agent_info().map(|(_, version)| version),
        };
        if self.ctx.learned.record(&self.profile.id, learned) {
            self.ctx.availability_changed.notify_one();
        }
        self.session = Some(session);
        let mut rx = rx;
        if resumed {
            // `session/load` 重播的對話已經以 Event 送過了，丟棄。
            while rx.try_recv().is_ok() {}
        }
        self.notices = Some(rx);
        Ok(resumed)
    }

    /// 注入到 session 的 Orbis MCP server（ARCHITECTURE §9）。第一次呼叫時在 hub 登記這個 Run。
    fn orbis_mcp_server(&mut self) -> agent_client_protocol::schema::v1::McpServer {
        let delegation = self.offer.delegation.clone();
        let judge = self.offer.origin == Some(orbis_protocol::enums::RunOrigin::Verification);
        let token = match &self.mcp_token {
            Some(token) => token.clone(),
            None => {
                let token = self.ctx.mcp.register(crate::orbis_mcp::hub::Caller {
                    run_id: self.offer.run_id.clone(),
                    dispatch_id: self.offer.dispatch_id.clone(),
                    worktree: self.wt().clone(),
                    depth: delegation.as_ref().map_or(0, |d| d.depth.unwrap_or(1)),
                    parent: delegation.as_ref().map(|d| d.parent_run_id.clone()),
                    mode: delegation.as_ref().map(|d| d.mode),
                    judge,
                });
                self.mcp_token = Some(token.clone());
                token
            }
        };
        crate::orbis_mcp::session_server(self.ctx.mcp.endpoint(), &token, judge)
    }

    /// 結束 Agent、把設定檔還原成已接受的內容，再重新啟動 Agent，盡量接續同一個 session。
    /// 回傳接下來要送的 prompt。
    ///
    /// 一定要先結束整個程序樹再還原：否則 Agent 可能在還原之後、結束之前又改一次。
    async fn restart_agent(&mut self) -> Result<Prompt, Stop> {
        let previous = self.session.take().map(|session| {
            let id = session.session_id().to_owned();
            (id, session)
        });
        let resume = match previous {
            Some((id, session)) => {
                session.shutdown().await;
                Some(id)
            }
            None => None,
        };
        let changed = self.changed_agent_settings();
        self.restore_agent_settings(&changed)?;
        tracing::info!(run_id = %self.run_id(), ?resume, "還原設定檔後重新啟動 Agent");
        if self.start_agent(resume).await? {
            self.enter_plan_mode().await?;
            return Ok(Prompt::text(SETTINGS_RESUME_PROMPT, self.last_source));
        }
        self.enter_plan_mode().await?;
        let mut prompt = self.first_prompt().await;
        prompt.blocks.push(ContentBlock::Text {
            text: SETTINGS_RESTART_NOTE.to_owned(),
        });
        Ok(prompt)
    }

    /// 第一個 prompt：DispatchOffer 的 prompt；Planning 而且 Agent 沒有可靠的 plan 模式時，
    /// 接上只產出 plan 的指示。
    async fn first_prompt(&self) -> Prompt {
        let mut blocks = self.offer.prompt.clone();
        if self.fresh_continuation {
            blocks.push(ContentBlock::Text {
                text: self.continuation_context().await,
            });
        }
        if self.planning && self.profile.plan_mode.is_none() {
            blocks.push(ContentBlock::Text {
                text: PLAN_ONLY_PROMPT.to_owned(),
            });
        }
        Prompt {
            blocks,
            source: self.offer.prompt_source.unwrap_or(PromptSource::User),
        }
    }

    /// 沒有接續到原本 session 的 Feedback Loop Run：說明 Task 與分支上目前的變更。
    async fn continuation_context(&self) -> String {
        let wt = self.wt();
        let stat = wt
            .git()
            .run(["diff", "--stat", &wt.base_commit])
            .await
            .unwrap_or_default();
        format!(
            "（這是 {} {} 的 PR 修正。原本的 session 無法恢復，這是新的 session；之前的修改都在這個分支上。目前相對 base commit 的變更：\n{}）",
            self.offer.task.task_key,
            self.offer.task.title,
            self.redactor.redact(stat.trim())
        )
    }

    /// Planning 而且 profile 有可靠的 plan 模式時切過去。
    async fn enter_plan_mode(&mut self) -> Result<(), Stop> {
        let (true, Some(mode)) = (self.planning, self.profile.plan_mode.clone()) else {
            return Ok(());
        };
        let session = self.session.as_ref().expect("Agent 已啟動");
        session.set_mode(&mode).await.map_err(|e| {
            Stop::failed(
                RunErrorCode::AgentError,
                format!("無法切換到 plan 模式 {mode}：{e}"),
            )
        })
    }

    /// Plan Gate 核准：離開 Planning，有 plan 模式時切回執行用的模式。
    async fn leave_plan_mode(&mut self) -> Result<(), Stop> {
        self.planning = false;
        if self.profile.plan_mode.is_none() {
            return Ok(());
        }
        let session = self.session.as_ref().expect("Agent 已啟動");
        // 切回 profile 指定的執行模式；沒有指定時切回建立 session 時的模式。
        let Some(mode) = self
            .profile
            .session_mode
            .map(str::to_owned)
            .or_else(|| session.mode().map(str::to_owned))
        else {
            return Ok(());
        };
        session.set_mode(&mode).await.map_err(|e| {
            Stop::failed(
                RunErrorCode::AgentError,
                format!("Plan Gate 核准後無法切換到 {mode} 模式：{e}"),
            )
        })
    }

    /// 協定的 prompt 轉成 ACP 的內容。圖片在 Agent 支援時從 Server 下載、以圖片送出（issue #17，
    /// 例如 Review Gate 退回時附上的 Preview 截圖）；Agent 不支援或下載失敗時改成說明文字。
    async fn prompt_blocks(&self, blocks: &[ContentBlock]) -> Vec<acp::ContentBlock> {
        use base64::Engine as _;
        let images = self
            .session
            .as_ref()
            .is_some_and(|s| s.capabilities().contains(&AgentCapability::ImagePrompt));
        let mut out = Vec::new();
        for block in blocks {
            let ContentBlock::Image(blob) = block else {
                out.extend(normalize::prompt_to_acp(std::slice::from_ref(block)));
                continue;
            };
            if !images {
                out.extend(normalize::prompt_to_acp(std::slice::from_ref(block)));
                continue;
            }
            match self.ctx.blobs.fetch(blob).await {
                Ok(bytes) => out.push(acp::ContentBlock::Image(acp::ImageContent::new(
                    base64::engine::general_purpose::STANDARD.encode(bytes),
                    blob.media_type.clone(),
                ))),
                Err(error) => {
                    tracing::warn!(run_id = %self.run_id(), blob_id = %blob.blob_id, %error, "無法下載 prompt 中的圖片");
                    out.extend(normalize::prompt_to_acp(std::slice::from_ref(block)));
                    out.push(acp::ContentBlock::from(format!(
                        "（無法下載這張圖片：{}）",
                        self.redactor.redact(&error.to_string())
                    )));
                }
            }
        }
        out
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

    /// 受保護設定的基準：base commit 中的內容。以 `/` 結尾的目錄展開成其中的每個檔案。
    async fn load_settings_baseline(&mut self) {
        let wt = self.wt().clone();
        let git = wt.git();
        for entry in &self.profile.protected_paths {
            let files = if entry.ends_with('/') {
                git.run(["ls-tree", "-r", "--name-only", &wt.base_commit, "--", entry])
                    .await
                    .map(|out| out.lines().map(str::to_owned).collect())
                    .unwrap_or_default()
            } else {
                vec![entry.clone()]
            };
            for path in files {
                let content = git
                    .show_file(&wt.base_commit, &path)
                    .await
                    .ok()
                    .flatten()
                    .map(String::into_bytes);
                self.settings_baseline.insert(path, content);
            }
        }
    }

    /// 經權限請求允許、會寫入受保護設定檔的 tool call 結束了：它寫入的內容視為已接受。
    fn accept_approved_settings_write(&mut self, tool_call_id: &str) {
        let Some(paths) = self.approved_settings_writes.remove(tool_call_id) else {
            return;
        };
        let wt_path = self.wt().path.clone();
        for path in paths {
            match read_protected(&wt_path, &path) {
                Some(Protected::File(content)) => {
                    self.settings_baseline.insert(path, Some(content));
                }
                None => {
                    self.settings_baseline.insert(path, None);
                }
                // 連結不接受，之後的比對會問人。
                Some(Protected::Link) => {}
            }
        }
    }

    /// 和已接受的內容不同的受保護設定檔：（相對路徑, 目前狀態），依路徑排序。連結一律算變更。
    fn changed_agent_settings(&self) -> Vec<(String, Option<Protected>)> {
        let Some(wt) = self.worktree.as_ref() else {
            return Vec::new();
        };
        // 基準中的檔案，加上受保護目錄中目前存在的檔案（新增的檔案基準是「不存在」）。
        let mut paths: std::collections::BTreeSet<String> =
            self.settings_baseline.keys().cloned().collect();
        for entry in &self.profile.protected_paths {
            let entry = entry.trim_end_matches('/');
            // 受保護的位置本身（或它的上層）是連結時，把它本身也列進來：連結指向空目錄時
            // 底下沒有檔案可以比對。
            if read_protected(&wt.path, entry) == Some(Protected::Link) {
                paths.insert(entry.to_owned());
            }
            if self
                .profile
                .protected_paths
                .iter()
                .any(|p| p == &format!("{entry}/"))
            {
                paths.extend(files_under(&wt.path, entry));
            }
        }
        paths
            .into_iter()
            .filter_map(|path| {
                let current = read_protected(&wt.path, &path);
                let accepted = self.settings_baseline.get(&path).cloned().flatten();
                let same = match &current {
                    None => accepted.is_none(),
                    Some(Protected::File(content)) => accepted.as_ref() == Some(content),
                    Some(Protected::Link) => false,
                };
                (!same).then_some((path, current))
            })
            .collect()
    }

    /// Worktree 中 Agent 的設定檔和已接受的內容（一開始是 base commit）不同時，先問人
    /// （`agent_settings_changed`）。
    ///
    /// - 送出 prompt 前（含啟動 session 前）：允許才繼續，拒絕就停止 Run。
    /// - session 中途被改（issue #52）：接受變更，或把檔案還原成已接受的內容，兩者都繼續 Run。
    ///
    /// 回傳 `true` 表示人選擇還原（呼叫端要停掉 Agent、還原檔案再重新啟動，見 [`Self::restart_agent`]）。
    async fn check_agent_settings(&mut self, when: SettingsCheck) -> Result<bool, Stop> {
        let changed = self.changed_agent_settings();
        if changed.is_empty() {
            return Ok(false);
        }
        let list = changed
            .iter()
            .map(|(p, _)| p.as_str())
            .collect::<Vec<_>>()
            .join("、");
        // 設定中有連結時不能接受（不跟著連結讀，無法確認內容），只能還原或停止。
        let links = changed
            .iter()
            .filter(|(_, current)| matches!(current, Some(Protected::Link)))
            .map(|(p, _)| p.as_str())
            .collect::<Vec<_>>();
        let link_note = if links.is_empty() {
            String::new()
        } else {
            format!(
                "其中 {} 是連結（symlink／junction）；Agent 的設定不接受連結，只能還原或停止。",
                links.join("、")
            )
        };
        let (title, mut options) = match when {
            SettingsCheck::BeforePrompt => (
                format!(
                    "Worktree 中 Agent 的設定檔 {list} 和 base commit 不同，可能讓 Agent 繞過 Permission Policy。允許後才繼續。{link_note}"
                ),
                vec![
                    option("allow_once", "允許並繼續", PermissionOptionKind::AllowOnce),
                    option(
                        "reject_once",
                        "拒絕並停止 Run",
                        PermissionOptionKind::RejectOnce,
                    ),
                ],
            ),
            SettingsCheck::MidSession => (
                format!(
                    "Agent 在執行中修改了自己的設定檔 {list}，可能讓之後的操作不再經過 Permission Policy。已中止這個回合，請決定要接受變更還是還原。{link_note}"
                ),
                vec![
                    option(
                        "allow_once",
                        "接受變更並繼續",
                        PermissionOptionKind::AllowOnce,
                    ),
                    option(
                        "reject_once",
                        "還原設定檔並繼續",
                        PermissionOptionKind::RejectOnce,
                    ),
                ],
            ),
        };
        if !links.is_empty() {
            options.retain(|o| o.kind != PermissionOptionKind::AllowOnce);
        }
        let chosen = self
            .ask_human(
                PermissionPurpose::AgentSettingsChanged,
                None,
                title,
                options,
            )
            .await?;
        if chosen == "allow_once" {
            for (path, current) in changed {
                let accepted = match current {
                    Some(Protected::File(content)) => Some(content),
                    None => None,
                    Some(Protected::Link) => unreachable!("有連結時不提供接受的選項"),
                };
                self.settings_baseline.insert(path, accepted);
            }
            return Ok(false);
        }
        match when {
            SettingsCheck::BeforePrompt => Err(Stop::failed(
                RunErrorCode::AgentError,
                format!("Agent 設定檔的變更（{list}）沒有被允許"),
            )),
            // 先不還原：Agent 還在執行，可能再改一次。由呼叫端停掉 Agent 之後再還原。
            SettingsCheck::MidSession => Ok(true),
        }
    }

    /// 把被修改的設定檔還原成已接受的內容（原本不存在的就刪除）。
    ///
    /// 不跟著連結寫：設定檔本身是 symlink 時先移除連結；所在目錄（例如 `.claude`）解開
    /// symlink／junction 後不在 Worktree 內時拒絕還原，避免寫到 Worktree 外。
    fn restore_agent_settings(&self, changed: &[(String, Option<Protected>)]) -> Result<(), Stop> {
        let wt_path = self.wt().path.clone();
        for (path, _) in changed {
            let accepted = self.settings_baseline.get(path).cloned().flatten();
            restore_protected_file(&wt_path, path, accepted.as_deref()).map_err(|e| {
                Stop::failed(
                    RunErrorCode::AgentError,
                    format!("無法還原 Agent 的設定檔 {path}：{e}"),
                )
            })?;
        }
        Ok(())
    }

    // ── 執行與 Review ──────────────────────────────────────────────────────────

    async fn work(&mut self) -> Result<(), Stop> {
        let mut prompt = self.first_prompt().await;
        loop {
            match self.turn(prompt).await? {
                TurnEnd::RateLimited { resets_at, message } => {
                    self.wait_rate_limit(resets_at, message).await?;
                    prompt = Prompt::text(RESUME_PROMPT, self.last_source);
                }
                TurnEnd::SettingsChanged => {
                    let restore = self.check_agent_settings(SettingsCheck::MidSession).await?;
                    prompt = if restore {
                        // Agent 可能已經把新的設定載入記憶體（例如 Claude Code 的「永遠允許」同時
                        // 更新 session 中的規則），只還原檔案不夠：重新啟動 Agent 讓它重新讀取。
                        self.restart_agent().await?
                    } else {
                        Prompt::text(SETTINGS_RESUME_PROMPT, self.last_source)
                    };
                }
                TurnEnd::Done(_) if self.planning => {
                    self.propose_plan();
                    prompt = match self.await_plan_gate().await? {
                        PlanDecision::Approved => {
                            self.leave_plan_mode().await?;
                            Prompt::text(PLAN_APPROVED_PROMPT, PromptSource::PlanGate)
                        }
                        PlanDecision::Revise(next) => next,
                    };
                }
                TurnEnd::Done(reason) if !self.is_primary() => {
                    if !self.read_only {
                        self.send_run_diff().await;
                    }
                    self.set_status(RunStatus::Completed, None, Some(stop_reason_text(reason)));
                    self.ctx.outbox.finish_run(self.run_id());
                    return Ok(());
                }
                TurnEnd::Done(reason) => {
                    self.send_run_diff().await;
                    let mut message = stop_reason_text(reason);
                    // merge_child 的衝突在回合結束時還沒解決：停下來等人處理（§9）。
                    if self.unresolved_merge().await {
                        let text = "merge_child 的衝突還沒有解決，Agent 已結束回合";
                        self.emit(EventKind::Error {
                            code: RunErrorCode::MergeChildConflict,
                            message: text.to_owned(),
                            fatal: false,
                        });
                        message = text.to_owned();
                    }
                    self.set_status(
                        RunStatus::AwaitingGate,
                        Some(GateKind::Review),
                        Some(message),
                    );
                    match self.await_review().await? {
                        Some(next) => prompt = next,
                        None => return self.await_push().await,
                    }
                }
            }
        }
    }

    /// Worktree 是否停在還沒完成的 merge（`merge_child` 有衝突，Agent 還沒解決並 commit）。
    async fn unresolved_merge(&self) -> bool {
        match self.worktree.as_ref() {
            Some(wt) if wt.branch.is_some() => {
                wt.git()
                    .succeeds(["rev-parse", "-q", "--verify", "MERGE_HEAD"])
                    .await
            }
            _ => false,
        }
    }

    /// Planning 的回合結束：送出 plan（`plan_proposed`），進入 Plan Gate。
    fn propose_plan(&mut self) {
        let (text, source) = match self.plan_text.take() {
            Some(text) => (text, PlanSource::PlanMode),
            None if self.profile.plan_mode.is_some() => {
                (self.turn_text.clone(), PlanSource::PlanMode)
            }
            None => (self.turn_text.clone(), PlanSource::PromptFallback),
        };
        self.emit(EventKind::PlanProposed {
            body: TextBody::Inline {
                text: self.redactor.redact(&text),
            },
            source,
        });
        self.set_status(RunStatus::AwaitingGate, Some(GateKind::Plan), None);
    }

    /// 等 Plan Gate 的結果。
    async fn await_plan_gate(&mut self) -> Result<PlanDecision, Stop> {
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
                    gate: GateKind::Plan,
                    decision: GateDecision::Approved,
                } => {
                    self.applied(&control);
                    return Ok(PlanDecision::Approved);
                }
                RunControlAction::GateResult {
                    gate: GateKind::Plan,
                    decision: GateDecision::Rejected,
                } => {
                    // 退回的意見另外以 prompt 送出；在那之前維持 awaiting_gate（plan）。
                    self.applied(&control);
                }
                RunControlAction::Prompt { prompt, source } => {
                    self.applied(&control);
                    return Ok(PlanDecision::Revise(Prompt {
                        blocks: prompt.clone(),
                        source: source.unwrap_or(PromptSource::PlanGate),
                    }));
                }
                RunControlAction::PermissionResponse { .. } => self.reject(
                    &control,
                    RunControlRejectReason::UnknownPermissionRequest,
                    "沒有等待中的權限請求",
                ),
                _ => self.reject(
                    &control,
                    RunControlRejectReason::InvalidState,
                    "Run 正在等待 Plan Gate",
                ),
            }
        }
    }

    /// 送出 prompt，處理期間的 update、權限請求與 RunControl，直到回合結束。
    async fn turn(&mut self, prompt: Prompt) -> Result<TurnEnd, Stop> {
        self.check_agent_settings(SettingsCheck::BeforePrompt)
            .await?;
        self.rate_limit_hint = None;
        self.turn_text.clear();
        self.last_source = prompt.source;
        self.emit(EventKind::PromptSubmitted {
            prompt: prompt.blocks.clone(),
            source: prompt.source,
        });
        let prompt = self.prompt_blocks(&prompt.blocks).await;
        self.set_status(RunStatus::Running, None, None);
        let session = self.session.as_ref().expect("Agent 已啟動");
        let mut closed = session.closed();
        let turn = session.prompt(prompt);
        tokio::pin!(turn);
        let mut notices = self.notices.take().expect("Agent 已啟動");
        let mut canceling: Option<tokio::time::Instant> = None;
        let mut settings_changed = false;
        let result = loop {
            let deadline = canceling
                .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(86400 * 365));
            tokio::select! {
                result = &mut turn => break result,
                Some(notice) = notices.recv() => {
                    if self.on_notice(notice) && canceling.is_none() {
                        tracing::warn!(run_id = %self.run_id(), "回合中 Agent 的設定檔被修改，中止這個回合並問人");
                        self.session.as_ref().expect("Agent 已啟動").cancel();
                        self.cancel_pending();
                        settings_changed = true;
                        canceling = Some(tokio::time::Instant::now() + CANCEL_GRACE);
                    }
                }
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
                    if canceling.is_some() && !settings_changed {
                        return Err(Stop::Canceled);
                    }
                    let tail = self.session.as_ref().map(AcpSession::stderr_tail).unwrap_or_default();
                    return Err(Stop::failed(RunErrorCode::AgentCrashed, format!("Agent 程序非預期結束\n{tail}")));
                }
                () = tokio::time::sleep_until(deadline), if canceling.is_some() => {
                    tracing::warn!(run_id = %self.run_id(), "Agent 沒有在寬限期內結束回合，直接結束程序樹");
                    self.notices = Some(notices);
                    if settings_changed {
                        return Err(Stop::failed(
                            RunErrorCode::AgentError,
                            "Agent 的設定檔被修改後，Agent 沒有在寬限期內停下來",
                        ));
                    }
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
        if settings_changed {
            return Ok(TurnEnd::SettingsChanged);
        }
        if canceling.is_some() {
            return Err(Stop::Canceled);
        }
        // Claude Code 以 rate limit 事件回報額度用完，回合本身可能照常結束。
        if let Some(limit) = self.rate_limit_hint.take() {
            return Ok(TurnEnd::RateLimited {
                resets_at: limit.resets_at,
                message: match &result {
                    Err(error) => error.message.clone(),
                    Ok(_) => "Agent 回報額度用完".to_owned(),
                },
            });
        }
        match result {
            Ok(reason) => {
                self.emit(EventKind::FinalMessage {
                    text: TextBody::Inline {
                        text: self.redactor.redact(&self.turn_text),
                    },
                });
                Ok(TurnEnd::Done(reason))
            }
            Err(error) => match crate::rate_limit::from_error(&error) {
                Some(limit) => Ok(TurnEnd::RateLimited {
                    resets_at: limit.resets_at,
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
                if !options.iter().any(|(id, _)| id == option_id) {
                    self.reject(
                        &control,
                        RunControlRejectReason::UnknownPermissionRequest,
                        "option_id 不在選項中",
                    );
                    return false;
                }
                let Some(Pending::Agent {
                    reply,
                    options,
                    tool_call_id,
                    protected,
                }) = self.pending.remove(request_id)
                else {
                    unreachable!("剛剛確認過");
                };
                let allowed = options.iter().any(|(id, kind)| {
                    id == option_id
                        && matches!(
                            kind,
                            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
                        )
                });
                if allowed && !protected.is_empty() {
                    self.approved_settings_writes
                        .insert(tool_call_id, protected);
                }
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

    /// 處理 Agent 的訊息。回傳 `true` 表示 Agent 的設定檔在這個回合中被修改了（issue #52）：
    /// 每個 tool call 結束時與每個權限請求進來時，都和已接受的內容比對一次。
    fn on_notice(&mut self, notice: AgentNotice) -> bool {
        match notice {
            AgentNotice::Update(update) => {
                if let acp::SessionUpdate::AgentMessageChunk(chunk) = &update
                    && let acp::ContentBlock::Text(text) = &chunk.content
                {
                    self.turn_text.push_str(&text.text);
                }
                // 只接受 Claude Code 的 rate limit 事件（其他 Agent 送同樣的 `_meta` 不算數）。
                if let acp::SessionUpdate::UsageUpdate(usage) = &update
                    && self.profile.id == crate::agent::CLAUDE_CODE
                    && let Some(limit) = usage
                        .meta
                        .as_ref()
                        .and_then(crate::rate_limit::from_claude_meta)
                {
                    self.rate_limit_hint = Some(limit);
                }
                let finished = tool_call_finished(&update);
                if let Some(id) = &finished {
                    self.accept_approved_settings_write(id);
                }
                let events = self
                    .normalizer
                    .as_mut()
                    .expect("Worktree 已經建立")
                    .session_update(update);
                for event in events {
                    self.emit(event);
                }
                finished.is_some() && !self.changed_agent_settings().is_empty()
            }
            AgentNotice::Permission { request, reply } => {
                if !self.changed_agent_settings().is_empty() {
                    // 先中止回合問人；這個請求不再處理（回覆取消）。
                    let _ = reply.send(acp::RequestPermissionOutcome::Cancelled);
                    return true;
                }
                self.on_permission(request, reply);
                false
            }
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
        let policy_ctx = PolicyContext {
            policy: self.offer.permission_policy,
            worktree: &wt.path,
            allow_commands: &wt.config.config.permissions.allow_commands,
            default_branch: &wt.default_branch,
            protected_paths: &self.profile.protected_paths,
        };
        // plan 模式下 Agent 交出 plan（例如 Claude Code 的 ExitPlanMode，`rawInput.plan`）：
        // 記下 plan、拒絕切換模式，由 Plan Gate 決定（不轉給人）。
        if self.planning
            && self.profile.plan_mode.is_some()
            && let Some(plan) = request
                .tool_call
                .fields
                .raw_input
                .as_ref()
                .and_then(|raw| raw.get("plan"))
                .and_then(|p| p.as_str())
        {
            self.plan_text = Some(plan.to_owned());
            let reject = request
                .options
                .iter()
                .find(|o| {
                    matches!(
                        o.kind,
                        acp::PermissionOptionKind::RejectOnce
                            | acp::PermissionOptionKind::RejectAlways
                    )
                })
                .map(|o| o.option_id.clone());
            let _ = reply.send(match reject {
                Some(id) => {
                    acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(id))
                }
                None => acp::RequestPermissionOutcome::Cancelled,
            });
            return;
        }
        let mut decision = policy::decide(&subject, &policy_ctx);
        // Orbis 自己的 MCP 工具：防護規則由 Server 套用，不轉給人（Planning 中也可以用）。
        // 只用在「其他」類的請求（不是指令、讀寫檔案），而且只把問人改成允許，不推翻拒絕。
        let is_orbis_call = matches!(subject, crate::policy::PermissionSubject::Other { .. })
            && request
                .tool_call
                .fields
                .title
                .as_deref()
                .is_some_and(crate::orbis_mcp::is_orbis_tool);
        if is_orbis_call && matches!(decision, Decision::Ask { .. }) {
            decision = Decision::Allow;
        }
        // Planning 中（plan 核准之前）不可以修改檔案；指令與其他操作可能間接修改，原本會自動
        // 允許的也改成問人（不論 Permission Policy 的等級）。
        // Planning 中（plan 核准之前）與 consult 模式的 Child Run（在父 Run 的 Worktree 中）不可以
        // 修改檔案；指令與其他操作可能間接修改，原本會自動允許的也改成問人（不論 Permission
        // Policy 的等級，也不採用 allow_commands）。
        let restricted = if self.read_only {
            Some("consult 模式的 Child Run 是唯讀的")
        } else if self.planning {
            Some("Planning 階段不可以修改檔案")
        } else {
            None
        };
        if let Some(why) = restricted {
            match subject {
                // 寫入與刪除無條件拒絕（Orbis 工具一律是「其他」類，不會走到這裡）。
                crate::policy::PermissionSubject::Write { .. }
                | crate::policy::PermissionSubject::Delete { .. } => {
                    decision = Decision::Deny { reason: why.into() };
                }
                crate::policy::PermissionSubject::Command { .. }
                | crate::policy::PermissionSubject::Other { .. }
                    if decision == Decision::Allow && !is_orbis_call =>
                {
                    decision = Decision::Ask {
                        reason: format!("{why}：確認這個操作不會修改檔案"),
                    };
                }
                _ => {}
            }
        }
        let protected = policy::protected_targets(&subject, &policy_ctx);
        let tool_call_id = request.tool_call.tool_call_id.0.to_string();
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
            if matches!(decision, Decision::Allow) && !protected.is_empty() {
                self.approved_settings_writes
                    .insert(tool_call_id, protected);
            }
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
            .as_deref()
            .map(normalize::permission_title)
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| request.tool_call.tool_call_id.0.to_string());
        let request_id: PermissionRequestId = uuid::Uuid::now_v7().to_string().into();
        let options = normalize::permission_options(&request.options);
        self.pending.insert(
            request_id.clone(),
            Pending::Agent {
                reply,
                options: options
                    .iter()
                    .map(|o| (o.option_id.clone(), o.kind))
                    .collect(),
                tool_call_id,
                protected,
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

    /// rate limit：回報 Event、暫停到額度恢復（同一組 Credential 期間不接受新的 Dispatch），
    /// 之後由呼叫端在同一個 session 繼續。
    async fn wait_rate_limit(
        &mut self,
        resets_at: Option<std::time::SystemTime>,
        message: String,
    ) -> Result<(), Stop> {
        let now = std::time::SystemTime::now();
        let wait = match resets_at {
            Some(at) => at
                .duration_since(now)
                .unwrap_or_default()
                .clamp(MIN_RATE_LIMIT_WAIT, crate::rate_limit::MAX_RATE_LIMIT_WAIT),
            None => DEFAULT_RATE_LIMIT_WAIT,
        };
        let until = resets_at.unwrap_or(now + wait);
        self.emit(EventKind::RateLimited {
            resets_at: Some(Timestamp(
                humantime::format_rfc3339_millis(until).to_string(),
            )),
            message: self.redactor.redact(&message),
        });
        self.set_status(RunStatus::RateLimited, None, None);
        let limit_until = now + wait;
        self.ctx.rate_limits.set(
            &self.profile.credential,
            limit_until,
            self.ctx.availability_changed.clone(),
        );
        self.rate_limit_set = Some(limit_until);
        let result = self.interruptible(tokio::time::sleep(wait)).await;
        // 等完了（或 Run 被中止）：解除這個 Run 設的暫停。中止 Run 就能解除被 Agent 回報的
        // 恢復時間鎖住的 Credential。
        self.clear_rate_limit();
        result
    }

    fn clear_rate_limit(&mut self) {
        if let Some(until) = self.rate_limit_set.take() {
            self.ctx.rate_limits.clear(
                &self.profile.credential,
                until,
                &self.ctx.availability_changed,
            );
        }
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
    async fn await_review(&mut self) -> Result<Option<Prompt>, Stop> {
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
                RunControlAction::Prompt { prompt, source } => {
                    self.applied(&control);
                    return Ok(Some(Prompt {
                        blocks: prompt.clone(),
                        source: source.unwrap_or(PromptSource::ReviewGate),
                    }));
                }
                RunControlAction::Verify(request) => {
                    self.applied(&control);
                    let request = request.clone();
                    self.verify(&request).await?;
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
                // 協定版本 2 的動作：archive 由 A2 實作；restart_preview 由 Supervisor 處理，不會到這裡。
                RunControlAction::Archive | RunControlAction::RestartPreview => self.reject(
                    &control,
                    RunControlRejectReason::InvalidState,
                    "這個 Runner 還不支援這個動作",
                ),
            }
        }
    }

    /// 一輪 Verification（ARCHITECTURE §5.1）：逐條執行，每條送 `verification_result`，最後送
    /// `verification_completed` 並回到 `awaiting_gate`（review）。重試與上限由 Server 決定。
    async fn verify(
        &mut self,
        request: &orbis_protocol::verification::VerificationRequest,
    ) -> Result<(), Stop> {
        use orbis_protocol::verification::{VerificationKind, VerificationOutcome};
        self.set_status(RunStatus::Verifying, None, None);
        let mut outcomes = Vec::new();
        for criterion in &request.criteria {
            let (outcome, summary, evidence) = match criterion.kind {
                VerificationKind::Command => self.verify_command(criterion).await?,
                // TODO(A2, #32)：agent／browser 以 delegate（purpose = verification）建立 consult Child Run 判定。
                VerificationKind::Agent | VerificationKind::Browser => (
                    VerificationOutcome::Error,
                    "這台 Runner 還不支援 agent／browser 類型的判定".to_owned(),
                    Vec::new(),
                ),
            };
            outcomes.push(outcome);
            self.emit(EventKind::VerificationResult(
                orbis_protocol::verification::VerificationResult {
                    verification_id: request.verification_id.clone(),
                    attempt: request.attempt,
                    criterion_id: criterion.criterion_id.clone(),
                    outcome,
                    summary: self.redactor.redact(&summary),
                    evidence,
                    judged_by_run_id: None,
                },
            ));
        }
        let outcome = if outcomes.contains(&VerificationOutcome::Failed) {
            VerificationOutcome::Failed
        } else if outcomes.contains(&VerificationOutcome::Error) {
            VerificationOutcome::Error
        } else {
            VerificationOutcome::Passed
        };
        self.emit(EventKind::VerificationCompleted {
            verification_id: request.verification_id.clone(),
            attempt: request.attempt,
            outcome,
        });
        self.set_status(RunStatus::AwaitingGate, Some(GateKind::Review), None);
        Ok(())
    }

    /// `command` 類型：在 Worktree 執行指令（沒有指定時用 Repo 設定檔的 `[verify].commands`，
    /// 已經過信任核准），全部 exit code 為 0 才通過。
    async fn verify_command(
        &mut self,
        criterion: &orbis_protocol::verification::VerificationCriterion,
    ) -> Result<
        (
            orbis_protocol::verification::VerificationOutcome,
            String,
            Vec<orbis_protocol::verification::VerificationEvidence>,
        ),
        Stop,
    > {
        use orbis_protocol::verification::{VerificationEvidence, VerificationOutcome};
        let wt = self.wt().clone();
        let commands: Vec<String> = match &criterion.command {
            Some(command) if !command.trim().is_empty() => vec![command.clone()],
            _ => wt.config.config.verify.commands.clone(),
        };
        if commands.is_empty() {
            return Ok((
                VerificationOutcome::Error,
                format!(
                    "沒有可以執行的指令：條件沒有指定指令，{} 也沒有 [verify].commands",
                    crate::repo_config::config_path()
                ),
                Vec::new(),
            ));
        }
        if let Some(reason) = self.approve_verify_command(criterion).await? {
            return Ok((VerificationOutcome::Error, reason, Vec::new()));
        }
        let mut evidence = Vec::new();
        let mut failure: Option<String> = None;
        for command in &commands {
            let spec = crate::shell::Shell::for_script(command)
                .spec(command)
                .cwd(&wt.path)
                .envs(wt.env())
                .unattended_git();
            let run = tokio::time::timeout(VERIFY_COMMAND_TIMEOUT, crate::process::run(&spec));
            let (exit_code, output) = match self.interruptible(run).await? {
                Ok(Ok(out)) => (out.status.code(), out.combined()),
                Ok(Err(e)) => (None, format!("無法執行：{e:#}")),
                Err(_) => (
                    None,
                    format!(
                        "超過 {} 分鐘沒有結束",
                        VERIFY_COMMAND_TIMEOUT.as_secs() / 60
                    ),
                ),
            };
            let output = self.redactor.redact(&output);
            if exit_code != Some(0) && failure.is_none() {
                let tail: Vec<&str> = output.lines().rev().take(VERIFY_SUMMARY_LINES).collect();
                let tail: Vec<&str> = tail.into_iter().rev().collect();
                failure = Some(format!(
                    "`{command}` 失敗（exit code {}）：\n{}",
                    exit_code.map_or_else(|| "無".to_owned(), |c| c.to_string()),
                    tail.join("\n")
                ));
            }
            evidence.push(VerificationEvidence::CommandOutput {
                command: self.redactor.redact(command),
                exit_code,
                output: TextBody::Inline { text: output },
                truncated: false,
            });
        }
        Ok(match failure {
            Some(summary) => (VerificationOutcome::Failed, summary, evidence),
            None => (
                VerificationOutcome::Passed,
                format!("{} 個指令都通過", commands.len()),
                evidence,
            ),
        })
    }

    /// Task 指定的 Verification 指令：Task 的作者不一定是這台 Runner 的擁有者，執行前要經過
    /// Permission Policy（和 Repo 設定檔 `[verify].commands` 完全相同的指令已經過信任核准）。
    /// 沒有被自動允許時問人，同一個 Run 中同一個指令只問一次。回傳 `Some(原因)` 表示不執行。
    async fn approve_verify_command(
        &mut self,
        criterion: &orbis_protocol::verification::VerificationCriterion,
    ) -> Result<Option<String>, Stop> {
        let Some(command) = criterion.command.clone().filter(|c| !c.trim().is_empty()) else {
            return Ok(None);
        };
        let wt = self.wt().clone();
        if wt.config.config.verify.commands.contains(&command)
            || self.approved_verify_commands.contains(&command)
        {
            return Ok(None);
        }
        let decision = policy::decide(
            &crate::policy::PermissionSubject::Command {
                command: command.clone(),
            },
            &PolicyContext {
                policy: self.offer.permission_policy,
                worktree: &wt.path,
                allow_commands: &wt.config.config.permissions.allow_commands,
                default_branch: &wt.default_branch,
                protected_paths: &self.profile.protected_paths,
            },
        );
        match decision {
            Decision::Allow => {}
            Decision::Deny { reason } => {
                return Ok(Some(format!("不能執行 Task 指定的指令：{reason}")));
            }
            Decision::Ask { reason } => {
                let options = vec![
                    option("allow_once", "允許這次", PermissionOptionKind::AllowOnce),
                    option("reject_once", "拒絕", PermissionOptionKind::RejectOnce),
                ];
                let title = format!("Verification 要執行 Task 指定的指令：{command}（{reason}）");
                let chosen = self
                    .ask_human(PermissionPurpose::Tool, None, title, options)
                    .await?;
                if chosen != "allow_once" {
                    return Ok(Some("Task 指定的指令沒有被允許執行".into()));
                }
            }
        }
        self.approved_verify_commands.insert(command);
        Ok(None)
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
                            self.ctx.availability_changed.notify_one();
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

/// 把 Worktree 中的一個設定檔還原成 `content`（`None` 表示刪除）。不跟著連結寫：
/// 檔案本身是 symlink 時先移除連結；所在目錄解開 symlink／junction 後不在 Worktree 內時拒絕。
fn restore_protected_file(
    worktree: &std::path::Path,
    path: &str,
    content: Option<&[u8]>,
) -> Result<(), String> {
    let file = worktree.join(path);
    // 從 Worktree 根目錄往下，第一個是連結的那一層（可能是 `.claude` 本身）：移除連結本身。
    // 目錄連結（Windows 的 junction、目錄 symlink）要用 remove_dir。
    let mut current = worktree.to_path_buf();
    for part in path.split('/').filter(|p| !p.is_empty()) {
        current.push(part);
        if std::fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            std::fs::remove_file(&current)
                .or_else(|_| std::fs::remove_dir(&current))
                .map_err(|e| e.to_string())?;
            break;
        }
    }
    let parent = file.parent().unwrap_or(worktree);
    if !crate::paths::is_within(
        &crate::paths::canonical(parent),
        &crate::paths::canonical(worktree),
    ) {
        return Err("所在的目錄經由連結指向 Worktree 以外".into());
    }
    let result = match content {
        Some(content) => {
            std::fs::create_dir_all(parent).and_then(|()| std::fs::write(&file, content))
        }
        None => match std::fs::remove_file(&file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    };
    result.map_err(|e| e.to_string())
}

/// `worktree/<dir>` 之下的所有檔案（相對於 Worktree、`/` 分隔）。不跟著連結走進去：
/// symlink／junction 本身當成一個項目（內容見 [`read_protected`]）。
fn files_under(worktree: &std::path::Path, dir: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pending = vec![dir.to_owned()];
    while let Some(rel) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(worktree.join(&rel)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = format!("{rel}/{name}");
            match entry.file_type() {
                Ok(t) if t.is_dir() && !t.is_symlink() => pending.push(child),
                Ok(_) => out.push(child),
                Err(_) => {}
            }
        }
    }
    out
}

/// 受保護設定的目前狀態。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Protected {
    File(Vec<u8>),
    /// symlink／junction。Agent 的設定中不接受連結：不跟著讀（目標可能在 Worktree 外、
    /// 可能很大或形成循環），一律視為變更，只能還原或停止 Run（安全審查的發現）。
    Link,
}

/// `worktree/<rel>` 的目前狀態；不存在時為 `None`。不跟著連結：從 Worktree 根目錄往下，
/// 任何一層（例如 `.claude` 本身）是 symlink／junction 就是 [`Protected::Link`]。
fn read_protected(worktree: &std::path::Path, rel: &str) -> Option<Protected> {
    let mut path = worktree.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty() && *p != ".") {
        path.push(part);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => return Some(Protected::Link),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    std::fs::read(&path).ok().map(Protected::File)
}

/// 什麼時候檢查 Agent 的設定檔。
#[derive(Debug, Clone, Copy)]
enum SettingsCheck {
    /// 啟動 session 前、每次送出 prompt 前。
    BeforePrompt,
    /// session 中途偵測到被修改，回合已中止。
    MidSession,
}

/// 這筆 update 表示某個 tool call 結束（completed／failed）時，回傳它的 ID。
fn tool_call_finished(update: &acp::SessionUpdate) -> Option<String> {
    let (id, status) = match update {
        acp::SessionUpdate::ToolCall(call) => (&call.tool_call_id, Some(call.status)),
        acp::SessionUpdate::ToolCallUpdate(update) => (&update.tool_call_id, update.fields.status),
        _ => return None,
    };
    matches!(
        status,
        Some(acp::ToolCallStatus::Completed | acp::ToolCallStatus::Failed)
    )
    .then(|| id.0.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 建立目錄連結：Windows 用 junction（不需要權限），其他平台用 symlink。
    fn link_dir(target: &std::path::Path, link: &std::path::Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd.exe")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(status.status.success(), "{status:?}");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// 受保護目錄中的連結（例如 `.gemini/extensions` 換成指向別處的 junction）也算一個項目，
    /// 而且不跟著讀；還原時只移除連結本身。
    #[test]
    fn 受保護目錄中的連結算作變更() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(wt.join(".gemini")).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(wt.join(".gemini/settings.json"), "{}").unwrap();
        link_dir(&elsewhere, &wt.join(".gemini").join("extensions"));
        let mut files = files_under(&wt, ".gemini");
        files.sort();
        assert_eq!(files, [".gemini/extensions", ".gemini/settings.json"]);
        assert_eq!(
            read_protected(&wt, ".gemini/extensions"),
            Some(Protected::Link),
            "不跟著連結讀"
        );
        assert_eq!(
            read_protected(&wt, ".gemini/settings.json"),
            Some(Protected::File(b"{}".to_vec()))
        );
        restore_protected_file(&wt, ".gemini/extensions", None).unwrap();
        assert!(std::fs::symlink_metadata(wt.join(".gemini/extensions")).is_err());
        assert!(elsewhere.exists(), "只移除連結本身");
    }

    #[test]
    fn 還原設定檔_寫回內容或刪除() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(wt.join(".claude")).unwrap();
        std::fs::write(wt.join(".claude/settings.json"), "改過").unwrap();
        restore_protected_file(&wt, ".claude/settings.json", Some("原本".as_bytes())).unwrap();
        assert_eq!(
            std::fs::read_to_string(wt.join(".claude/settings.json")).unwrap(),
            "原本"
        );
        restore_protected_file(&wt, ".claude/settings.json", None).unwrap();
        assert!(!wt.join(".claude/settings.json").exists());
        restore_protected_file(&wt, ".claude/settings.json", None).unwrap();
    }

    /// 上層目錄（`.claude` 本身）是連結時，底下的設定也算連結（安全審查的發現）。
    #[test]
    fn 上層目錄是連結時算作連結() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("settings.json"), "外面").unwrap();
        link_dir(&outside, &wt.join(".claude"));
        assert_eq!(
            read_protected(&wt, ".claude/settings.json"),
            Some(Protected::Link)
        );
        assert_eq!(
            read_protected(&wt, ".claude/missing.json"),
            Some(Protected::Link)
        );
        assert_eq!(read_protected(&wt, ".claude"), Some(Protected::Link));
        assert_eq!(read_protected(&wt, "nothing/here"), None);
    }

    /// `.claude` 被換成指向 Worktree 外的連結時：還原只移除連結本身，不跟著寫到外面
    /// （安全審查的發現）。
    #[test]
    fn 還原設定檔_不跟著目錄連結寫到_worktree_外() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("settings.json"), "外面的檔案").unwrap();
        link_dir(&outside, &wt.join(".claude"));
        restore_protected_file(&wt, ".claude/settings.json", Some(b"x")).unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.join("settings.json")).unwrap(),
            "外面的檔案",
            "不可以寫到外面"
        );
        assert!(
            !std::fs::symlink_metadata(wt.join(".claude"))
                .unwrap()
                .file_type()
                .is_symlink(),
            "連結本身被移除，換成 Worktree 內真正的目錄"
        );
        assert_eq!(
            std::fs::read_to_string(wt.join(".claude").join("settings.json")).unwrap(),
            "x"
        );

        link_dir(&outside, &wt.join(".codex"));
        restore_protected_file(&wt, ".codex/settings.json", None).unwrap();
        assert!(
            outside.join("settings.json").exists(),
            "不可以刪除外面的檔案"
        );
        assert!(std::fs::symlink_metadata(wt.join(".codex")).is_err());
    }

    /// 設定檔本身是指向外面的 symlink：移除連結本身再寫入，外面的檔案不受影響。
    #[cfg(unix)]
    #[test]
    fn 還原設定檔_檔案本身是連結時移除連結() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(wt.join(".claude")).unwrap();
        let outside = dir.path().join("secret.json");
        std::fs::write(&outside, "外面的檔案").unwrap();
        std::os::unix::fs::symlink(&outside, wt.join(".claude/settings.json")).unwrap();
        restore_protected_file(&wt, ".claude/settings.json", Some("原本".as_bytes())).unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "外面的檔案");
        assert!(
            !std::fs::symlink_metadata(wt.join(".claude/settings.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
