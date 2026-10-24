//! Runner 端的 Orbis MCP hub：在 `127.0.0.1` 的隨機 port 接收 bridge 的工具呼叫，依 token 認出
//! 呼叫的 Run，轉成 `tool_call` frame 送給 Server，收到 `tool_result` 再回給 bridge。
//!
//! - `wait_run`、`ask_parent` 在 Server 端阻塞，這裡沒有逾時。
//! - 斷線重連後，以同一個 `call_id` 重送還沒有結果的呼叫（Server 依 `call_id` 去除重複）。
//! - `merge_child`：Server 回覆子分支後，在呼叫者的 Worktree 執行 merge，結果以 `child_merged` Event 回報。
//! - `report_verdict` 只在本機處理：判定 Verification 條件的 Child Run 回報結果，只接受指派給它的條件。
//! - Verification 的判定：父 Run 先登記要判定的條件（[`JudgeAssignment`]），再請 Server 建立
//!   Child Run；Child Run 啟動時依父 Run 取得指派（同一個父 Run 一次只有一組判定在進行）。
//! - 深度與 Child Run 數量先在本機擋一次（Server 仍會檢查，以 Server 為準）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use orbis_protocol::enums::DelegationMode;
use orbis_protocol::event::{EventKind, MergeOutcome};
use orbis_protocol::frame::RunnerToServer;
use orbis_protocol::ids::{DispatchId, RunId};
use orbis_protocol::tool::{
    OrbisToolCall, OrbisToolErrorCode, OrbisToolOutput, OrbisToolResult, ToolCallFrame,
    ToolResultFrame,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use super::{BridgeRequest, BridgeResponse, REPORT_VERDICT};
use crate::connection::now;
use crate::git::Git;
use crate::outbox::Outbox;
use crate::worktree::Worktree;

/// Delegation 的深度上限（ARCHITECTURE §9）。
pub const MAX_DEPTH: u32 = 2;
/// 每個 Run 同時進行中的 Child Run 上限（ARCHITECTURE §9）。
pub const MAX_CHILDREN: usize = 5;

/// 一個註冊在 hub 的 Run（它的 Agent 可以呼叫 Orbis 工具）。
#[derive(Debug, Clone)]
pub struct Caller {
    pub run_id: RunId,
    pub dispatch_id: DispatchId,
    pub worktree: Worktree,
    /// 這個 Run 的深度：一般 Run 為 0，Child Run 為父 Run 的深度加 1。
    pub depth: u32,
    pub parent: Option<RunId>,
    pub mode: Option<DelegationMode>,
    /// 判定 Verification 條件的 Child Run 被指派的條件（`criterion_id`），可以對這些條件呼叫
    /// `report_verdict`；不是判定用的 Run 時為 `None`。
    pub judge: Option<Vec<String>>,
}

/// 父 Run 交給判定用 Child Run 的工作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgeAssignment {
    /// 要判定的條件（`criterion_id`）。
    pub criteria: Vec<String>,
    /// `browser` 類型：要注入的 Playwright MCP 可以連的 Preview 網址與截圖目錄。
    pub browser: Option<BrowserJudge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserJudge {
    pub url: String,
    pub output_dir: std::path::PathBuf,
}

/// `report_verdict` 回報的判定。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    pub criterion_id: String,
    /// `passed` 或 `failed`。
    pub outcome: String,
    pub summary: String,
}

struct PendingCall {
    frame: ToolCallFrame,
    reply: oneshot::Sender<OrbisToolResult>,
}

pub struct McpHub {
    endpoint: String,
    callers: Mutex<HashMap<String, Caller>>,
    pending: Mutex<HashMap<String, PendingCall>>,
    verdicts: Mutex<HashMap<RunId, Vec<Verdict>>>,
    /// 父 Run → 正在進行的判定。
    assignments: Mutex<HashMap<RunId, JudgeAssignment>>,
    frames: mpsc::UnboundedSender<RunnerToServer>,
    outbox: Arc<Outbox>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn error(code: OrbisToolErrorCode, message: impl Into<String>) -> BridgeResponse {
    BridgeResponse::Error {
        code: code.as_str().to_owned(),
        message: message.into(),
    }
}

impl McpHub {
    /// 在 `127.0.0.1` 的隨機 port 開始接收 bridge 的連線（要在 tokio runtime 中呼叫）。
    pub fn start(
        frames: mpsc::UnboundedSender<RunnerToServer>,
        outbox: Arc<Outbox>,
    ) -> anyhow::Result<Arc<Self>> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let hub = Arc::new(Self {
            endpoint: listener.local_addr()?.to_string(),
            callers: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            verdicts: Mutex::new(HashMap::new()),
            assignments: Mutex::new(HashMap::new()),
            frames,
            outbox,
        });
        let accepting = Arc::downgrade(&hub);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let Some(hub) = accepting.upgrade() else {
                    break;
                };
                tokio::spawn(async move { hub.serve(stream).await });
            }
        });
        Ok(hub)
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// 登記一個 Run，回傳 bridge 要帶的 token。
    pub fn register(&self, caller: Caller) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        lock(&self.callers).insert(token.clone(), caller);
        token
    }

    /// Run 結束：取消登記，還在等結果的呼叫一律失敗。
    pub fn unregister(&self, token: &str) {
        let Some(caller) = lock(&self.callers).remove(token) else {
            return;
        };
        lock(&self.pending).retain(|_, p| p.frame.run_id != caller.run_id);
        lock(&self.assignments).remove(&caller.run_id);
    }

    /// 已登記的 Run（Child Run 用來找父 Run 的 Worktree）。
    pub fn caller(&self, run_id: &RunId) -> Option<Caller> {
        lock(&self.callers)
            .values()
            .find(|c| &c.run_id == run_id)
            .cloned()
    }

    /// 父 Run 登記接下來要建立的判定用 Child Run 的工作（取代之前的）。
    pub fn assign_judge(&self, parent: &RunId, assignment: JudgeAssignment) {
        lock(&self.assignments).insert(parent.clone(), assignment);
    }

    /// 判定用的 Child Run 啟動時取得父 Run 登記的工作。
    pub fn judge_assignment(&self, parent: &RunId) -> Option<JudgeAssignment> {
        lock(&self.assignments).get(parent).cloned()
    }

    /// 判定結束（或父 Run 結束）：取消登記。
    pub fn clear_judge(&self, parent: &RunId) {
        lock(&self.assignments).remove(parent);
    }

    /// 取出某個 Child Run 回報的判定。
    pub fn take_verdicts(&self, run_id: &RunId) -> Vec<Verdict> {
        lock(&self.verdicts).remove(run_id).unwrap_or_default()
    }

    /// Server 回覆的 `tool_result`。
    pub fn resolve(&self, result: ToolResultFrame) {
        match lock(&self.pending).remove(result.call_id.as_str()) {
            Some(pending) => {
                let _ = pending.reply.send(result.result);
            }
            None => tracing::debug!(call_id = %result.call_id, "沒有在等這個 tool_result，略過"),
        }
    }

    /// 重新連上 Server：重送還沒有結果的呼叫（同一個 `call_id`）。
    pub fn resend_pending(&self) {
        for pending in lock(&self.pending).values() {
            let _ = self
                .frames
                .send(RunnerToServer::ToolCall(pending.frame.clone()));
        }
    }

    async fn serve(self: Arc<Self>, stream: tokio::net::TcpStream) {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        if reader.read_line(&mut line).await.is_err() {
            return;
        }
        let response = match serde_json::from_str::<BridgeRequest>(&line) {
            Ok(request) => self.handle(request).await,
            Err(e) => error(OrbisToolErrorCode::Internal, format!("無法解析：{e}")),
        };
        let mut out = serde_json::to_vec(&response).unwrap_or_default();
        out.push(b'\n');
        let _ = reader.into_inner().write_all(&out).await;
    }

    async fn handle(&self, request: BridgeRequest) -> BridgeResponse {
        let Some(caller) = lock(&self.callers).get(&request.token).cloned() else {
            return error(OrbisToolErrorCode::Internal, "這個 Run 已經結束");
        };
        if request.tool == REPORT_VERDICT {
            return self.report_verdict(&caller, request.arguments);
        }
        if request.tool == "delegate" {
            if caller.depth >= MAX_DEPTH {
                return error(
                    OrbisToolErrorCode::DepthExceeded,
                    format!("Delegation 最多 {MAX_DEPTH} 層"),
                );
            }
            let children = lock(&self.callers)
                .values()
                .filter(|c| c.parent.as_ref() == Some(&caller.run_id))
                .count();
            if children >= MAX_CHILDREN {
                return error(
                    OrbisToolErrorCode::ChildLimitExceeded,
                    format!("同時最多 {MAX_CHILDREN} 個 Child Run"),
                );
            }
        }
        let call = match to_call(&request.tool, request.arguments) {
            Ok(call) => call,
            Err(e) => return error(OrbisToolErrorCode::InvalidState, e),
        };
        let merging = match &call {
            OrbisToolCall::MergeChild { run_id } => Some(run_id.clone()),
            _ => None,
        };
        match self.forward(&caller, call).await {
            Ok(OrbisToolResult::Ok { output }) => match (*output, merging) {
                (
                    OrbisToolOutput::MergeChild {
                        branch,
                        head_commit,
                    },
                    Some(child),
                ) => self.merge(&caller, child, branch, head_commit).await,
                (output, _) => BridgeResponse::Ok {
                    output: serde_json::to_value(output).unwrap_or_default(),
                },
            },
            Ok(OrbisToolResult::Error { code, message }) => error(code, message),
            Err(message) => error(OrbisToolErrorCode::Internal, message),
        }
    }

    /// 把呼叫轉給 Server，等 `tool_result`。
    pub async fn forward(
        &self,
        caller: &Caller,
        call: OrbisToolCall,
    ) -> Result<OrbisToolResult, String> {
        let frame = ToolCallFrame {
            call_id: uuid::Uuid::now_v7().to_string().into(),
            run_id: caller.run_id.clone(),
            dispatch_id: caller.dispatch_id.clone(),
            call,
        };
        let (reply, wait) = oneshot::channel();
        lock(&self.pending).insert(
            frame.call_id.to_string(),
            PendingCall {
                frame: frame.clone(),
                reply,
            },
        );
        let _ = self.frames.send(RunnerToServer::ToolCall(frame));
        wait.await.map_err(|_| "這個 Run 已經結束".to_owned())
    }

    fn report_verdict(&self, caller: &Caller, arguments: serde_json::Value) -> BridgeResponse {
        let Some(assigned) = &caller.judge else {
            return error(
                OrbisToolErrorCode::InvalidState,
                "只有判定 Verification 條件的 Child Run 可以回報判定",
            );
        };
        let verdict: Verdict = match serde_json::from_value(arguments) {
            Ok(v) => v,
            Err(e) => return error(OrbisToolErrorCode::InvalidState, format!("參數不正確：{e}")),
        };
        if !assigned.contains(&verdict.criterion_id) {
            return error(
                OrbisToolErrorCode::InvalidState,
                format!(
                    "沒有指派這條條件給你判定；要判定的是：{}",
                    assigned.join(", ")
                ),
            );
        }
        if !matches!(verdict.outcome.as_str(), "passed" | "failed") {
            return error(
                OrbisToolErrorCode::InvalidState,
                "outcome 只能是 passed 或 failed",
            );
        }
        let mut verdicts = lock(&self.verdicts);
        let list = verdicts.entry(caller.run_id.clone()).or_default();
        if list.iter().any(|v| v.criterion_id == verdict.criterion_id) {
            return error(OrbisToolErrorCode::InvalidState, "這條條件已經回報過判定");
        }
        list.push(verdict);
        BridgeResponse::Ok {
            output: serde_json::json!({ "recorded": true }),
        }
    }

    /// `merge_child`：在呼叫者的 Worktree merge 子分支。有衝突時保留衝突狀態交給 Agent。
    async fn merge(
        &self,
        caller: &Caller,
        child: RunId,
        branch: String,
        head_commit: Option<String>,
    ) -> BridgeResponse {
        let git = Git::new(&caller.worktree.path);
        let target = head_commit.unwrap_or_else(|| branch.clone());
        let message = format!("Merge {branch}");
        let merged = git
            .run(["merge", "--no-ff", "--no-edit", "-m", &message, &target])
            .await;
        let conflicted: Vec<String> = git
            .run(["diff", "--name-only", "--diff-filter=U"])
            .await
            .map(|out| out.lines().map(str::to_owned).collect())
            .unwrap_or_default();
        let (outcome, commit_sha) = match (&merged, conflicted.is_empty()) {
            (Ok(_), _) => (
                MergeOutcome::Merged,
                git.rev_parse_commit("HEAD").await.ok(),
            ),
            (Err(_), false) => (MergeOutcome::Conflict, None),
            (Err(e), true) => {
                return error(OrbisToolErrorCode::Internal, format!("merge 失敗：{e}"));
            }
        };
        if let Err(e) = self.outbox.emit(
            &caller.run_id,
            now(),
            EventKind::ChildMerged {
                child_run_id: child,
                outcome,
                commit_sha: commit_sha.clone(),
                conflicted_paths: conflicted.clone(),
            },
        ) {
            tracing::error!(error = %e, "無法記錄 child_merged");
        }
        BridgeResponse::Ok {
            output: match outcome {
                MergeOutcome::Merged => serde_json::json!({
                    "outcome": "merged",
                    "branch": branch,
                    "commit_sha": commit_sha,
                }),
                MergeOutcome::Conflict => serde_json::json!({
                    "outcome": "conflict",
                    "branch": branch,
                    "conflicted_paths": conflicted,
                    "next": "Resolve the conflicts in your worktree, then `git add` and `git commit`. If you cannot resolve them, stop and explain why.",
                }),
            },
        }
    }
}

/// bridge 的參數加上工具名稱與 Agent 不必填的欄位，轉成協定的 [`OrbisToolCall`]。
fn to_call(tool: &str, arguments: serde_json::Value) -> Result<OrbisToolCall, String> {
    let mut object = match arguments {
        serde_json::Value::Object(map) => map,
        serde_json::Value::Null => serde_json::Map::new(),
        other => return Err(format!("參數要是物件：{other}")),
    };
    object.insert("tool".into(), tool.into());
    if tool == "delegate" {
        // Agent 自己分派的工作；Verification 用的 Child Run 由 Runner 直接建立。
        object.insert("purpose".into(), "tool".into());
        object.insert("verification_id".into(), serde_json::Value::Null);
    }
    serde_json::from_value(serde_json::Value::Object(object))
        .map_err(|e| format!("參數不正確：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_的參數轉成協定的工具呼叫() {
        let call = to_call(
            "delegate",
            serde_json::json!({ "agent": "codex", "prompt": "看看", "mode": "consult" }),
        )
        .unwrap();
        let OrbisToolCall::Delegate {
            agent,
            mode,
            purpose,
            model,
            ..
        } = call
        else {
            panic!("{call:?}");
        };
        assert_eq!(agent, "codex");
        assert_eq!(mode, DelegationMode::Consult);
        assert_eq!(purpose, orbis_protocol::tool::DelegationPurpose::Tool);
        assert_eq!(model, None);
        assert!(matches!(
            to_call("list_runs", serde_json::json!({})).unwrap(),
            OrbisToolCall::ListRuns
        ));
        assert!(to_call("delegate", serde_json::json!({ "agent": "x" })).is_err());
    }
}
