//! `orbis-runner --mcp-bridge`：Agent 啟動的 stdio MCP server。每次工具呼叫開一條到 Runner 的
//! 本機 TCP 連線，送一行 [`BridgeRequest`]、讀一行 [`BridgeResponse`]，把結果交回 Agent。
//! 工具的說明寫給 Agent 看，所以用英文。

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock as Content, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, ServiceExt, schemars, tool, tool_handler, tool_router};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{BridgeRequest, BridgeResponse, REPORT_VERDICT, env_endpoint, env_judge, env_token};

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct DelegateArgs {
    /// Agent profile id, for example `claude-code`, `codex`, `gemini`, `grok`.
    pub agent: String,
    /// The task for the child run.
    pub prompt: String,
    /// `consult` (read-only in your worktree) or `branch` (a child worktree and branch you can merge with `merge_child`).
    pub mode: String,
    /// Model to use; omit for the agent's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `manual` or `auto`; can only be the same as or stricter than yours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_policy: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RunArgs {
    /// The child run id returned by `delegate`.
    pub run_id: String,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct WaitRunArgs {
    /// The child run id returned by `delegate`.
    pub run_id: String,
    /// Give up waiting after this many milliseconds; omit for the server's limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct EmptyArgs {}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct AskParentArgs {
    /// The question for the parent run. Blocks until it is answered.
    pub question: String,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct AnswerChildArgs {
    pub run_id: String,
    /// The `question_id` from the child's `pending_question`.
    pub question_id: String,
    pub answer: String,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProposedCriterionArg {
    /// `command`, `agent`, `browser` or `manual`.
    pub kind: String,
    pub description: String,
    /// Only for `command`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProposedTaskArg {
    pub title: String,
    pub description: String,
    pub acceptance_criteria: Vec<ProposedCriterionArg>,
    /// `#<n>` (1-based, in this batch) or existing task keys.
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProposeTasksArgs {
    /// Spec content or the path of a spec in the repo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<String>,
    pub tasks: Vec<ProposedTaskArg>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct UpdateTaskNoteArgs {
    /// Task key such as `ORB-12`; omit for your own task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    pub note: String,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ReportVerdictArgs {
    /// The criterion id from the prompt.
    pub criterion_id: String,
    /// `passed` or `failed`.
    pub outcome: String,
    /// Why, with evidence (file names, lines, what you saw).
    pub summary: String,
}

#[derive(Debug, Clone)]
pub struct OrbisBridge {
    endpoint: String,
    token: String,
    tool_router: ToolRouter<Self>,
}

#[tool_router(router = tool_router)]
impl OrbisBridge {
    fn new(endpoint: String, token: String, judge: bool) -> Self {
        let mut tool_router = Self::tool_router();
        if !judge {
            tool_router.remove_route(REPORT_VERDICT);
        }
        Self {
            endpoint,
            token,
            tool_router,
        }
    }

    #[tool(
        description = "Start a child run with another agent. `consult` runs read-only in your worktree; `branch` gets its own worktree and branch from your current HEAD (merge it with `merge_child`). Returns the child run id; use `wait_run` to get its result."
    )]
    async fn delegate(&self, Parameters(args): Parameters<DelegateArgs>) -> CallToolResult {
        self.forward("delegate", &args).await
    }

    #[tool(description = "Get the status of one of your child runs.")]
    async fn get_run(&self, Parameters(args): Parameters<RunArgs>) -> CallToolResult {
        self.forward("get_run", &args).await
    }

    #[tool(
        description = "Wait until a child run finishes, asks you a question (answer it with `answer_child`), or the timeout passes. Returns its status and final message."
    )]
    async fn wait_run(&self, Parameters(args): Parameters<WaitRunArgs>) -> CallToolResult {
        self.forward("wait_run", &args).await
    }

    #[tool(description = "List all of your child runs.")]
    async fn list_runs(&self, Parameters(args): Parameters<EmptyArgs>) -> CallToolResult {
        self.forward("list_runs", &args).await
    }

    #[tool(
        description = "Merge the branch of a finished `branch` child run into your branch. On conflicts the conflicted files stay in your worktree: resolve them and commit."
    )]
    async fn merge_child(&self, Parameters(args): Parameters<RunArgs>) -> CallToolResult {
        self.forward("merge_child", &args).await
    }

    #[tool(
        description = "Ask your parent run a question (only for child runs). Blocks until the parent or a human answers."
    )]
    async fn ask_parent(&self, Parameters(args): Parameters<AskParentArgs>) -> CallToolResult {
        self.forward("ask_parent", &args).await
    }

    #[tool(description = "Answer a question from one of your child runs.")]
    async fn answer_child(&self, Parameters(args): Parameters<AnswerChildArgs>) -> CallToolResult {
        self.forward("answer_child", &args).await
    }

    #[tool(
        description = "Propose draft tasks (with acceptance criteria and dependencies). A human reviews them before they enter the backlog."
    )]
    async fn propose_tasks(
        &self,
        Parameters(args): Parameters<ProposeTasksArgs>,
    ) -> CallToolResult {
        self.forward("propose_tasks", &args).await
    }

    #[tool(description = "Leave a progress or decision note on a task.")]
    async fn update_task_note(
        &self,
        Parameters(args): Parameters<UpdateTaskNoteArgs>,
    ) -> CallToolResult {
        self.forward("update_task_note", &args).await
    }

    #[tool(
        description = "Report your verdict for one acceptance criterion you were asked to judge. Call it once per criterion."
    )]
    async fn report_verdict(
        &self,
        Parameters(args): Parameters<ReportVerdictArgs>,
    ) -> CallToolResult {
        self.forward(REPORT_VERDICT, &args).await
    }
}

impl OrbisBridge {
    async fn forward(&self, tool: &str, args: &impl Serialize) -> CallToolResult {
        let request = BridgeRequest {
            token: self.token.clone(),
            tool: tool.to_owned(),
            arguments: serde_json::to_value(args).unwrap_or_default(),
        };
        match self.call(&request).await {
            Ok(BridgeResponse::Ok { output }) => CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&output).unwrap_or_default(),
            )]),
            Ok(BridgeResponse::Error { code, message }) => {
                CallToolResult::error(vec![Content::text(format!("{code}: {message}"))])
            }
            Err(e) => CallToolResult::error(vec![Content::text(format!(
                "internal: cannot reach the runner: {e:#}"
            ))]),
        }
    }

    async fn call(&self, request: &BridgeRequest) -> anyhow::Result<BridgeResponse> {
        let mut stream = tokio::net::TcpStream::connect(&self.endpoint).await?;
        let mut line = serde_json::to_vec(request)?;
        line.push(b'\n');
        stream.write_all(&line).await?;
        let mut reader = BufReader::new(stream);
        let mut response = String::new();
        reader.read_line(&mut response).await?;
        Ok(serde_json::from_str(&response)?)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for OrbisBridge {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }
}

/// 以 stdio 提供 Orbis MCP server，直到 stdin 關閉。位址與 token 從環境變數讀取。
pub async fn serve_stdio() -> anyhow::Result<()> {
    let endpoint = std::env::var(env_endpoint())?;
    let token = std::env::var(env_token())?;
    let judge = std::env::var_os(env_judge()).is_some();
    let service = OrbisBridge::new(endpoint, token, judge)
        .serve(rmcp::transport::stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}
