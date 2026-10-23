//! `AcpAgentAdapter`：以 ACP v1（JSON-RPC over stdio）驅動 Agent（ADR-0002）。
//!
//! - Agent 程序放在自己的 Job Object／process group（[`ProcessTree`]），結束 session 時整棵樹一起結束。
//! - stdout 由 ACP 連線持續讀取；stderr 另外持續排空並保留最後幾行，Agent 當掉時放進錯誤訊息。
//! - `session/update` 與 `session/request_permission` 轉成 [`AgentNotice`] 交給 Run 處理；
//!   權限請求的回覆在背景等待，不會卡住 ACP 的 dispatch loop。
//! - Runner 不宣告 `fs`／`terminal` client 能力：Agent 自己執行工具，Runner 只回覆權限請求。

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::Implementation;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, InitializeRequest, InitializeResponse, LoadSessionRequest,
    NewSessionRequest, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, ResumeSessionRequest, SessionId, SessionModeId, SessionModeState,
    SessionNotification, SessionUpdate, SetSessionModeRequest, StopReason,
};
use agent_client_protocol::{self as acp, Agent, ByteStreams, ConnectionTo};
use anyhow::Context;
use orbis_protocol::availability::AgentCapability;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::AgentProfile;
use crate::process::{self, Pipes, ProcessSpec, ProcessTree};

/// 保留 Agent stderr 的最後幾行。
const STDERR_TAIL_LINES: usize = 40;

/// Agent 送給 Runner 的訊息。
#[derive(Debug)]
pub enum AgentNotice {
    Update(SessionUpdate),
    /// 權限請求。`reply` 被丟棄時視為取消。
    Permission {
        request: RequestPermissionRequest,
        reply: oneshot::Sender<RequestPermissionOutcome>,
    },
}

/// 啟動失敗或 ACP 錯誤。
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("無法啟動 Agent：{0:#}")]
    Start(anyhow::Error),
    #[error("Agent 回報錯誤：{0}")]
    Acp(acp::Error),
}

/// 一個 Agent 程序與它的 ACP session。
pub struct AcpSession {
    cx: ConnectionTo<Agent>,
    session_id: SessionId,
    capabilities: Vec<AgentCapability>,
    agent_info: Option<Implementation>,
    /// 是否接續了之前的 session（`session/resume` 或 `session/load`），而不是開新的。
    resumed: bool,
    tree: ProcessTree,
    shutdown: Option<oneshot::Sender<()>>,
    driver: tokio::task::JoinHandle<()>,
    closed: watch::Receiver<bool>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl std::fmt::Debug for AcpSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpSession")
            .field("session_id", &self.session_id)
            .field("pid", &self.tree.id())
            .finish_non_exhaustive()
    }
}

impl AcpSession {
    /// 啟動 Agent、完成 `initialize` 與 `session/new`，並套用 profile 的修補。
    ///
    /// `resume` 指定之前的 session ID 時，Agent 支援就以 `session/resume`（不重播對話）或
    /// `session/load`（會重播對話，重播的 update 照樣送進 `notices`，由呼叫端丟棄）接續；
    /// 都不支援時開新的 session，[`Self::resumed`] 為 `false`。
    pub async fn start(
        profile: &AgentProfile,
        spec: ProcessSpec,
        cwd: &Path,
        notices: mpsc::UnboundedSender<AgentNotice>,
        resume: Option<&str>,
    ) -> Result<Self, AgentError> {
        let mut tree = ProcessTree::spawn(&spec.cwd(cwd), Pipes::ALL).map_err(AgentError::Start)?;
        let stdin = tree
            .take_stdin()
            .context("Agent 沒有 stdin")
            .map_err(AgentError::Start)?;
        let stdout = tree
            .take_stdout()
            .context("Agent 沒有 stdout")
            .map_err(AgentError::Start)?;
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stderr) = tree.take_stderr() {
            let tail = stderr_tail.clone();
            let agent = profile.id.clone();
            tokio::spawn(process::drain_lines(stderr, move |line| {
                tracing::debug!(agent = %agent, "{line}");
                let mut tail = tail
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if tail.len() == STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }));
        }

        let (ready_tx, ready_rx) = oneshot::channel::<ConnectionTo<Agent>>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let (closed_tx, closed) = watch::channel(false);
        let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());
        let updates = notices.clone();
        let permissions = notices;
        let driver = tokio::spawn(async move {
            let result = acp::Client
                .builder()
                .name(env!("CARGO_PKG_NAME"))
                .on_receive_notification(
                    async move |notification: SessionNotification, _cx| {
                        let _ = updates.send(AgentNotice::Update(notification.update));
                        Ok(())
                    },
                    acp::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |request: RequestPermissionRequest, responder, cx| {
                        let (reply, wait) = oneshot::channel();
                        let _ = permissions.send(AgentNotice::Permission { request, reply });
                        // 在背景等人或政策的回覆，不卡住 dispatch loop。
                        cx.spawn(async move {
                            let outcome = wait.await.unwrap_or(RequestPermissionOutcome::Cancelled);
                            responder.respond(RequestPermissionResponse::new(outcome))
                        })
                    },
                    acp::on_receive_request!(),
                )
                .connect_with(transport, async move |cx: ConnectionTo<Agent>| {
                    let _ = ready_tx.send(cx.clone());
                    tokio::select! {
                        _ = shutdown_rx => {}
                        () = cx.incoming_closed() => {}
                    }
                    Ok(())
                })
                .await;
            if let Err(error) = result {
                tracing::debug!(?error, "ACP 連線結束");
            }
            let _ = closed_tx.send(true);
        });

        let mut session = Self {
            cx: match ready_rx.await {
                Ok(cx) => cx,
                Err(_) => {
                    return Err(AgentError::Start(anyhow::anyhow!(
                        "ACP 連線還沒建立就結束了"
                    )));
                }
            },
            session_id: SessionId::new(""),
            capabilities: Vec::new(),
            agent_info: None,
            resumed: false,
            tree,
            shutdown: Some(shutdown_tx),
            driver,
            closed,
            stderr_tail,
        };
        if let Err(error) = session.handshake(profile, cwd, resume).await {
            let tail = session.stderr_tail();
            session.shutdown().await;
            return Err(match error {
                AgentError::Acp(e) if !tail.is_empty() => {
                    AgentError::Start(anyhow::anyhow!("{e}\nAgent stderr：\n{tail}"))
                }
                other => other,
            });
        }
        Ok(session)
    }

    async fn handshake(
        &mut self,
        profile: &AgentProfile,
        cwd: &Path,
        resume: Option<&str>,
    ) -> Result<(), AgentError> {
        let init: InitializeResponse = self
            .cx
            .send_request(InitializeRequest::new(ProtocolVersion::V1).client_info(
                Implementation::new(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION")),
            ))
            .block_task()
            .await
            .map_err(AgentError::Acp)?;
        self.capabilities = profile.capabilities(&init);
        self.agent_info = init.agent_info.clone();

        let caps = &init.agent_capabilities;
        let modes = match resume {
            Some(id) if caps.session_capabilities.resume.is_some() => {
                let response = self
                    .cx
                    .send_request(
                        ResumeSessionRequest::new(id.to_owned(), cwd)
                            .meta(profile.session_meta.clone()),
                    )
                    .block_task()
                    .await
                    .map_err(AgentError::Acp)?;
                self.session_id = SessionId::new(id.to_owned());
                self.resumed = true;
                response.modes
            }
            Some(id) if caps.load_session => {
                let response = self
                    .cx
                    .send_request(
                        LoadSessionRequest::new(id.to_owned(), cwd)
                            .meta(profile.session_meta.clone()),
                    )
                    .block_task()
                    .await
                    .map_err(AgentError::Acp)?;
                self.session_id = SessionId::new(id.to_owned());
                self.resumed = true;
                response.modes
            }
            _ => {
                let response = self
                    .cx
                    .send_request(NewSessionRequest::new(cwd).meta(profile.session_meta.clone()))
                    .block_task()
                    .await
                    .map_err(AgentError::Acp)?;
                self.session_id = response.session_id.clone();
                response.modes
            }
        };
        self.apply_session_mode(profile, modes.as_ref()).await
    }

    /// 修補：切到會詢問權限的模式（使用者設定可能預設 bypass）。
    async fn apply_session_mode(
        &mut self,
        profile: &AgentProfile,
        modes: Option<&SessionModeState>,
    ) -> Result<(), AgentError> {
        if let (Some(wanted), Some(modes)) = (profile.session_mode, modes)
            && modes.current_mode_id.0.as_ref() != wanted
            && modes
                .available_modes
                .iter()
                .any(|m| m.id.0.as_ref() == wanted)
        {
            tracing::info!(
                from = %modes.current_mode_id.0,
                to = wanted,
                "切換 session mode"
            );
            self.cx
                .send_request(SetSessionModeRequest::new(
                    self.session_id.clone(),
                    SessionModeId::new(wanted),
                ))
                .block_task()
                .await
                .map_err(AgentError::Acp)?;
        }
        Ok(())
    }

    pub fn capabilities(&self) -> &[AgentCapability] {
        &self.capabilities
    }

    /// ACP session ID（Feedback Loop 與重新啟動 Agent 時用來接續）。
    pub fn session_id(&self) -> &str {
        &self.session_id.0
    }

    /// 是否接續了之前的 session。
    pub fn resumed(&self) -> bool {
        self.resumed
    }

    /// `initialize` 回報的 Agent 名稱與版本。
    pub fn agent_info(&self) -> Option<(String, String)> {
        self.agent_info
            .as_ref()
            .map(|i| (i.name.clone(), i.version.clone()))
    }

    pub fn pid(&self) -> Option<u32> {
        self.tree.id()
    }

    /// 送出 prompt，等這個回合結束。可以和 [`Self::cancel`] 同時進行。
    pub fn prompt(
        &self,
        prompt: Vec<ContentBlock>,
    ) -> impl std::future::Future<Output = Result<StopReason, acp::Error>> + Send + 'static {
        let request = self
            .cx
            .send_request(PromptRequest::new(self.session_id.clone(), prompt));
        async move { request.block_task().await.map(|r| r.stop_reason) }
    }

    /// 送出 `session/cancel`。Agent 之後應以 stop reason `cancelled` 結束回合。
    pub fn cancel(&self) {
        if let Err(error) = self
            .cx
            .send_notification(CancelNotification::new(self.session_id.clone()))
        {
            tracing::debug!(?error, "送出 session/cancel 失敗");
        }
    }

    /// ACP 連線是否已經結束（Agent 程序結束或關閉 stdout）。
    pub fn closed(&self) -> watch::Receiver<bool> {
        self.closed.clone()
    }

    /// Agent stderr 的最後幾行。
    pub fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 結束 ACP 連線並結束整個程序樹。
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Err(error) = self.tree.kill().await {
            tracing::debug!(?error, "結束 Agent 程序樹時發生錯誤");
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), &mut self.driver).await;
    }
}
