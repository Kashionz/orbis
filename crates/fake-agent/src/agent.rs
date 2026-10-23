//! ACP v1 agent 本體：依劇本回應 `initialize`、`session/new`、`session/prompt`、`session/cancel`，
//! 以及指定 session 保存目錄（[`Options::state_dir`]）時的 `session/load`、`session/resume`。
//!
//! - 每個 session 各自從劇本的第一個回合開始，每次 `session/prompt` 消耗一個回合。
//! - 有保存目錄時，每個 session 的回合進度寫在 `<目錄>/<session id>.json`；程序結束後，
//!   另一個 Fake Agent 程序可以用 `session/load`／`session/resume` 從下一個回合接續。
//! - `session/prompt` 在背景 task 中執行，dispatch loop 不會被卡住，所以執行期間仍能收到
//!   `session/cancel` 與權限請求的回覆。
//! - 同一個 session 同時只能有一個進行中的 prompt；重疊時回 `invalid_request`。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AgentCapabilities, CancelNotification, Content, ContentBlock, ContentChunk, Cost, Diff,
    Implementation, InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse,
    McpServer, NewSessionRequest, NewSessionResponse, PermissionOption, PermissionOptionKind, Plan,
    PlanEntry, PromptRequest, PromptResponse, RequestPermissionOutcome, RequestPermissionRequest,
    ResumeSessionRequest, ResumeSessionResponse, SessionCapabilities, SessionId, SessionMode,
    SessionModeState, SessionNotification, SessionResumeCapabilities, SessionUpdate,
    SetSessionModeRequest, SetSessionModeResponse, StopReason, ToolCall, ToolCallContent,
    ToolCallLocation, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind, UsageUpdate,
};
use agent_client_protocol::{self as acp, BoxFuture, Client, ConnectionTo, Responder};
use serde_json::json;
use tokio::sync::watch;

use crate::mcp::McpConnection;
use crate::paths;
use crate::script::{
    EditStep, INTERNAL_ERROR_CODE, McpCallStep, PermissionStep, RATE_LIMIT_ERROR_TYPE, Script,
    Step, ToolCallStep,
};

/// 權限請求固定提供的選項（option ID 與 kind 同名）。
const PERMISSION_OPTIONS: [(&str, &str, PermissionOptionKind); 3] = [
    ("allow_once", "Allow", PermissionOptionKind::AllowOnce),
    (
        "allow_always",
        "Always Allow",
        PermissionOptionKind::AllowAlways,
    ),
    ("reject_once", "Reject", PermissionOptionKind::RejectOnce),
];

/// 使用者拒絕權限時，tool call 的內容。
const REJECTED_TEXT: &str = "使用者拒絕了這個操作";

/// `spawn_child` 回報子程序 PID 的訊息前綴。
pub const CHILD_PID_PREFIX: &str = "child pid: ";

/// 啟動一個一直執行的子程序（自己這個執行檔加上 `--hold`），回傳 PID。
/// 不等它結束：模擬 Agent 開了 dev server 之類的背景程序。
fn spawn_child() -> std::io::Result<u32> {
    let child = std::process::Command::new(std::env::current_exe()?)
        .arg("--hold")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(child.id())
}

/// 執行選項。
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// session 保存目錄。指定時宣告 `loadSession` 能力並支援 `session/load`。
    pub state_dir: Option<PathBuf>,
    /// 有保存目錄時是否也宣告並支援 `session/resume`。
    pub resume: bool,
    /// 提供的 session mode（`session/new` 回報、`session/set_mode` 可以切換）；空的表示不支援 mode。
    pub modes: Vec<String>,
    /// 新 session 一開始的 mode，預設是 `modes` 的第一個。
    pub initial_mode: Option<String>,
}

/// `echo_session_mode` 回報的前綴。
pub const SESSION_MODE_PREFIX: &str = "mode: ";

/// `session/load` 恢復 session 後補送的訊息（ACP 規定 load 要重播對話；Fake Agent 只送這一則）。
pub const LOADED_SESSION_TEXT: &str = "（已載入之前的 session）";

/// 以 stdio 執行 Fake Agent，直到 stdin 關閉。
pub async fn serve_stdio(script: Script) -> Result<(), acp::Error> {
    serve_stdio_with(script, Options::default()).await
}

/// 以 stdio 執行 Fake Agent（指定選項），直到 stdin 關閉。
pub async fn serve_stdio_with(script: Script, options: Options) -> Result<(), acp::Error> {
    let agent = Arc::new(FakeAgent::new(script, options));
    let result = acp::Agent
        .builder()
        .name(env!("CARGO_PKG_NAME"))
        .on_receive_request(
            {
                let agent = agent.clone();
                async move |request: InitializeRequest, responder, _cx| {
                    responder.respond(agent.initialize(&request))
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let agent = agent.clone();
                async move |request: NewSessionRequest, responder, _cx| {
                    responder.respond_with_result(agent.new_session(request))
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let agent = agent.clone();
                async move |request: LoadSessionRequest, responder, cx: ConnectionTo<Client>| {
                    match agent.restore_session(
                        &request.session_id,
                        &request.cwd,
                        request.mcp_servers,
                        request.meta,
                        false,
                    ) {
                        Ok(()) => {
                            let _ = cx.send_notification(SessionNotification::new(
                                request.session_id.clone(),
                                SessionUpdate::AgentMessageChunk(ContentChunk::new(
                                    ContentBlock::from(LOADED_SESSION_TEXT.to_owned()),
                                )),
                            ));
                            responder.respond(LoadSessionResponse::new())
                        }
                        Err(error) => responder.respond_with_error(error),
                    }
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let agent = agent.clone();
                async move |request: ResumeSessionRequest, responder, _cx| match agent
                    .restore_session(
                        &request.session_id,
                        &request.cwd,
                        request.mcp_servers,
                        request.meta,
                        true,
                    ) {
                    Ok(()) => responder.respond(ResumeSessionResponse::new()),
                    Err(error) => responder.respond_with_error(error),
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let agent = agent.clone();
                async move |request: SetSessionModeRequest, responder, _cx| match agent
                    .set_mode(&request.session_id, &request.mode_id.0)
                {
                    Ok(()) => responder.respond(SetSessionModeResponse::new()),
                    Err(error) => responder.respond_with_error(error),
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let agent = agent.clone();
                async move |request: PromptRequest, responder, cx| {
                    agent.prompt(request, responder, cx)
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_notification(
            {
                let agent = agent.clone();
                async move |notification: CancelNotification, _cx| {
                    agent.cancel(&notification.session_id);
                    Ok(())
                }
            },
            acp::on_receive_notification!(),
        )
        .connect_to(acp::Stdio::new())
        .await;
    agent.shutdown().await;
    result
}

struct FakeAgent {
    script: Arc<Script>,
    options: Options,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next_session: AtomicU64,
}

/// 保存在 session 保存目錄中的進度。
#[derive(serde::Serialize, serde::Deserialize)]
struct SavedSession {
    cwd: PathBuf,
    next_turn: usize,
}

struct Session {
    id: SessionId,
    cwd: PathBuf,
    /// 回合進度的保存位置（有 session 保存目錄時）。
    state_file: Option<PathBuf>,
    /// 建立或接續 session 時收到的 `_meta`（`echo_session_meta` 步驟回報）。
    meta: Option<serde_json::Map<String, serde_json::Value>>,
    /// 目前的 session mode（`echo_session_mode` 步驟回報）。
    mode: Mutex<Option<String>>,
    mcp_servers: Vec<McpServer>,
    slot: Mutex<TurnSlot>,
    runtime: tokio::sync::Mutex<SessionRuntime>,
}

/// 回合的進度與目前回合的取消開關。
#[derive(Default)]
struct TurnSlot {
    next_turn: usize,
    cancel: Option<watch::Sender<bool>>,
}

/// 回合之間保留的狀態。
#[derive(Default)]
struct SessionRuntime {
    next_tool_call: u64,
    mcp: HashMap<String, McpConnection>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl FakeAgent {
    fn new(script: Script, options: Options) -> Self {
        Self {
            script: Arc::new(script),
            options,
            sessions: Mutex::new(HashMap::new()),
            next_session: AtomicU64::new(1),
        }
    }

    fn initialize(&self, _request: &InitializeRequest) -> InitializeResponse {
        let persistent = self.options.state_dir.is_some();
        let mut sessions = SessionCapabilities::new();
        if persistent && self.options.resume {
            sessions = sessions.resume(SessionResumeCapabilities::new());
        }
        // 只支援 v1；client 要的版本不同時由 client 決定要不要繼續。
        InitializeResponse::new(ProtocolVersion::V1)
            .agent_capabilities(
                AgentCapabilities::new()
                    .load_session(persistent)
                    .session_capabilities(sessions),
            )
            .agent_info(Implementation::new(
                env!("CARGO_PKG_NAME"),
                env!("CARGO_PKG_VERSION"),
            ))
    }

    fn new_session(&self, request: NewSessionRequest) -> Result<NewSessionResponse, acp::Error> {
        if !request.cwd.is_absolute() {
            return Err(acp::Error::invalid_params()
                .data(json!({ "reason": "cwd must be an absolute path", "cwd": request.cwd })));
        }
        let number = self.next_session.fetch_add(1, Ordering::Relaxed);
        // 有保存目錄時，ID 要跨程序不重複。
        let id = SessionId::new(match self.options.state_dir {
            Some(_) => format!("fake-session-{}-{number}", std::process::id()),
            None => format!("fake-session-{number}"),
        });
        let session = self.insert_session(&id, &request.cwd, request.mcp_servers, 0, request.meta);
        session.save()?;
        let modes = (!self.options.modes.is_empty()).then(|| {
            SessionModeState::new(
                lock(&session.mode).clone().unwrap_or_default(),
                self.options
                    .modes
                    .iter()
                    .map(|m| SessionMode::new(m.clone(), m.clone()))
                    .collect(),
            )
        });
        Ok(NewSessionResponse::new(id).modes(modes))
    }

    /// `session/set_mode`：只接受 `modes` 中的 mode。
    fn set_mode(&self, id: &SessionId, mode: &str) -> Result<(), acp::Error> {
        let Some(session) = self.session(id) else {
            return Err(acp::Error::invalid_params()
                .data(json!({ "reason": "unknown session", "session_id": id })));
        };
        if !self.options.modes.iter().any(|m| m == mode) {
            return Err(acp::Error::invalid_params()
                .data(json!({ "reason": "unknown mode", "mode": mode })));
        }
        *lock(&session.mode) = Some(mode.to_owned());
        Ok(())
    }

    fn insert_session(
        &self,
        id: &SessionId,
        cwd: &std::path::Path,
        mcp_servers: Vec<McpServer>,
        next_turn: usize,
        meta: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Arc<Session> {
        let session = Arc::new(Session {
            id: id.clone(),
            cwd: paths::normalize(cwd),
            state_file: self
                .options
                .state_dir
                .as_ref()
                .map(|dir| dir.join(format!("{}.json", id.0))),
            meta,
            mode: Mutex::new(
                self.options
                    .initial_mode
                    .clone()
                    .or_else(|| self.options.modes.first().cloned()),
            ),
            mcp_servers,
            slot: Mutex::new(TurnSlot {
                next_turn,
                cancel: None,
            }),
            runtime: tokio::sync::Mutex::new(SessionRuntime::default()),
        });
        lock(&self.sessions).insert(id.0.to_string(), session.clone());
        session
    }

    /// `session/load`、`session/resume`：從保存目錄讀出進度，從下一個回合接續。
    fn restore_session(
        &self,
        id: &SessionId,
        cwd: &std::path::Path,
        mcp_servers: Vec<McpServer>,
        meta: Option<serde_json::Map<String, serde_json::Value>>,
        resume: bool,
    ) -> Result<(), acp::Error> {
        let supported = self.options.state_dir.is_some() && (!resume || self.options.resume);
        let Some(dir) = self.options.state_dir.as_ref().filter(|_| supported) else {
            return Err(acp::Error::method_not_found());
        };
        let file = dir.join(format!("{}.json", id.0));
        let saved: SavedSession = std::fs::read(&file)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .ok_or_else(|| {
                acp::Error::invalid_params()
                    .data(json!({ "reason": "unknown session", "session_id": id }))
            })?;
        if paths::normalize(cwd) != paths::normalize(&saved.cwd) {
            return Err(acp::Error::invalid_params().data(json!({
                "reason": "cwd does not match the saved session",
                "cwd": cwd,
                "saved": saved.cwd,
            })));
        }
        self.insert_session(id, cwd, mcp_servers, saved.next_turn, meta);
        Ok(())
    }

    fn session(&self, id: &SessionId) -> Option<Arc<Session>> {
        lock(&self.sessions).get(id.0.as_ref()).cloned()
    }

    fn prompt(
        &self,
        request: PromptRequest,
        responder: Responder<PromptResponse>,
        cx: ConnectionTo<Client>,
    ) -> Result<(), acp::Error> {
        let Some(session) = self.session(&request.session_id) else {
            return responder
                .respond_with_error(acp::Error::invalid_params().data(
                    json!({ "reason": "unknown session", "session_id": request.session_id }),
                ));
        };
        let (turn_index, cancel) = match session.begin_turn() {
            Ok(begun) => begun,
            Err(error) => return responder.respond_with_error(error),
        };
        let script = self.script.clone();
        cx.clone().spawn(async move {
            let result = run_turn(&script, turn_index, &request, &session, cx, cancel).await;
            session.end_turn();
            // 連線已經斷掉時回覆失敗也沒關係。
            let _ = responder.respond_with_result(result.map(PromptResponse::new));
            Ok(())
        })
    }

    fn cancel(&self, id: &SessionId) {
        if let Some(session) = self.session(id)
            && let Some(cancel) = &lock(&session.slot).cancel
        {
            let _ = cancel.send(true);
        }
    }

    async fn shutdown(&self) {
        let sessions: Vec<_> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        for session in sessions {
            if let Ok(mut runtime) = session.runtime.try_lock() {
                for (_, connection) in runtime.mcp.drain() {
                    connection.close().await;
                }
            }
        }
    }
}

impl Session {
    fn begin_turn(&self) -> Result<(usize, watch::Receiver<bool>), acp::Error> {
        let mut slot = lock(&self.slot);
        if slot.cancel.is_some() {
            return Err(acp::Error::invalid_request()
                .data(json!({ "reason": "a prompt is already running in this session" })));
        }
        let index = slot.next_turn;
        slot.next_turn += 1;
        let (sender, receiver) = watch::channel(false);
        slot.cancel = Some(sender);
        drop(slot);
        self.save()?;
        Ok((index, receiver))
    }

    /// 把回合進度寫進保存目錄（有指定時）。
    fn save(&self) -> Result<(), acp::Error> {
        let Some(file) = &self.state_file else {
            return Ok(());
        };
        let saved = SavedSession {
            cwd: self.cwd.clone(),
            next_turn: lock(&self.slot).next_turn,
        };
        let write = || -> std::io::Result<()> {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(file, serde_json::to_vec(&saved)?)
        };
        write().map_err(|error| {
            acp::Error::internal_error().data(json!({ "reason": error.to_string() }))
        })
    }

    fn end_turn(&self) {
        lock(&self.slot).cancel = None;
    }
}

async fn run_turn(
    script: &Script,
    turn_index: usize,
    request: &PromptRequest,
    session: &Session,
    cx: ConnectionTo<Client>,
    cancel: watch::Receiver<bool>,
) -> Result<StopReason, acp::Error> {
    let Some(turn) = script.turns.get(turn_index) else {
        return Err(
            acp::Error::new(INTERNAL_ERROR_CODE, "script has no turns left")
                .data(json!({ "turns": script.turns.len(), "prompt_index": turn_index })),
        );
    };
    if let Some(expected) = &turn.expect_prompt_contains {
        let text = prompt_text(&request.prompt);
        if !text.contains(expected.as_str()) {
            return Err(acp::Error::invalid_params().data(json!({
                "reason": "prompt does not contain the text expected by the script",
                "expected": expected,
                "prompt": text,
            })));
        }
    }
    let mut runtime = session.runtime.lock().await;
    let mut runner = TurnRunner {
        cx,
        session,
        runtime: &mut runtime,
        cancel,
    };
    let flow = runner.run_steps(&turn.steps).await?;
    Ok(match flow {
        Flow::Stop(reason) => reason,
        Flow::Continue if runner.is_cancelled() => StopReason::Cancelled,
        Flow::Continue => StopReason::EndTurn,
    })
}

fn prompt_text(prompt: &[ContentBlock]) -> String {
    prompt
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 一個步驟執行完之後要繼續還是結束回合。
enum Flow {
    Continue,
    Stop(StopReason),
}

type StepResult = Result<Flow, acp::Error>;

struct TurnRunner<'a> {
    cx: ConnectionTo<Client>,
    session: &'a Session,
    runtime: &'a mut SessionRuntime,
    cancel: watch::Receiver<bool>,
}

/// 等到回合被取消。
async fn cancelled(mut cancel: watch::Receiver<bool>) {
    if cancel.wait_for(|cancelled| *cancelled).await.is_err() {
        // 開關不見了代表回合已經結束，不會再被取消。
        std::future::pending::<()>().await;
    }
}

fn text_content(text: impl Into<String>) -> ToolCallContent {
    ToolCallContent::Content(Content::new(ContentBlock::from(text.into())))
}

impl TurnRunner<'_> {
    fn is_cancelled(&self) -> bool {
        *self.cancel.borrow()
    }

    fn notify(&self, update: SessionUpdate) -> Result<(), acp::Error> {
        self.cx
            .send_notification(SessionNotification::new(self.session.id.clone(), update))
    }

    fn update_tool_call(&self, id: &str, fields: ToolCallUpdateFields) -> Result<(), acp::Error> {
        self.notify(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            id.to_owned(),
            fields,
        )))
    }

    fn tool_call_id(&mut self, explicit: Option<&str>) -> String {
        self.runtime.next_tool_call += 1;
        explicit.map_or_else(
            || format!("call-{}", self.runtime.next_tool_call),
            str::to_owned,
        )
    }

    fn run_steps<'s>(&'s mut self, steps: &'s [Step]) -> BoxFuture<'s, StepResult> {
        Box::pin(async move {
            for step in steps {
                if self.is_cancelled() {
                    return Ok(Flow::Stop(StopReason::Cancelled));
                }
                if let Flow::Stop(reason) = self.run_step(step).await? {
                    return Ok(Flow::Stop(reason));
                }
            }
            Ok(Flow::Continue)
        })
    }

    async fn run_step(&mut self, step: &Step) -> StepResult {
        match step {
            Step::Message(text) => {
                self.notify(SessionUpdate::AgentMessageChunk(ContentChunk::new(
                    ContentBlock::from(text.clone()),
                )))?;
            }
            Step::Thought(text) => {
                self.notify(SessionUpdate::AgentThoughtChunk(ContentChunk::new(
                    ContentBlock::from(text.clone()),
                )))?;
            }
            Step::ToolCall(tool_call) => {
                let id = self.tool_call_id(tool_call.id.as_deref());
                self.announce_tool_call(&id, tool_call)?;
                self.execute_tool_call(&id, tool_call)?;
            }
            Step::Permission(permission) => return self.run_permission(permission).await,
            Step::Plan(entries) => {
                let entries = entries
                    .iter()
                    .map(|entry| {
                        PlanEntry::new(
                            entry.content.clone(),
                            entry.priority.clone(),
                            entry.status.clone(),
                        )
                    })
                    .collect();
                self.notify(SessionUpdate::Plan(Plan::new(entries)))?;
            }
            Step::Usage(usage) => {
                let update = UsageUpdate::new(usage.used, usage.size)
                    .cost(
                        usage
                            .cost
                            .as_ref()
                            .map(|cost| Cost::new(cost.amount, cost.currency.clone())),
                    )
                    .meta(usage.meta.clone());
                self.notify(SessionUpdate::UsageUpdate(update))?;
            }
            Step::McpCall(call) => return self.run_mcp_call(call).await,
            Step::SleepMs(ms) => {
                tokio::select! {
                    () = tokio::time::sleep(std::time::Duration::from_millis(*ms)) => {}
                    () = cancelled(self.cancel.clone()) => return Ok(Flow::Stop(StopReason::Cancelled)),
                }
            }
            Step::EchoSessionMode => {
                let mode = lock(&self.session.mode)
                    .clone()
                    .unwrap_or_else(|| "none".to_owned());
                self.notify(SessionUpdate::AgentMessageChunk(ContentChunk::new(
                    ContentBlock::from(format!("{SESSION_MODE_PREFIX}{mode}")),
                )))?;
            }
            Step::EchoSessionMeta => {
                let meta = serde_json::to_string(&self.session.meta).unwrap_or_default();
                self.notify(SessionUpdate::AgentMessageChunk(ContentChunk::new(
                    ContentBlock::from(meta),
                )))?;
            }
            Step::SpawnChild => {
                let pid = spawn_child().map_err(|error| {
                    acp::Error::internal_error().data(json!({ "reason": error.to_string() }))
                })?;
                self.notify(SessionUpdate::AgentMessageChunk(ContentChunk::new(
                    ContentBlock::from(format!("{CHILD_PID_PREFIX}{pid}")),
                )))?;
            }
            Step::WaitForCancel => {
                cancelled(self.cancel.clone()).await;
                return Ok(Flow::Stop(StopReason::Cancelled));
            }
            Step::Error(error) => {
                return Err(
                    acp::Error::new(error.code, error.message.clone()).data(error.data.clone())
                );
            }
            Step::RateLimit(rate_limit) => {
                let message = rate_limit.message.clone().unwrap_or_else(|| {
                    format!(
                        "Rate limit exceeded: retry after {} ms",
                        rate_limit.retry_after_ms
                    )
                });
                let data = rate_limit.data.clone().unwrap_or_else(|| {
                    json!({
                        "type": RATE_LIMIT_ERROR_TYPE,
                        "retry_after_ms": rate_limit.retry_after_ms,
                    })
                });
                return Err(acp::Error::new(rate_limit.code, message).data(data));
            }
            Step::Stop(reason) => return Ok(Flow::Stop(*reason)),
        }
        Ok(Flow::Continue)
    }

    /// 送出 pending 狀態的 tool call。
    fn announce_tool_call(&self, id: &str, step: &ToolCallStep) -> Result<(), acp::Error> {
        let mut call = ToolCall::new(id.to_owned(), step.title.clone())
            .kind(step.effective_kind())
            .status(ToolCallStatus::Pending)
            .raw_input(step.raw_input.clone());
        if let Some(edit) = &step.edit
            && let Ok(path) = paths::resolve_in_cwd(&self.session.cwd, &edit.path)
        {
            call = call.locations(vec![ToolCallLocation::new(path)]);
        }
        self.notify(SessionUpdate::ToolCall(call))
    }

    /// 執行 tool call：in_progress → 寫檔 → completed／failed。
    fn execute_tool_call(&self, id: &str, step: &ToolCallStep) -> Result<(), acp::Error> {
        self.update_tool_call(
            id,
            ToolCallUpdateFields::new().status(ToolCallStatus::InProgress),
        )?;
        let mut status = step.status.unwrap_or(ToolCallStatus::Completed);
        let mut content = Vec::new();
        if let Some(edit) = &step.edit
            && status != ToolCallStatus::Failed
        {
            match apply_edit(&self.session.cwd, edit) {
                Ok(diff) => content.push(ToolCallContent::Diff(diff)),
                Err(reason) => {
                    status = ToolCallStatus::Failed;
                    content.push(text_content(reason));
                }
            }
        }
        if let Some(output) = &step.output {
            content.push(text_content(output.clone()));
        }
        let mut fields = ToolCallUpdateFields::new().status(status);
        if !content.is_empty() {
            fields = fields.content(content);
        }
        self.update_tool_call(id, fields)
    }

    async fn run_permission(&mut self, step: &PermissionStep) -> StepResult {
        let id = self.tool_call_id(step.tool_call.id.as_deref());
        self.announce_tool_call(&id, &step.tool_call)?;
        let options = PERMISSION_OPTIONS
            .iter()
            .map(|(option_id, name, kind)| PermissionOption::new(*option_id, *name, *kind))
            .collect();
        let fields = ToolCallUpdateFields::new()
            .title(step.tool_call.title.clone())
            .kind(step.tool_call.effective_kind())
            .status(ToolCallStatus::Pending)
            .raw_input(step.tool_call.raw_input.clone());
        let request = RequestPermissionRequest::new(
            self.session.id.clone(),
            ToolCallUpdate::new(id.clone(), fields),
            options,
        );
        let response = tokio::select! {
            response = self.cx.send_request(request).block_task() => response?,
            () = cancelled(self.cancel.clone()) => return Ok(Flow::Stop(StopReason::Cancelled)),
        };
        let option_id = match response.outcome {
            RequestPermissionOutcome::Selected(selected) => selected.option_id,
            // `cancelled` 與未來新增的結果都視為取消。
            _ => return Ok(Flow::Stop(StopReason::Cancelled)),
        };
        let kind = PERMISSION_OPTIONS
            .iter()
            .find(|(candidate, _, _)| *candidate == option_id.0.as_ref())
            .map(|(_, _, kind)| *kind)
            .ok_or_else(|| {
                acp::Error::invalid_params()
                    .data(json!({ "reason": "unknown permission option", "option_id": option_id }))
            })?;
        match kind {
            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways => {
                self.execute_tool_call(&id, &step.tool_call)?;
                self.run_steps(&step.allow).await
            }
            _ => {
                self.update_tool_call(
                    &id,
                    ToolCallUpdateFields::new()
                        .status(ToolCallStatus::Failed)
                        .content(vec![text_content(REJECTED_TEXT)]),
                )?;
                self.run_steps(&step.reject).await
            }
        }
    }

    async fn run_mcp_call(&mut self, step: &McpCallStep) -> StepResult {
        let id = self.tool_call_id(step.id.as_deref());
        let title = step
            .title
            .clone()
            .unwrap_or_else(|| format!("{}/{}", step.server, step.tool));
        self.notify(SessionUpdate::ToolCall(
            ToolCall::new(id.clone(), title)
                .kind(ToolKind::Other)
                .status(ToolCallStatus::Pending)
                .raw_input(json!({
                    "server": step.server,
                    "tool": step.tool,
                    "arguments": step.arguments,
                })),
        ))?;
        self.update_tool_call(
            &id,
            ToolCallUpdateFields::new().status(ToolCallStatus::InProgress),
        )?;
        let cancel = self.cancel.clone();
        let outcome = tokio::select! {
            outcome = self.call_mcp(step) => outcome,
            () = cancelled(cancel) => return Ok(Flow::Stop(StopReason::Cancelled)),
        };
        let fields = match outcome {
            Ok(result) => {
                let failed = result.is_error == Some(true);
                let content: Vec<_> = result
                    .content
                    .iter()
                    .map(|block| match block.as_text() {
                        Some(text) => text_content(text.text.clone()),
                        None => text_content(serde_json::to_string(block).unwrap_or_default()),
                    })
                    .collect();
                ToolCallUpdateFields::new()
                    .status(if failed {
                        ToolCallStatus::Failed
                    } else {
                        ToolCallStatus::Completed
                    })
                    .content(content)
                    .raw_output(serde_json::to_value(&result).ok())
            }
            Err(error) => ToolCallUpdateFields::new()
                .status(ToolCallStatus::Failed)
                .content(vec![text_content(format!("{error:#}"))]),
        };
        self.update_tool_call(&id, fields)?;
        Ok(Flow::Continue)
    }

    async fn call_mcp(
        &mut self,
        step: &McpCallStep,
    ) -> anyhow::Result<rmcp::model::CallToolResult> {
        if !self.runtime.mcp.contains_key(&step.server) {
            let server = self
                .session
                .mcp_servers
                .iter()
                .find_map(|server| match server {
                    McpServer::Stdio(stdio) if stdio.name == step.server => Some(stdio),
                    _ => None,
                })
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "session/new 沒有注入名為 {} 的 stdio MCP server",
                        step.server
                    )
                })?;
            let connection = McpConnection::connect(server, &self.session.cwd).await?;
            self.runtime.mcp.insert(step.server.clone(), connection);
        }
        self.runtime.mcp[&step.server]
            .call_tool(&step.tool, step.arguments.clone())
            .await
    }
}

/// 寫入檔案並產生 ACP diff。失敗時回傳給人看的原因。
fn apply_edit(cwd: &std::path::Path, edit: &EditStep) -> Result<Diff, String> {
    let path = paths::resolve_in_cwd(cwd, &edit.path)?;
    let write = |text: &str| -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("無法建立目錄 {}：{error}", parent.display()))?;
        }
        std::fs::write(&path, text).map_err(|error| format!("無法寫入 {}：{error}", path.display()))
    };
    match (&edit.content, &edit.old_text, &edit.new_text) {
        (Some(content), _, _) => {
            let previous = std::fs::read_to_string(&path).ok();
            write(content)?;
            Ok(Diff::new(path.clone(), content.clone()).old_text(previous))
        }
        (None, Some(old_text), Some(new_text)) => {
            let current = std::fs::read_to_string(&path)
                .map_err(|error| format!("無法讀取 {}：{error}", path.display()))?;
            if !current.contains(old_text.as_str()) {
                return Err(format!("{} 中找不到要取代的文字", path.display()));
            }
            write(&current.replacen(old_text.as_str(), new_text, 1))?;
            Ok(Diff::new(path.clone(), new_text.clone()).old_text(old_text.clone()))
        }
        // 劇本驗證已排除其他組合。
        _ => Err("edit 缺少 content 或 old_text／new_text".to_owned()),
    }
}
