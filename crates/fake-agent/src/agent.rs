//! ACP v1 agent 本體：依劇本回應 `initialize`、`session/new`、`session/prompt`、`session/cancel`。
//!
//! - 每個 session 各自從劇本的第一個回合開始，每次 `session/prompt` 消耗一個回合。
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
    Implementation, InitializeRequest, InitializeResponse, McpServer, NewSessionRequest,
    NewSessionResponse, PermissionOption, PermissionOptionKind, Plan, PlanEntry, PromptRequest,
    PromptResponse, RequestPermissionOutcome, RequestPermissionRequest, SessionId,
    SessionNotification, SessionUpdate, StopReason, ToolCall, ToolCallContent, ToolCallLocation,
    ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind, UsageUpdate,
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

/// 以 stdio 執行 Fake Agent，直到 stdin 關閉。
pub async fn serve_stdio(script: Script) -> Result<(), acp::Error> {
    let agent = Arc::new(FakeAgent::new(script));
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
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next_session: AtomicU64,
}

struct Session {
    id: SessionId,
    cwd: PathBuf,
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
    fn new(script: Script) -> Self {
        Self {
            script: Arc::new(script),
            sessions: Mutex::new(HashMap::new()),
            next_session: AtomicU64::new(1),
        }
    }

    fn initialize(&self, _request: &InitializeRequest) -> InitializeResponse {
        // 只支援 v1；client 要的版本不同時由 client 決定要不要繼續。
        InitializeResponse::new(ProtocolVersion::V1)
            .agent_capabilities(AgentCapabilities::new())
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
        let id = SessionId::new(format!("fake-session-{number}"));
        let session = Arc::new(Session {
            id: id.clone(),
            cwd: paths::normalize(&request.cwd),
            mcp_servers: request.mcp_servers,
            slot: Mutex::new(TurnSlot::default()),
            runtime: tokio::sync::Mutex::new(SessionRuntime::default()),
        });
        lock(&self.sessions).insert(id.0.to_string(), session);
        Ok(NewSessionResponse::new(id))
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
        Ok((index, receiver))
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
                let update = UsageUpdate::new(usage.used, usage.size).cost(
                    usage
                        .cost
                        .as_ref()
                        .map(|cost| Cost::new(cost.amount, cost.currency.clone())),
                );
                self.notify(SessionUpdate::UsageUpdate(update))?;
            }
            Step::McpCall(call) => return self.run_mcp_call(call).await,
            Step::SleepMs(ms) => {
                tokio::select! {
                    () = tokio::time::sleep(std::time::Duration::from_millis(*ms)) => {}
                    () = cancelled(self.cancel.clone()) => return Ok(Flow::Stop(StopReason::Cancelled)),
                }
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
                return Err(acp::Error::new(rate_limit.code, message).data(json!({
                    "type": RATE_LIMIT_ERROR_TYPE,
                    "retry_after_ms": rate_limit.retry_after_ms,
                })));
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
