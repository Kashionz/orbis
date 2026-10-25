//! 以 ACP client 身分啟動編譯好的 `orbis-fake-agent`，每一份隨附劇本都跑一次，
//! 驗證 update 序列、權限請求的來回、stop reason 與錯誤。

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AuthenticateRequest, CancelNotification, ContentBlock, Diff, EnvVariable, ImageContent,
    InitializeRequest, McpServer, McpServerStdio, NewSessionRequest, PermissionOptionKind,
    PlanEntryStatus, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionConfigKind, SessionConfigOption,
    SessionConfigOptionCategory, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, StopReason, ToolCallContent, ToolCallStatus, ToolCallUpdate,
};
use agent_client_protocol::{self as acp, AcpAgent, AcpAgentConfig, Agent, ConnectionTo};
use tempfile::TempDir;

/// 每個測試最多跑這麼久，避免卡住 CI。
const TEST_TIMEOUT: Duration = Duration::from_secs(60);

/// 有對應測試的劇本；`scripts/` 新增劇本時要在這裡登記並補上測試。
const COVERED_SCRIPTS: [&str; 20] = [
    "cancel.yaml",
    "config-options.yaml",
    "deleg-child.yaml",
    "deleg-parent.yaml",
    "diff.yaml",
    "empty-diff.yaml",
    "error.yaml",
    "feedback.yaml",
    "login.yaml",
    "long-turn.yaml",
    "m1.yaml",
    "mcp.yaml",
    "permission.yaml",
    "plan-verify.yaml",
    "plan.yaml",
    "preview-comment.yaml",
    "rate-limit.yaml",
    "spawn-child.yaml",
    "two-turns.yaml",
    "verify-fail.yaml",
];

const FAKE_MCP_NAME: &str = "fake-mcp";

#[derive(Debug, Clone, Copy)]
enum PermissionReply {
    Allow,
    Reject,
    Cancel,
}

#[derive(Default)]
struct Recorded {
    updates: Vec<SessionUpdate>,
    permissions: Vec<RequestPermissionRequest>,
}

/// 一次 `session/prompt` 的結果與期間收到的訊息。
struct Prompted {
    result: Result<StopReason, acp::Error>,
    updates: Vec<SessionUpdate>,
    permissions: Vec<RequestPermissionRequest>,
}

impl Prompted {
    fn stop_reason(&self) -> StopReason {
        match &self.result {
            Ok(reason) => *reason,
            Err(error) => panic!("prompt 應該成功，實際錯誤：{error:?}"),
        }
    }

    fn error(&self) -> &acp::Error {
        match &self.result {
            Ok(reason) => panic!("prompt 應該失敗，實際 stop reason：{reason:?}"),
            Err(error) => error,
        }
    }

    fn described(&self) -> Vec<String> {
        self.updates.iter().map(describe).collect()
    }

    /// 某個 tool call 最後一次帶內容的更新。
    fn final_update(&self, id: &str) -> &ToolCallUpdate {
        self.updates
            .iter()
            .rev()
            .find_map(|update| match update {
                SessionUpdate::ToolCallUpdate(update)
                    if update.tool_call_id.0.as_ref() == id && update.fields.content.is_some() =>
                {
                    Some(update)
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("找不到 {id} 帶內容的 tool_call_update"))
    }
}

/// 把 update 轉成好比對的一行字：種類加上關鍵欄位。
fn describe(update: &SessionUpdate) -> String {
    fn snake(value: impl serde::Serialize) -> String {
        serde_json::to_value(value)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "?".to_owned())
    }
    fn text(block: &ContentBlock) -> &str {
        match block {
            ContentBlock::Text(text) => &text.text,
            _ => "<non-text>",
        }
    }
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => format!("message {}", text(&chunk.content)),
        SessionUpdate::AgentThoughtChunk(chunk) => format!("thought {}", text(&chunk.content)),
        SessionUpdate::ToolCall(call) => format!(
            "tool_call {} {} {}",
            call.tool_call_id.0,
            snake(call.kind),
            snake(call.status)
        ),
        SessionUpdate::ToolCallUpdate(update) => format!(
            "tool_call_update {} {}",
            update.tool_call_id.0,
            update.fields.status.map_or_else(|| "-".to_owned(), snake)
        ),
        SessionUpdate::Plan(plan) => format!(
            "plan {}",
            plan.entries
                .iter()
                .map(|entry| snake(entry.status.clone()))
                .collect::<Vec<_>>()
                .join(",")
        ),
        SessionUpdate::UsageUpdate(usage) => format!("usage {}/{}", usage.used, usage.size),
        other => format!("other {other:?}"),
    }
}

fn texts(update: &ToolCallUpdate) -> Vec<String> {
    update
        .fields
        .content
        .iter()
        .flatten()
        .filter_map(|content| match content {
            ToolCallContent::Content(content) => match &content.content {
                ContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn diffs(update: &ToolCallUpdate) -> Vec<Diff> {
    update
        .fields
        .content
        .iter()
        .flatten()
        .filter_map(|content| match content {
            ToolCallContent::Diff(diff) => Some(diff.clone()),
            _ => None,
        })
        .collect()
}

fn assert_same_file(actual: &Path, expected: &Path) {
    assert!(
        actual.is_absolute(),
        "diff 路徑應該是絕對路徑：{}",
        actual.display()
    );
    assert_eq!(
        std::fs::canonicalize(actual).unwrap(),
        std::fs::canonicalize(expected).unwrap()
    );
}

/// 測試端的 ACP 連線。
struct Conn {
    cx: ConnectionTo<Agent>,
    recorded: Arc<Mutex<Recorded>>,
}

impl Conn {
    async fn initialize(&self) -> Result<(), acp::Error> {
        let response = self
            .cx
            .send_request(InitializeRequest::new(ProtocolVersion::V1))
            .block_task()
            .await?;
        assert_eq!(response.protocol_version, ProtocolVersion::V1);
        assert_eq!(
            response.agent_info.as_ref().map(|info| info.name.as_str()),
            Some("orbis-fake-agent")
        );
        Ok(())
    }

    async fn new_session(
        &self,
        cwd: &Path,
        mcp_servers: Vec<McpServer>,
    ) -> Result<SessionId, acp::Error> {
        self.initialize().await?;
        let response = self
            .cx
            .send_request(NewSessionRequest::new(cwd).mcp_servers(mcp_servers))
            .block_task()
            .await?;
        Ok(response.session_id)
    }

    fn prompt_request(session_id: &SessionId, text: &str) -> PromptRequest {
        PromptRequest::new(
            session_id.clone(),
            vec![ContentBlock::from(text.to_owned())],
        )
    }

    fn take_recorded(&self) -> Recorded {
        std::mem::take(&mut *self.recorded.lock().unwrap())
    }

    async fn prompt(&self, session_id: &SessionId, text: &str) -> Prompted {
        let result = self
            .cx
            .send_request(Self::prompt_request(session_id, text))
            .block_task()
            .await
            .map(|response| response.stop_reason);
        let recorded = self.take_recorded();
        Prompted {
            result,
            updates: recorded.updates,
            permissions: recorded.permissions,
        }
    }
}

/// `script` 是 `scripts/` 下的檔名，或測試自己寫出的劇本的絕對路徑。
fn agent_process(script: &str) -> AcpAgent {
    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join(script);
    AcpAgent::new(
        AcpAgentConfig::new(env!("CARGO_BIN_EXE_orbis-fake-agent"))
            .arg("--script")
            .arg(script_path.to_string_lossy()),
    )
}

/// 啟動 Fake Agent，以 ACP client 身分執行 `body`。
async fn with_agent<R, F, Fut>(script: &str, reply: PermissionReply, body: F) -> R
where
    R: Send + 'static,
    F: FnOnce(Conn) -> Fut + Send + 'static,
    Fut: Future<Output = Result<R, acp::Error>> + Send,
{
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let run = acp::Client
        .builder()
        .on_receive_notification(
            {
                let recorded = recorded.clone();
                async move |notification: SessionNotification, _cx| {
                    recorded.lock().unwrap().updates.push(notification.update);
                    Ok(())
                }
            },
            acp::on_receive_notification!(),
        )
        .on_receive_request(
            {
                let recorded = recorded.clone();
                async move |request: RequestPermissionRequest, responder, _cx| {
                    let wanted = match reply {
                        PermissionReply::Allow => Some(PermissionOptionKind::AllowOnce),
                        PermissionReply::Reject => Some(PermissionOptionKind::RejectOnce),
                        PermissionReply::Cancel => None,
                    };
                    let outcome = wanted
                        .and_then(|kind| request.options.iter().find(|option| option.kind == kind))
                        .map_or(RequestPermissionOutcome::Cancelled, |option| {
                            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                                option.option_id.clone(),
                            ))
                        });
                    recorded.lock().unwrap().permissions.push(request);
                    responder.respond(RequestPermissionResponse::new(outcome))
                }
            },
            acp::on_receive_request!(),
        )
        .connect_with(
            agent_process(script),
            async move |cx: ConnectionTo<Agent>| body(Conn { cx, recorded }).await,
        );
    match tokio::time::timeout(TEST_TIMEOUT, run).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => panic!("ACP 連線錯誤：{error:?}"),
        Err(_) => panic!("測試逾時"),
    }
}

fn workdir() -> TempDir {
    tempfile::Builder::new()
        .prefix("fake agent ")
        .tempdir()
        .unwrap()
}

fn fake_mcp(command: impl Into<PathBuf>, env: Vec<EnvVariable>) -> McpServer {
    McpServer::Stdio(McpServerStdio::new(FAKE_MCP_NAME, command).env(env))
}

#[test]
fn 每一份劇本都有對應的測試() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts");
    let mut found: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".yaml"))
        .collect();
    found.sort();
    assert_eq!(found, COVERED_SCRIPTS);
}

#[tokio::test(flavor = "multi_thread")]
async fn diff_劇本寫入檔案且內容與_diff_一致() {
    let dir = workdir();
    std::fs::write(dir.path().join("README.md"), "# Demo\n").unwrap();
    let cwd = dir.path().to_owned();
    let prompted = with_agent(
        "diff.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            Ok(conn.prompt(&session, "請新增 hello.txt").await)
        },
    )
    .await;

    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    assert!(prompted.permissions.is_empty());
    assert_eq!(
        prompted.described(),
        [
            "thought 先看看專案裡有什麼。",
            "message 我來新增 hello.txt，並更新 README.md。",
            "tool_call read-readme read pending",
            "tool_call_update read-readme in_progress",
            "tool_call_update read-readme completed",
            "tool_call write-hello edit pending",
            "tool_call_update write-hello in_progress",
            "tool_call_update write-hello completed",
            "tool_call edit-readme edit pending",
            "tool_call_update edit-readme in_progress",
            "tool_call_update edit-readme completed",
            "usage 1200/200000",
            "message 完成了。",
        ]
    );

    assert_eq!(texts(prompted.final_update("read-readme")), ["# Demo\n"]);

    // 新檔案：old_text 省略，new_text 是整份內容。
    let hello = dir.path().join("hello.txt");
    let written = std::fs::read_to_string(&hello).unwrap();
    assert_eq!(written, "hello from fake agent\n");
    let [diff] = diffs(prompted.final_update("write-hello"))
        .try_into()
        .unwrap();
    assert_same_file(&diff.path, &hello);
    assert_eq!(diff.old_text, None);
    assert_eq!(diff.new_text, written);

    // 既有檔案的片段取代：diff 只帶片段。
    let readme = dir.path().join("README.md");
    let readme_text = std::fs::read_to_string(&readme).unwrap();
    assert_eq!(readme_text, "# Demo\n\n已由 Fake Agent 更新。\n");
    let [diff] = diffs(prompted.final_update("edit-readme"))
        .try_into()
        .unwrap();
    assert_same_file(&diff.path, &readme);
    assert_eq!(diff.old_text.as_deref(), Some("# Demo"));
    assert!(readme_text.contains(&diff.new_text));

    let usage = prompted
        .updates
        .iter()
        .find_map(|update| match update {
            SessionUpdate::UsageUpdate(usage) => Some(usage.clone()),
            _ => None,
        })
        .unwrap();
    let cost = usage.cost.unwrap();
    assert_eq!(cost.currency, "USD");
    assert!((cost.amount - 0.0125).abs() < f64::EPSILON);
}

#[tokio::test(flavor = "multi_thread")]
async fn 回合用完後再_prompt_回錯誤() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let second = with_agent(
        "plan.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            conn.prompt(&session, "第一次").await.stop_reason();
            Ok(conn.prompt(&session, "第二次").await)
        },
    )
    .await;
    let error = second.error();
    assert_eq!(i32::from(error.code), -32603);
    assert_eq!(error.message, "script has no turns left");
}

async fn run_permission(reply: PermissionReply) -> (TempDir, Prompted) {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let prompted = with_agent("permission.yaml", reply, async move |conn: Conn| {
        let session = conn.new_session(&cwd, vec![]).await?;
        Ok(conn.prompt(&session, "請寫入設定").await)
    })
    .await;
    (dir, prompted)
}

fn assert_permission_request(prompted: &Prompted) {
    let [request] = prompted.permissions.as_slice() else {
        panic!(
            "應該剛好有一次權限請求，實際 {}",
            prompted.permissions.len()
        );
    };
    assert_eq!(request.tool_call.tool_call_id.0.as_ref(), "write-config");
    assert_eq!(
        request.tool_call.fields.title.as_deref(),
        Some("寫入 config.json")
    );
    let options: Vec<_> = request
        .options
        .iter()
        .map(|option| (option.option_id.0.to_string(), option.kind))
        .collect();
    assert_eq!(
        options,
        [
            ("allow_once".to_owned(), PermissionOptionKind::AllowOnce),
            ("allow_always".to_owned(), PermissionOptionKind::AllowAlways),
            ("reject_once".to_owned(), PermissionOptionKind::RejectOnce),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn 權限劇本_允許時寫入並走允許分支() {
    let (dir, prompted) = run_permission(PermissionReply::Allow).await;
    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    assert_permission_request(&prompted);
    assert_eq!(
        prompted.described(),
        [
            "message 我需要寫入 config.json。",
            "tool_call write-config edit pending",
            "tool_call_update write-config in_progress",
            "tool_call_update write-config completed",
            "message 已寫入 config.json。",
        ]
    );
    let config = dir.path().join("config.json");
    assert_eq!(
        std::fs::read_to_string(&config).unwrap(),
        "{ \"enabled\": true }\n"
    );
    let [diff] = diffs(prompted.final_update("write-config"))
        .try_into()
        .unwrap();
    assert_same_file(&diff.path, &config);
}

#[tokio::test(flavor = "multi_thread")]
async fn 權限劇本_拒絕時不寫入並走拒絕分支() {
    let (dir, prompted) = run_permission(PermissionReply::Reject).await;
    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    assert_permission_request(&prompted);
    assert_eq!(
        prompted.described(),
        [
            "message 我需要寫入 config.json。",
            "tool_call write-config edit pending",
            "tool_call_update write-config failed",
            "message 好，我不會修改 config.json。",
        ]
    );
    assert_eq!(
        texts(prompted.final_update("write-config")),
        ["使用者拒絕了這個操作"]
    );
    assert!(!dir.path().join("config.json").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn 權限劇本_回覆_cancelled_時回合以_cancelled_結束() {
    let (dir, prompted) = run_permission(PermissionReply::Cancel).await;
    assert_eq!(prompted.stop_reason(), StopReason::Cancelled);
    assert_eq!(prompted.permissions.len(), 1);
    assert_eq!(
        prompted.described(),
        [
            "message 我需要寫入 config.json。",
            "tool_call write-config edit pending",
        ]
    );
    assert!(!dir.path().join("config.json").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn plan_劇本送出整份_plan() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let prompted = with_agent(
        "plan.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            Ok(conn.prompt(&session, "請規劃").await)
        },
    )
    .await;
    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        prompted.described(),
        [
            "plan in_progress,pending,pending",
            "message 需求讀完了。",
            "plan completed,completed,completed",
        ]
    );
    let SessionUpdate::Plan(plan) = &prompted.updates[0] else {
        panic!("第一個 update 應該是 plan");
    };
    let contents: Vec<_> = plan
        .entries
        .iter()
        .map(|entry| entry.content.as_str())
        .collect();
    assert_eq!(contents, ["讀懂需求", "修改程式碼", "補上測試"]);
    assert_eq!(plan.entries[0].status, PlanEntryStatus::InProgress);
}

#[tokio::test(flavor = "multi_thread")]
async fn 錯誤劇本_回_json_rpc_錯誤後以_refusal_結束() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let (first, second) = with_agent(
        "error.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let first = conn.prompt(&session, "第一次").await;
            let second = conn.prompt(&session, "第二次").await;
            Ok((first, second))
        },
    )
    .await;

    assert_eq!(first.described(), ["message 開始處理……"]);
    let error = first.error();
    assert_eq!(i32::from(error.code), -32603);
    assert_eq!(error.message, "Internal error");
    assert_eq!(
        error.data,
        Some(serde_json::json!({ "details": "模型服務回傳 500" }))
    );

    assert_eq!(second.stop_reason(), StopReason::Refusal);
    assert_eq!(second.described(), ["message 我不能這樣做。"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_diff_劇本_回覆模型錯誤後以_end_turn_結束且不改檔() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let prompted = with_agent(
        "empty-diff.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            Ok(conn.prompt(&session, "修改登入頁").await)
        },
    )
    .await;

    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        prompted.described(),
        ["message The 'gpt-x' model is not supported when using Codex with a ChatGPT account."]
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn rate_limit_劇本_第一次錯誤_第二次在同一個_session_完成() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let (first, second) = with_agent(
        "rate-limit.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let first = conn.prompt(&session, "開始").await;
            let second = conn.prompt(&session, "繼續").await;
            Ok((first, second))
        },
    )
    .await;

    assert_eq!(first.described(), ["message 開始處理……"]);
    let error = first.error();
    assert_eq!(i32::from(error.code), -32603);
    assert!(error.message.contains("Rate limit"), "{}", error.message);
    assert_eq!(
        error.data,
        Some(serde_json::json!({ "type": "rate_limit", "retry_after_ms": 1500 }))
    );

    assert_eq!(second.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        second.described(),
        [
            "message 額度恢復了，繼續工作。",
            "tool_call write-resumed edit pending",
            "tool_call_update write-resumed in_progress",
            "tool_call_update write-resumed completed",
        ]
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("resumed.txt")).unwrap(),
        "resumed\n"
    );
}

async fn run_mcp(command: PathBuf, extra_env: Vec<EnvVariable>) -> Prompted {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let mut env = vec![EnvVariable::new("FAKE_MCP_GREETING", "你好 MCP")];
    env.extend(extra_env);
    let servers = vec![fake_mcp(command, env)];
    with_agent(
        "mcp.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, servers).await?;
            Ok(conn.prompt(&session, "請呼叫 MCP").await)
        },
    )
    .await
}

fn assert_mcp_called(prompted: &Prompted) {
    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        prompted.described(),
        [
            "message 我來呼叫 MCP 工具。",
            "tool_call mcp-echo other pending",
            "tool_call_update mcp-echo in_progress",
            "tool_call_update mcp-echo completed",
            "tool_call mcp-env other pending",
            "tool_call_update mcp-env in_progress",
            "tool_call_update mcp-env completed",
        ]
    );
    let echo = prompted.final_update("mcp-echo");
    assert_eq!(texts(echo), ["hello mcp"]);
    let raw_output = echo
        .fields
        .raw_output
        .as_ref()
        .expect("應該附上 MCP 原始結果");
    assert_eq!(raw_output["content"][0]["text"], "hello mcp");
    assert_eq!(texts(prompted.final_update("mcp-env")), ["你好 MCP"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_劇本_啟動注入的_server_並回報結果() {
    let prompted = run_mcp(env!("CARGO_BIN_EXE_orbis-fake-mcp-server").into(), vec![]).await;
    assert_mcp_called(&prompted);
    let SessionUpdate::ToolCall(call) = &prompted.updates[1] else {
        panic!("應該是 tool_call");
    };
    assert_eq!(
        call.raw_input,
        Some(serde_json::json!({
            "server": FAKE_MCP_NAME,
            "tool": "echo",
            "arguments": { "text": "hello mcp" },
        }))
    );
}

/// 把 MCP server 執行檔放到含空白的目錄。
///
/// Unix 上用 symlink 而不是複製：剛寫完的執行檔，如果同一個測試程序中其他執行緒正好 fork
/// （fork 到 exec 之間子程序還持有寫入用的 fd），執行時會失敗（`ETXTBSY`，Text file busy）。
/// 路徑一樣含空白，測的仍是同一件事。
fn copy_mcp_server_to_spaced_dir(dir: &Path) -> PathBuf {
    let source = Path::new(env!("CARGO_BIN_EXE_orbis-fake-mcp-server"));
    let spaced = dir.join("MCP Server Dir");
    std::fs::create_dir_all(&spaced).unwrap();
    let target = spaced.join(format!("fake mcp server{}", std::env::consts::EXE_SUFFIX));
    #[cfg(unix)]
    std::os::unix::fs::symlink(source, &target).unwrap();
    #[cfg(not(unix))]
    std::fs::copy(source, &target).unwrap();
    target
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_server_路徑含空白也能啟動() {
    let bin_dir = workdir();
    let command = copy_mcp_server_to_spaced_dir(bin_dir.path());
    let prompted = run_mcp(command, vec![]).await;
    assert_mcp_called(&prompted);
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn mcp_server_是含空白路徑的_cmd_shim_也能啟動() {
    let bin_dir = workdir();
    let exe = copy_mcp_server_to_spaced_dir(bin_dir.path());
    let shim = exe.with_file_name("fake mcp shim.cmd");
    std::fs::write(&shim, format!("@echo off\r\n\"{}\" %*\r\n", exe.display())).unwrap();
    let prompted = run_mcp(shim, vec![]).await;
    assert_mcp_called(&prompted);
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn mcp_server_只給名稱時依注入的_path_找到_cmd_shim() {
    let bin_dir = workdir();
    let exe = copy_mcp_server_to_spaced_dir(bin_dir.path());
    let shim = exe.with_file_name("fake-mcp-shim.cmd");
    std::fs::write(&shim, format!("@echo off\r\n\"{}\" %*\r\n", exe.display())).unwrap();
    let mut path_dirs = vec![shim.parent().unwrap().to_owned()];
    path_dirs.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let path = std::env::join_paths(path_dirs).unwrap();
    let prompted = run_mcp(
        PathBuf::from("fake-mcp-shim"),
        vec![EnvVariable::new("PATH", path.to_string_lossy())],
    )
    .await;
    assert_mcp_called(&prompted);
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_劇本_沒有注入_server_時_tool_call_失敗但回合照常結束() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let prompted = with_agent(
        "mcp.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            Ok(conn.prompt(&session, "請呼叫 MCP").await)
        },
    )
    .await;
    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    let failed = prompted.final_update("mcp-echo");
    assert_eq!(failed.fields.status, Some(ToolCallStatus::Failed));
    assert!(texts(failed)[0].contains(FAKE_MCP_NAME));
}

#[tokio::test(flavor = "multi_thread")]
async fn 兩個回合劇本_第二個_prompt_再修改並完成() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let feature = dir.path().join("feature.txt");
    let check = feature.clone();
    let (first, after_first, second) = with_agent(
        "two-turns.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let first = conn.prompt(&session, "請實作").await;
            let after_first = std::fs::read_to_string(&check).unwrap();
            let second = conn.prompt(&session, "Review 意見：請改成第二版").await;
            Ok((first, after_first, second))
        },
    )
    .await;

    assert_eq!(first.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        first.described(),
        [
            "message 第一版完成。",
            "tool_call write-v1 edit pending",
            "tool_call_update write-v1 in_progress",
            "tool_call_update write-v1 completed",
        ]
    );
    assert_eq!(after_first, "version 1\n");

    assert_eq!(second.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        second.described(),
        [
            "message 收到意見，修改中。",
            "tool_call edit-v2 edit pending",
            "tool_call_update edit-v2 in_progress",
            "tool_call_update edit-v2 completed",
            "message 第二版完成。",
        ]
    );
    assert_eq!(std::fs::read_to_string(&feature).unwrap(), "version 2\n");
    let [diff] = diffs(second.final_update("edit-v2")).try_into().unwrap();
    assert_eq!(diff.old_text.as_deref(), Some("version 1"));
    assert_eq!(diff.new_text, "version 2");
}

#[tokio::test(flavor = "multi_thread")]
async fn m1_劇本_允許寫檔後完成_依退回的_prompt_改成第二版() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let file = dir.path().join("m1.txt");
    let check = file.clone();
    let (first, after_first, second) = with_agent(
        "m1.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let first = conn.prompt(&session, "請新增 m1.txt").await;
            let after_first = std::fs::read_to_string(&check).unwrap();
            let second = conn.prompt(&session, "m1.txt 第 1 行：請改成第二版").await;
            Ok((first, after_first, second))
        },
    )
    .await;

    assert_eq!(first.stop_reason(), StopReason::EndTurn);
    let [request] = first.permissions.as_slice() else {
        panic!("第一回合應該剛好有一次權限請求");
    };
    assert_eq!(request.tool_call.tool_call_id.0.as_ref(), "write-m1");
    assert_eq!(after_first, "version 1\n");

    assert_eq!(second.stop_reason(), StopReason::EndTurn);
    assert!(second.permissions.is_empty());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "version 2\n");
}

/// plan-verify：Planning 回合只送出 plan；核准後寫入 fail；重試時改成 pass（C2 的完成條件 e2e 用）。
#[tokio::test(flavor = "multi_thread")]
async fn plan_verify_劇本_plan_後寫入_fail_重試時改成_pass() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let file = dir.path().join("verify.txt");
    let check = file.clone();
    let (plan_exists, after_approve) = with_agent(
        "plan-verify.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let plan = conn.prompt(&session, "請新增 verify.txt").await;
            assert_eq!(plan.stop_reason(), StopReason::EndTurn);
            let plan_exists = check.exists();
            let approved = conn
                .prompt(&session, "Plan 已核准，請依照核准的計畫開始實作。")
                .await;
            assert_eq!(approved.stop_reason(), StopReason::EndTurn);
            let after_approve = std::fs::read_to_string(&check).unwrap();
            let retry = conn.prompt(&session, "Verification 失敗").await;
            assert_eq!(retry.stop_reason(), StopReason::EndTurn);
            Ok((plan_exists, after_approve))
        },
    )
    .await;
    assert!(!plan_exists, "Planning 回合不寫檔");
    assert_eq!(after_approve, "fail\n");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "pass\n");
}

/// verify-fail：兩輪都寫 fail；附意見（含「請改成 pass」）再試時才改成 pass（91 I1 的 Verification 上限 e2e 用）。
#[tokio::test(flavor = "multi_thread")]
async fn verify_fail_劇本_兩輪都_fail_附意見後改成_pass() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let file = dir.path().join("verify.txt");
    let check = file.clone();
    let (after_first, after_retry) = with_agent(
        "verify-fail.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let first = conn.prompt(&session, "請新增 verify.txt").await;
            assert_eq!(first.stop_reason(), StopReason::EndTurn);
            let after_first = std::fs::read_to_string(&check).unwrap();
            let retry = conn.prompt(&session, "Verification 失敗").await;
            assert_eq!(retry.stop_reason(), StopReason::EndTurn);
            let after_retry = std::fs::read_to_string(&check).unwrap();
            let advised = conn
                .prompt(
                    &session,
                    "人的意見：請改成 pass。Verification 失敗的原因：exit code 1",
                )
                .await;
            assert_eq!(advised.stop_reason(), StopReason::EndTurn);
            Ok((after_first, after_retry))
        },
    )
    .await;
    assert_eq!(after_first, "fail\n");
    assert_eq!(after_retry, "fail again\n");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "pass\n");
}

/// feedback：原 Run 寫 v1；review 留言的 prompt 改成 v2；CI 失敗的 prompt（含 check 名稱）改成 v3。
#[tokio::test(flavor = "multi_thread")]
async fn feedback_劇本_原_run_寫_v1_review_改_v2_ci_改_v3() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let file = dir.path().join("fl.txt");
    let check = file.clone();
    let (after_first, after_review) = with_agent(
        "feedback.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let first = conn.prompt(&session, "請新增 fl.txt").await;
            assert_eq!(first.stop_reason(), StopReason::EndTurn);
            let after_first = std::fs::read_to_string(&check).unwrap();
            let review = conn
                .prompt(&session, "PR 上的 review 留言：請把 v1 改成 v2")
                .await;
            assert_eq!(review.stop_reason(), StopReason::EndTurn);
            let after_review = std::fs::read_to_string(&check).unwrap();
            let ci = conn
                .prompt(&session, "CI 失敗：### `e2e-ci-test`（failure）")
                .await;
            assert_eq!(ci.stop_reason(), StopReason::EndTurn);
            Ok((after_first, after_review))
        },
    )
    .await;
    assert_eq!(after_first, "v1\n");
    assert_eq!(after_review, "v2\n");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "v3\n");
}

/// deleg-parent：呼叫 Orbis MCP 的 delegate 兩次與 list_runs，再寫 parent.txt。
/// 這裡沒有注入 `orbis` server，三個 mcp_call 以 failed 結束，回合照常寫檔並結束。
#[tokio::test(flavor = "multi_thread")]
async fn deleg_parent_劇本_delegate_兩次後寫入_parent_txt() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let prompted = with_agent(
        "deleg-parent.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            Ok(conn.prompt(&session, "請分派給 fake-child").await)
        },
    )
    .await;
    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    for id in ["delegate-consult", "delegate-branch", "list-runs"] {
        assert_eq!(
            prompted.final_update(id).fields.status,
            Some(ToolCallStatus::Failed),
            "{id} 沒有 orbis server 時應該失敗"
        );
    }
    assert_eq!(
        prompted.final_update("write-parent").fields.status,
        Some(ToolCallStatus::Completed)
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("parent.txt")).unwrap(),
        "parent\n"
    );
    assert!(prompted.permissions.is_empty());
}

/// deleg-child：只回一句話就結束，不改檔（consult 模式在父 Run 的 Worktree 中執行）。
#[tokio::test(flavor = "multi_thread")]
async fn deleg_child_劇本_只回覆不改檔() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let prompted = with_agent(
        "deleg-child.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            Ok(conn.prompt(&session, "請讀 README.md 並回覆重點").await)
        },
    )
    .await;
    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        prompted.described(),
        ["message 我是 Child Run，已看完，重點是 README 只有標題。"]
    );
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        0,
        "不應該寫任何檔案"
    );
}

/// preview-comment：第一回合改 index.html 的標題；第二回合把收到的 prompt（文字與圖片）原樣回報。
#[tokio::test(flavor = "multi_thread")]
async fn preview_comment_劇本_改標題後回報含圖片的_prompt() {
    let dir = workdir();
    let index = dir.path().join("index.html");
    std::fs::write(&index, "<h1 id=\"app\">preview</h1>\n").unwrap();
    let cwd = dir.path().to_owned();
    let (first, second) = with_agent(
        "preview-comment.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let first = conn.prompt(&session, "請修改首頁標題").await;
            // Review 退回的 prompt：文字（網址與 selector）加上截圖
            let blocks = vec![
                ContentBlock::from(
                    "在 Preview 上的留言：\n- http://run.preview.localhost/（#app）（截圖 1）：標題要更大"
                        .to_owned(),
                ),
                ContentBlock::Image(ImageContent::new(
                    "iVBORw0KGgo=".to_owned(),
                    "image/png".to_owned(),
                )),
            ];
            let result = conn
                .cx
                .send_request(PromptRequest::new(session.clone(), blocks))
                .block_task()
                .await
                .map(|response| response.stop_reason);
            let recorded = conn.take_recorded();
            let second = Prompted {
                result,
                updates: recorded.updates,
                permissions: recorded.permissions,
            };
            Ok((first, second))
        },
    )
    .await;
    assert_eq!(first.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        std::fs::read_to_string(&index).unwrap(),
        "<h1 id=\"app\">preview v2</h1>\n"
    );
    assert_eq!(second.stop_reason(), StopReason::EndTurn);
    let described = second.described();
    assert_eq!(
        described[0],
        "message 收到 Review 退回，以下是我收到的 prompt。"
    );
    let echoed = &described[1];
    assert!(echoed.contains("text:在 Preview 上的留言："), "{echoed}");
    assert!(
        echoed.contains("（#app）（截圖 1）：標題要更大"),
        "{echoed}"
    );
    assert!(echoed.contains("image:image/png:iVBORw0KGgo="), "{echoed}");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_送出_session_cancel_後回合以_cancelled_結束() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let (stop_reason, updates) = with_agent(
        "cancel.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let pending = conn
                .cx
                .send_request(Conn::prompt_request(&session, "做很久的事"));
            // 等到回合真的開始（收到第一個 update）再取消。
            while conn.recorded.lock().unwrap().updates.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            conn.cx
                .send_notification(CancelNotification::new(session.clone()))?;
            let response = pending.block_task().await?;
            Ok((response.stop_reason, conn.take_recorded().updates))
        },
    )
    .await;
    assert_eq!(stop_reason, StopReason::Cancelled);
    let described: Vec<_> = updates.iter().map(describe).collect();
    assert_eq!(described, ["message 開始一個很長的工作……"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn spawn_child_回報子程序的_pid_而且子程序持續執行() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let pid = with_agent(
        "spawn-child.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let pending = conn
                .cx
                .send_request(Conn::prompt_request(&session, "開一個背景程序"));
            while conn.recorded.lock().unwrap().updates.len() < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let first = describe(&conn.recorded.lock().unwrap().updates[0]);
            let pid: u32 = first
                .strip_prefix("message child pid: ")
                .unwrap_or_else(|| panic!("第一個 update 應該回報 PID：{first}"))
                .parse()
                .unwrap();
            // Agent 還在執行時，子程序也在執行（Agent 結束後由誰清掉子程序是 Runner 的責任；
            // 這個測試的 ACP client 在 Unix 上會連同 process group 一起結束）。
            assert!(process_alive(pid), "子程序 {pid} 應該在執行");
            conn.cx
                .send_notification(CancelNotification::new(session.clone()))?;
            let response = pending.block_task().await?;
            assert_eq!(response.stop_reason, StopReason::Cancelled);
            Ok(pid)
        },
    )
    .await;
    kill_process(pid);
}

fn process_alive(pid: u32) -> bool {
    let output = if cfg!(windows) {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap()
    } else {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
    };
    if cfg!(windows) {
        String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
    } else {
        output.status.success()
    }
}

fn kill_process(pid: u32) {
    let _ = if cfg!(windows) {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
    } else {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
    };
}

/// 把測試專用的劇本寫到暫存目錄，回傳絕對路徑（`Path::join` 遇到絕對路徑會直接取代）。
fn write_script(dir: &Path, yaml: &str) -> String {
    let path = dir.join("custom.yaml");
    std::fs::write(&path, yaml).unwrap();
    path.to_string_lossy().into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn 指定失敗或路徑跑出_cwd_的_tool_call_不會寫檔() {
    let scripts = workdir();
    let script = write_script(
        scripts.path(),
        r#"
turns:
  - steps:
      - tool_call:
          id: declared-failed
          title: 寫入失敗
          edit: { path: failed.txt, content: x }
          output: disk full
          status: failed
      - tool_call:
          id: escape
          title: 寫到 cwd 外面
          edit: { path: ../escaped.txt, content: x }
      - tool_call:
          id: missing
          title: 取代不存在的文字
          edit: { path: missing.txt, old_text: a, new_text: b }
"#,
    );
    let dir = workdir();
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let session_cwd = cwd.clone();
    let prompted = with_agent(&script, PermissionReply::Allow, async move |conn: Conn| {
        let session = conn.new_session(&session_cwd, vec![]).await?;
        Ok(conn.prompt(&session, "試試看").await)
    })
    .await;

    assert_eq!(prompted.stop_reason(), StopReason::EndTurn);
    for id in ["declared-failed", "escape", "missing"] {
        let update = prompted.final_update(id);
        assert_eq!(update.fields.status, Some(ToolCallStatus::Failed), "{id}");
        assert!(diffs(update).is_empty(), "{id} 不應該回報 diff");
    }
    assert_eq!(
        texts(prompted.final_update("declared-failed")),
        ["disk full"]
    );
    assert!(!cwd.join("failed.txt").exists());
    assert!(!dir.path().join("escaped.txt").exists());
    assert!(!cwd.join("missing.txt").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn expect_prompt_contains_不符時回_invalid_params() {
    let scripts = workdir();
    let script = write_script(
        scripts.path(),
        "turns:\n  - expect_prompt_contains: 第二版\n    steps:\n      - message: 好\n  - expect_prompt_contains: 第二版\n    steps:\n      - message: 好\n",
    );
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let (mismatch, matched) =
        with_agent(&script, PermissionReply::Allow, async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let mismatch = conn.prompt(&session, "請做第一版").await;
            let matched = conn.prompt(&session, "請改成第二版").await;
            Ok((mismatch, matched))
        })
        .await;
    assert_eq!(i32::from(mismatch.error().code), -32602);
    assert!(mismatch.updates.is_empty());
    assert_eq!(matched.stop_reason(), StopReason::EndTurn);
    assert_eq!(matched.described(), ["message 好"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn 同一個_session_同時兩個_prompt_時第二個被拒絕() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let (overlap, first) = with_agent(
        "cancel.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            let pending = conn
                .cx
                .send_request(Conn::prompt_request(&session, "第一個"));
            while conn.recorded.lock().unwrap().updates.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let overlap = conn.prompt(&session, "第二個").await;
            conn.cx
                .send_notification(CancelNotification::new(session.clone()))?;
            let first = pending.block_task().await?;
            Ok((overlap, first.stop_reason))
        },
    )
    .await;
    assert_eq!(i32::from(overlap.error().code), -32600);
    assert_eq!(first, StopReason::Cancelled);
}

/// config option 的 id 與目前的值（只看 select 類型）。
fn config_values(options: &[SessionConfigOption]) -> Vec<(String, String)> {
    options
        .iter()
        .filter_map(|option| match &option.kind {
            SessionConfigKind::Select(select) => {
                Some((option.id.0.to_string(), select.current_value.0.to_string()))
            }
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn config_options_劇本_回報選項_切換後下一個回合看到新的值() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let (created, first, switched, rejected, second) = with_agent(
        "config-options.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            conn.initialize().await?;
            let response = conn
                .cx
                .send_request(NewSessionRequest::new(&cwd))
                .block_task()
                .await?;
            let session = response.session_id.clone();
            let created = response.config_options.unwrap_or_default();
            let first = conn.prompt(&session, "目前的設定").await;
            let switched = conn
                .cx
                .send_request(SetSessionConfigOptionRequest::new(
                    session.clone(),
                    "model",
                    "opus",
                ))
                .block_task()
                .await?
                .config_options;
            let rejected = conn
                .cx
                .send_request(SetSessionConfigOptionRequest::new(
                    session.clone(),
                    "thought",
                    "max",
                ))
                .block_task()
                .await;
            let second = conn.prompt(&session, "目前的設定").await;
            Ok((created, first, switched, rejected, second))
        },
    )
    .await;
    assert_eq!(
        config_values(&created),
        [
            ("model".to_owned(), "sonnet".to_owned()),
            ("thought".to_owned(), "medium".to_owned())
        ]
    );
    assert_eq!(
        created[0].category,
        Some(SessionConfigOptionCategory::Model)
    );
    assert_eq!(
        created[1].category,
        Some(SessionConfigOptionCategory::ThoughtLevel)
    );
    assert_eq!(
        first.described(),
        ["message config: model=sonnet, thought=medium"]
    );
    assert_eq!(
        config_values(&switched),
        [
            ("model".to_owned(), "opus".to_owned()),
            ("thought".to_owned(), "medium".to_owned())
        ]
    );
    let error = rejected.expect_err("不認得的值要回錯誤");
    assert_eq!(i32::from(error.code), -32602);
    assert_eq!(
        second.described(),
        ["message config: model=opus, thought=medium"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn 沒有宣告_config_options_時_echo_config_回報_none_也不接受切換() {
    let scripts = workdir();
    let script = write_script(scripts.path(), "turns:\n  - steps:\n      - echo_config\n");
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let (options, rejected, prompted) =
        with_agent(&script, PermissionReply::Allow, async move |conn: Conn| {
            conn.initialize().await?;
            let response = conn
                .cx
                .send_request(NewSessionRequest::new(&cwd))
                .block_task()
                .await?;
            let session = response.session_id.clone();
            let rejected = conn
                .cx
                .send_request(SetSessionConfigOptionRequest::new(
                    session.clone(),
                    "model",
                    "opus",
                ))
                .block_task()
                .await;
            let prompted = conn.prompt(&session, "目前的設定").await;
            Ok((response.config_options, rejected, prompted))
        })
        .await;
    assert!(options.is_none());
    assert_eq!(i32::from(rejected.expect_err("沒有這個選項").code), -32602);
    assert_eq!(prompted.described(), ["message config: none"]);
}

#[test]
fn config_options_的_current_必須是_values_之一() {
    let yaml = "config_options:\n  - id: model\n    current: x\n    values: [{ id: a }]\nturns:\n  - steps: [{ message: 好 }]\n";
    assert!(orbis_fake_agent::Script::from_yaml(yaml).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn long_turn_劇本_長回合可以中斷_第二個回合等到檔案出現才結束() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let release = cwd.join("release.txt");
    let (interrupted, waited, third) = with_agent(
        "long-turn.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let session = conn.new_session(&cwd, vec![]).await?;
            // 第一個回合：收到兩個進度後中斷。
            let pending = conn
                .cx
                .send_request(Conn::prompt_request(&session, "做很久的事"));
            while conn.recorded.lock().unwrap().updates.len() < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            conn.cx
                .send_notification(CancelNotification::new(session.clone()))?;
            let stop = pending.block_task().await?.stop_reason;
            let interrupted = (stop, conn.take_recorded().updates);
            // 第二個回合：建立檔案之前不會結束。
            let pending = conn
                .cx
                .send_request(Conn::prompt_request(&session, "中斷後送出的訊息"));
            tokio::time::sleep(Duration::from_millis(200)).await;
            let before = conn.recorded.lock().unwrap().updates.len();
            std::fs::write(&release, "ok").unwrap();
            let stop = pending.block_task().await?.stop_reason;
            let waited = (before, stop, conn.take_recorded().updates);
            let third = conn.prompt(&session, "第一則\n\n第二則").await;
            Ok((interrupted, waited, third))
        },
    )
    .await;
    let (stop, updates) = interrupted;
    assert_eq!(stop, StopReason::Cancelled);
    let described: Vec<_> = updates.iter().map(describe).collect();
    assert!(
        described.len() >= 2 && described.len() < 50,
        "{described:?}"
    );
    assert_eq!(described[0], "message 處理中 1/50");
    assert!(!described.contains(&"message 第一個回合完成".to_owned()));
    let (before, stop, updates) = waited;
    assert_eq!(before, 1, "檔案出現之前只會送出 echo_prompt");
    assert_eq!(stop, StopReason::EndTurn);
    let described: Vec<_> = updates.iter().map(describe).collect();
    assert_eq!(
        described,
        ["message text:中斷後送出的訊息", "message 第二個回合完成"]
    );
    assert_eq!(third.described(), ["message text:第一則\n\n第二則"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn wait_for_file_可以被_cancel_中斷() {
    let scripts = workdir();
    let script = write_script(
        scripts.path(),
        "turns:\n  - steps:\n      - message: 等待\n      - wait_for_file: never.txt\n",
    );
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let stop = with_agent(&script, PermissionReply::Allow, async move |conn: Conn| {
        let session = conn.new_session(&cwd, vec![]).await?;
        let pending = conn.cx.send_request(Conn::prompt_request(&session, "等"));
        while conn.recorded.lock().unwrap().updates.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        conn.cx
            .send_notification(CancelNotification::new(session.clone()))?;
        Ok(pending.block_task().await?.stop_reason)
    })
    .await;
    assert_eq!(stop, StopReason::Cancelled);
}

#[tokio::test(flavor = "multi_thread")]
async fn login_劇本_登入前_session_new_回_auth_required_登入要等一段時間() {
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let (methods, before, elapsed, after) = with_agent(
        "login.yaml",
        PermissionReply::Allow,
        async move |conn: Conn| {
            let init = conn
                .cx
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let methods: Vec<String> = init
                .auth_methods
                .iter()
                .map(|method| method.id().0.to_string())
                .collect();
            let before = conn
                .cx
                .send_request(NewSessionRequest::new(&cwd))
                .block_task()
                .await;
            let started = std::time::Instant::now();
            conn.cx
                .send_request(AuthenticateRequest::new("oauth-personal"))
                .block_task()
                .await?;
            let elapsed = started.elapsed();
            let session = conn
                .cx
                .send_request(NewSessionRequest::new(&cwd))
                .block_task()
                .await?
                .session_id;
            let after = conn.prompt(&session, "你好").await;
            Ok((methods, before, elapsed, after))
        },
    )
    .await;
    assert_eq!(methods, ["oauth-personal"]);
    assert_eq!(
        before.expect_err("登入前要回 auth_required").code,
        acp::Error::auth_required().code
    );
    assert!(elapsed >= Duration::from_millis(300), "{elapsed:?}");
    assert_eq!(after.described(), ["message 已登入"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_error_時_authenticate_失敗而且仍然要登入() {
    let scripts = workdir();
    let script = write_script(
        scripts.path(),
        "auth:\n  methods: [oauth-personal]\n  error: 使用者取消了登入\nturns:\n  - steps: [{ message: 好 }]\n",
    );
    let dir = workdir();
    let cwd = dir.path().to_owned();
    let (login, session) = with_agent(&script, PermissionReply::Allow, async move |conn: Conn| {
        conn.initialize().await?;
        let login = conn
            .cx
            .send_request(AuthenticateRequest::new("oauth-personal"))
            .block_task()
            .await;
        let session = conn
            .cx
            .send_request(NewSessionRequest::new(&cwd))
            .block_task()
            .await;
        Ok((login, session))
    })
    .await;
    assert_eq!(login.expect_err("登入要失敗").message, "使用者取消了登入");
    assert_eq!(
        session.expect_err("沒有登入成功").code,
        acp::Error::auth_required().code
    );
}
