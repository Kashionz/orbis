//! 劇本格式（YAML）。
//!
//! 劇本是一串**回合**（[`Turn`]）。每收到一次 `session/prompt` 就消耗一個回合，
//! 依序執行回合裡的**步驟**（[`Step`]）。每個 session 各自從第一個回合開始；
//! 回合用完之後再收到 `session/prompt`，會回 JSON-RPC 錯誤。
//!
//! 回合的步驟跑完而沒有遇到結束類步驟時，以 stop reason `end_turn` 結束。
//!
//! # 範例
//!
//! ```yaml
//! description: 修改 README 並完成
//! turns:
//!   - steps:
//!       - thought: 先看看 README 的內容
//!       - message: 我來更新 README。
//!       - tool_call:
//!           title: 編輯 README.md
//!           edit:
//!             path: README.md
//!             content: |
//!               # Hello
//!       - usage: { used: 1200, size: 200000 }
//!       - stop: end_turn
//! ```
//!
//! # 步驟一覽
//!
//! 每個步驟是只有一個 key 的 map（`wait_for_cancel` 可以只寫名稱）：
//!
//! | 步驟 | 送出的 ACP 訊息 |
//! |---|---|
//! | `message: <文字>` | `agent_message_chunk` |
//! | `thought: <文字>` | `agent_thought_chunk` |
//! | `tool_call: {...}`（[`ToolCallStep`]） | `tool_call`（pending）→ `tool_call_update`（in_progress）→ `tool_call_update`（completed／failed） |
//! | `permission: {...}`（[`PermissionStep`]） | `tool_call`（pending）→ `session/request_permission` → 依選擇走 `allow` 或 `reject` 分支 |
//! | `plan: [...]`（[`PlanEntryStep`]） | `plan` |
//! | `usage: {...}`（[`UsageStep`]） | `usage_update` |
//! | `mcp_call: {...}`（[`McpCallStep`]） | 以 MCP client 身分呼叫注入的 stdio MCP server，結果以 `tool_call` 回報 |
//! | `sleep_ms: <毫秒>` | 不送訊息，只等待（可被 `session/cancel` 中斷） |
//! | `spawn_child` | 啟動一個一直執行、不會自己結束的子程序（模擬 Agent 開的 dev server），以 `agent_message_chunk` 回報 `child pid: <pid>` |
//! | `echo_session_mode` | 以 `agent_message_chunk` 回報目前的 session mode：`mode: <id>`（沒有 mode 時為 `mode: none`） |
//! | `echo_session_meta` | 以 `agent_message_chunk` 回報建立（或接續）session 時收到的 `_meta`（JSON；沒有時為 `null`），讓測試確認 Runner 傳給 Agent 的選項 |
//! | `wait_for_cancel` | 一直等到 `session/cancel`，以 `cancelled` 結束 |
//! | `error: {...}`（[`ErrorStep`]） | `session/prompt` 回 JSON-RPC 錯誤 |
//! | `rate_limit: {...}`（[`RateLimitStep`]） | `session/prompt` 回可辨識為 rate limit 的 JSON-RPC 錯誤 |
//! | `stop: <stop reason>` | `session/prompt` 回指定的 stop reason |
//!
//! `error`、`rate_limit`、`stop`、`wait_for_cancel` 會結束回合，所以只能是步驟串的最後一個。
//!
//! # 路徑
//!
//! `edit.path` 是相對於 `session/new` 收到的 `cwd` 的路徑（也接受 cwd 內的絕對路徑）。
//! 跑出 cwd 的路徑會讓該 tool call 以 `failed` 結束，不會寫入任何檔案。
//! 回報的 diff 一律使用正規化後的**絕對路徑**（ACP 規定）。

use std::path::Path;

use agent_client_protocol::schema::v1::{
    PlanEntryPriority, PlanEntryStatus, StopReason, ToolCallStatus, ToolKind,
};
use serde::Deserialize;

/// 一份劇本。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Script {
    /// 給人看的說明，不影響行為。
    #[serde(default)]
    pub description: Option<String>,
    /// 回合，至少一個。
    pub turns: Vec<Turn>,
}

/// 一個回合：對應一次 `session/prompt`。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Turn {
    /// 若有設定，prompt 的文字內容必須包含這段字串，否則 `session/prompt` 回 `invalid_params`。
    /// 用來確認 Runner 送來的 prompt（例如 Review Gate 退回的意見）有傳到 Agent。
    #[serde(default)]
    pub expect_prompt_contains: Option<String>,
    /// 依序執行的步驟。
    pub steps: Vec<Step>,
}

/// 回合中的一個步驟。對應的 ACP 訊息見[模組說明](self)。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// 訊息片段。
    Message(String),
    /// 思考片段。
    Thought(String),
    /// 一次 tool call。
    ToolCall(ToolCallStep),
    /// 需要權限的 tool call。
    Permission(PermissionStep),
    /// 整份 plan（ACP 的 plan 每次都送完整清單）。
    Plan(Vec<PlanEntryStep>),
    /// 用量。
    Usage(UsageStep),
    /// 呼叫注入的 MCP 工具。
    McpCall(McpCallStep),
    /// 等待指定毫秒數。
    SleepMs(u64),
    /// 等到 `session/cancel` 為止。
    WaitForCancel,
    /// 啟動一個不會自己結束的子程序（Runner 測試「取消時整個程序樹都被結束」用）。
    SpawnChild,
    /// 回報建立 session 時收到的 `_meta`。
    EchoSessionMeta,
    /// 回報目前的 session mode。
    EchoSessionMode,
    /// 讓 `session/prompt` 回 JSON-RPC 錯誤。
    Error(ErrorStep),
    /// 讓 `session/prompt` 回 rate limit 錯誤；下一次 prompt 從下一個回合繼續。
    RateLimit(RateLimitStep),
    /// 以指定的 stop reason 結束回合。
    Stop(StopReason),
}

impl Step {
    /// 這個步驟是否會結束回合。
    pub fn ends_turn(&self) -> bool {
        matches!(
            self,
            Step::WaitForCancel | Step::Error(_) | Step::RateLimit(_) | Step::Stop(_)
        )
    }
}

/// `tool_call` 步驟。
///
/// ```yaml
/// tool_call:
///   id: edit-readme        # 選填，預設自動產生 call-<n>
///   title: 編輯 README.md
///   kind: edit             # 選填，有 edit 時預設 edit，否則 other
///   raw_input: { any: json }
///   edit: { path: README.md, content: "..." }
///   output: 已更新           # 選填，完成時附上的文字內容
///   status: completed      # 選填，completed（預設）或 failed
/// ```
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCallStep {
    /// tool call ID；省略時自動產生。
    #[serde(default)]
    pub id: Option<String>,
    /// 顯示用標題。
    pub title: String,
    /// ACP 的 tool kind（`read`、`edit`、`delete`、`move`、`search`、`execute`、`think`、`fetch`、`other`…）。
    #[serde(default)]
    pub kind: Option<ToolKind>,
    /// 原樣放進 ACP 的 `rawInput`。
    #[serde(default)]
    pub raw_input: Option<serde_json::Value>,
    /// 真的寫入 session cwd 內的檔案，並以 diff 回報。
    #[serde(default)]
    pub edit: Option<EditStep>,
    /// 完成時附上的文字內容。
    #[serde(default)]
    pub output: Option<String>,
    /// 最後的狀態；只能是 `completed`（預設）或 `failed`。
    /// 指定 `failed` 時模擬工具失敗：不會套用 `edit`，也不回報 diff。
    #[serde(default)]
    pub status: Option<ToolCallStatus>,
}

impl ToolCallStep {
    /// 實際使用的 tool kind。
    pub fn effective_kind(&self) -> ToolKind {
        self.kind.unwrap_or(if self.edit.is_some() {
            ToolKind::Edit
        } else {
            ToolKind::Other
        })
    }
}

/// 檔案修改。兩種寫法擇一：
///
/// - `content`：整個檔案改寫成這段內容。diff 的 `old_text` 是原本的整份內容（新檔案則省略），
///   `new_text` 是新的整份內容。
/// - `old_text` + `new_text`：把檔案中第一個 `old_text` 換成 `new_text`（類似 Claude Code 的 Edit 工具）。
///   diff 只帶這兩段片段，不是整份檔案。找不到 `old_text` 時 tool call 以 `failed` 結束。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditStep {
    /// 相對於 session cwd 的路徑。
    pub path: String,
    /// 整份新內容。
    #[serde(default)]
    pub content: Option<String>,
    /// 要被取代的片段。
    #[serde(default)]
    pub old_text: Option<String>,
    /// 取代後的片段。
    #[serde(default)]
    pub new_text: Option<String>,
}

/// `permission` 步驟：先送出 pending 的 tool call，再送 `session/request_permission`。
///
/// 提供的選項固定為 `allow_once`、`allow_always`、`reject_once`（option ID 與 kind 同名）。
///
/// - 選了 `allow_*`：執行 `tool_call`（寫檔等）並回報完成，再執行 `allow` 步驟。
/// - 選了 `reject_*`：tool call 以 `failed` 結束（內容為「使用者拒絕」），再執行 `reject` 步驟。
/// - 回覆 `cancelled`：回合以 stop reason `cancelled` 結束。
///
/// ```yaml
/// permission:
///   tool_call:
///     title: 執行 npm test
///     kind: execute
///   allow:
///     - message: 測試通過
///   reject:
///     - message: 好，不執行
/// ```
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionStep {
    /// 請求權限的 tool call。
    pub tool_call: ToolCallStep,
    /// 允許時接著執行的步驟。
    #[serde(default)]
    pub allow: Vec<Step>,
    /// 拒絕時接著執行的步驟。
    #[serde(default)]
    pub reject: Vec<Step>,
}

/// plan 的一個項目。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanEntryStep {
    /// 項目內容。
    pub content: String,
    /// `high`、`medium`（預設）、`low`。
    #[serde(default = "default_priority")]
    pub priority: PlanEntryPriority,
    /// `pending`（預設）、`in_progress`、`completed`。
    #[serde(default = "default_plan_status")]
    pub status: PlanEntryStatus,
}

fn default_priority() -> PlanEntryPriority {
    PlanEntryPriority::Medium
}

fn default_plan_status() -> PlanEntryStatus {
    PlanEntryStatus::Pending
}

/// 用量（ACP v1 的 `UsageUpdate`）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageStep {
    /// 目前 context 中的 token 數。
    pub used: u64,
    /// context window 大小。
    pub size: u64,
    /// 累計花費。
    #[serde(default)]
    pub cost: Option<CostStep>,
    /// `_meta`（模擬 Agent 附帶的資訊，例如 Claude Code 的 `_claude/rateLimit`）。
    #[serde(default)]
    pub meta: Option<serde_json::Map<String, serde_json::Value>>,
}

/// 花費。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CostStep {
    /// 金額。
    pub amount: f64,
    /// ISO 4217 幣別，例如 `USD`。
    pub currency: String,
}

/// 呼叫注入的 MCP 工具。
///
/// 依 `session/new` 的 `mcpServers` 中名稱為 `server` 的 stdio server 設定啟動它
/// （同一個 session 第一次用到時才啟動，之後重複使用），以 MCP client 身分呼叫 `tool`。
///
/// ```yaml
/// mcp_call:
///   server: fake-mcp
///   tool: echo
///   arguments: { text: hello }
/// ```
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpCallStep {
    /// tool call ID；省略時自動產生。
    #[serde(default)]
    pub id: Option<String>,
    /// 顯示用標題；省略時為 `<server>/<tool>`。
    #[serde(default)]
    pub title: Option<String>,
    /// `session/new` 中 MCP server 的 `name`。
    pub server: String,
    /// 工具名稱。
    pub tool: String,
    /// 工具參數（JSON 物件）。
    #[serde(default)]
    pub arguments: Option<serde_json::Map<String, serde_json::Value>>,
}

/// 讓 `session/prompt` 回 JSON-RPC 錯誤。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorStep {
    /// JSON-RPC 錯誤碼，預設 `-32603`（internal error）。
    #[serde(default = "default_error_code")]
    pub code: i32,
    /// 錯誤訊息。
    pub message: String,
    /// 原樣放進 error 的 `data`。
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

fn default_error_code() -> i32 {
    INTERNAL_ERROR_CODE
}

/// JSON-RPC internal error。
pub const INTERNAL_ERROR_CODE: i32 = -32603;

/// rate limit 錯誤中 `data.type` 的值。
pub const RATE_LIMIT_ERROR_TYPE: &str = "rate_limit";

/// 讓 `session/prompt` 回 rate limit 錯誤。
///
/// 送出的 JSON-RPC 錯誤：
///
/// ```json
/// {
///   "code": -32603,
///   "message": "Rate limit exceeded: retry after 1500 ms",
///   "data": { "type": "rate_limit", "retry_after_ms": 1500 }
/// }
/// ```
///
/// 這個回合就此結束；下一次 `session/prompt` 從下一個回合繼續（同一個 session）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RateLimitStep {
    /// 建議的重試等待時間。
    pub retry_after_ms: u64,
    /// JSON-RPC 錯誤碼，預設 `-32603`。
    #[serde(default = "default_error_code")]
    pub code: i32,
    /// 自訂錯誤訊息；省略時為 `Rate limit exceeded: retry after <n> ms`。
    #[serde(default)]
    pub message: Option<String>,
    /// 自訂錯誤的 `data`（模擬各 Agent 的格式，例如 Codex 的 `codexErrorInfo`）；
    /// 省略時為 `{ "type": "rate_limit", "retry_after_ms": <n> }`。
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

/// 劇本載入失敗。
#[derive(Debug, thiserror::Error)]
pub enum ScriptError {
    /// 讀不到檔案。
    #[error("讀取劇本 {path} 失敗：{source}")]
    Io {
        /// 劇本路徑。
        path: String,
        /// 原因。
        source: std::io::Error,
    },
    /// YAML 語法或欄位錯誤。
    #[error("劇本 YAML 解析失敗：{0}")]
    Yaml(#[from] serde_saphyr::Error),
    /// 格式正確但內容不合法。
    #[error("劇本不合法（{location}）：{reason}")]
    Invalid {
        /// 出問題的位置，例如 `turns[0].steps[2]`。
        location: String,
        /// 原因。
        reason: String,
    },
}

impl Script {
    /// 從 YAML 字串解析並驗證劇本。
    pub fn from_yaml(yaml: &str) -> Result<Self, ScriptError> {
        let script: Script = serde_saphyr::from_str(yaml)?;
        script.validate()?;
        Ok(script)
    }

    /// 從檔案讀取並驗證劇本。
    pub fn from_path(path: &Path) -> Result<Self, ScriptError> {
        let yaml = std::fs::read_to_string(path).map_err(|source| ScriptError::Io {
            path: path.display().to_string(),
            source,
        })?;
        Self::from_yaml(&yaml)
    }

    /// 檢查 serde 檢查不到的規則。
    pub fn validate(&self) -> Result<(), ScriptError> {
        if self.turns.is_empty() {
            return Err(invalid("turns", "至少要有一個回合"));
        }
        for (index, turn) in self.turns.iter().enumerate() {
            validate_steps(&turn.steps, &format!("turns[{index}].steps"))?;
        }
        Ok(())
    }
}

fn invalid(location: &str, reason: &str) -> ScriptError {
    ScriptError::Invalid {
        location: location.to_owned(),
        reason: reason.to_owned(),
    }
}

fn validate_steps(steps: &[Step], location: &str) -> Result<(), ScriptError> {
    for (index, step) in steps.iter().enumerate() {
        let here = format!("{location}[{index}]");
        if step.ends_turn() && index + 1 != steps.len() {
            return Err(invalid(&here, "結束回合的步驟之後不能再有步驟"));
        }
        match step {
            Step::ToolCall(tool_call) => {
                validate_tool_call(tool_call, &format!("{here}.tool_call"))?
            }
            Step::Permission(permission) => {
                validate_tool_call(
                    &permission.tool_call,
                    &format!("{here}.permission.tool_call"),
                )?;
                validate_steps(&permission.allow, &format!("{here}.permission.allow"))?;
                validate_steps(&permission.reject, &format!("{here}.permission.reject"))?;
            }
            Step::Plan(entries) if entries.is_empty() => {
                return Err(invalid(&here, "plan 至少要有一個項目"));
            }
            Step::McpCall(call) => {
                if call.server.trim().is_empty() || call.tool.trim().is_empty() {
                    return Err(invalid(&here, "mcp_call 的 server 與 tool 不可為空"));
                }
            }
            Step::Stop(StopReason::Cancelled) => {
                return Err(invalid(
                    &here,
                    "不能直接以 cancelled 結束；請用 wait_for_cancel 等待 session/cancel",
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_tool_call(tool_call: &ToolCallStep, location: &str) -> Result<(), ScriptError> {
    if let Some(status) = tool_call.status
        && !matches!(status, ToolCallStatus::Completed | ToolCallStatus::Failed)
    {
        return Err(invalid(location, "status 只能是 completed 或 failed"));
    }
    if let Some(edit) = &tool_call.edit {
        let edit_location = format!("{location}.edit");
        if edit.path.trim().is_empty() {
            return Err(invalid(&edit_location, "path 不可為空"));
        }
        match (&edit.content, &edit.old_text, &edit.new_text) {
            (Some(_), None, None) | (None, Some(_), Some(_)) => {}
            _ => {
                return Err(invalid(
                    &edit_location,
                    "要嘛只給 content，要嘛同時給 old_text 與 new_text",
                ));
            }
        }
        if edit.old_text.as_deref() == Some("") {
            return Err(invalid(&edit_location, "old_text 不可為空字串"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析包含所有步驟種類的劇本() {
        let yaml = r#"
description: 全部步驟
turns:
  - expect_prompt_contains: 修改
    steps:
      - message: 你好
      - thought: 想一下
      - plan:
          - content: 第一步
            priority: high
            status: in_progress
          - content: 第二步
      - tool_call:
          id: edit-1
          title: 編輯
          edit:
            path: a.txt
            content: "hello\n"
      - tool_call:
          title: 取代
          kind: edit
          edit: { path: a.txt, old_text: hello, new_text: bye }
          output: done
          status: failed
      - permission:
          tool_call:
            title: 執行指令
            kind: execute
            raw_input: { command: "npm test" }
          allow:
            - message: 允許
          reject:
            - message: 拒絕
            - stop: refusal
      - usage: { used: 10, size: 100, cost: { amount: 0.5, currency: USD } }
      - mcp_call:
          server: fake-mcp
          tool: echo
          arguments: { text: hi }
      - sleep_ms: 5
      - stop: max_tokens
  - steps:
      - rate_limit: { retry_after_ms: 1500 }
  - steps:
      - error: { message: 壞掉了, data: { detail: x } }
  - steps:
      - wait_for_cancel
"#;
        let script = Script::from_yaml(yaml).expect("劇本應該合法");
        assert_eq!(script.turns.len(), 4);
        let steps = &script.turns[0].steps;
        assert_eq!(steps[0], Step::Message("你好".into()));
        assert_eq!(steps[1], Step::Thought("想一下".into()));
        let Step::Plan(entries) = &steps[2] else {
            panic!("應該是 plan")
        };
        assert_eq!(entries[0].priority, PlanEntryPriority::High);
        assert_eq!(entries[0].status, PlanEntryStatus::InProgress);
        assert_eq!(entries[1].priority, PlanEntryPriority::Medium);
        assert_eq!(entries[1].status, PlanEntryStatus::Pending);
        let Step::ToolCall(edit) = &steps[3] else {
            panic!("應該是 tool_call")
        };
        assert_eq!(edit.id.as_deref(), Some("edit-1"));
        assert_eq!(edit.effective_kind(), ToolKind::Edit);
        assert_eq!(
            edit.edit.as_ref().unwrap().content.as_deref(),
            Some("hello\n")
        );
        let Step::ToolCall(replace) = &steps[4] else {
            panic!("應該是 tool_call")
        };
        assert_eq!(replace.status, Some(ToolCallStatus::Failed));
        let Step::Permission(permission) = &steps[5] else {
            panic!("應該是 permission")
        };
        assert_eq!(permission.tool_call.effective_kind(), ToolKind::Execute);
        assert_eq!(permission.reject.len(), 2);
        let Step::Usage(usage) = &steps[6] else {
            panic!("應該是 usage")
        };
        assert_eq!(usage.cost.as_ref().unwrap().currency, "USD");
        let Step::McpCall(call) = &steps[7] else {
            panic!("應該是 mcp_call")
        };
        assert_eq!(call.arguments.as_ref().unwrap()["text"], "hi");
        assert_eq!(steps[8], Step::SleepMs(5));
        assert_eq!(steps[9], Step::Stop(StopReason::MaxTokens));
        let Step::RateLimit(rate_limit) = &script.turns[1].steps[0] else {
            panic!("應該是 rate_limit")
        };
        assert_eq!(rate_limit.retry_after_ms, 1500);
        assert_eq!(rate_limit.code, INTERNAL_ERROR_CODE);
        let Step::Error(error) = &script.turns[2].steps[0] else {
            panic!("應該是 error")
        };
        assert_eq!(error.code, INTERNAL_ERROR_CODE);
        assert_eq!(script.turns[3].steps[0], Step::WaitForCancel);
    }

    #[test]
    fn 沒有工具類型時依有無_edit_決定() {
        let yaml = "turns:\n  - steps:\n      - tool_call: { title: 讀檔 }\n";
        let script = Script::from_yaml(yaml).unwrap();
        let Step::ToolCall(tool_call) = &script.turns[0].steps[0] else {
            panic!("應該是 tool_call")
        };
        assert_eq!(tool_call.effective_kind(), ToolKind::Other);
    }

    fn assert_invalid(yaml: &str, expected_location: &str) {
        match Script::from_yaml(yaml) {
            Err(ScriptError::Invalid { location, .. }) => assert_eq!(location, expected_location),
            other => panic!("應該是 Invalid（{expected_location}），實際為 {other:?}"),
        }
    }

    fn assert_yaml_error(yaml: &str) {
        match Script::from_yaml(yaml) {
            Err(ScriptError::Yaml(_)) => {}
            other => panic!("應該是 YAML 錯誤，實際為 {other:?}"),
        }
    }

    #[test]
    fn 拒絕語法錯誤的_yaml() {
        assert_yaml_error("turns: [\n");
    }

    #[test]
    fn 拒絕缺少_turns() {
        assert_yaml_error("description: 沒有回合\n");
    }

    #[test]
    fn 拒絕未知的步驟() {
        assert_yaml_error("turns:\n  - steps:\n      - dance: true\n");
    }

    #[test]
    fn 拒絕未知的欄位() {
        assert_yaml_error("turns:\n  - steps:\n      - tool_call: { title: x, colour: red }\n");
    }

    #[test]
    fn 拒絕未知的_stop_reason() {
        assert_yaml_error("turns:\n  - steps:\n      - stop: give_up\n");
    }

    #[test]
    fn 拒絕空的回合清單() {
        assert_invalid("turns: []\n", "turns");
    }

    #[test]
    fn 拒絕結束步驟之後還有步驟() {
        assert_invalid(
            "turns:\n  - steps:\n      - stop: end_turn\n      - message: 不會執行\n",
            "turns[0].steps[0]",
        );
        assert_invalid(
            "turns:\n  - steps:\n      - wait_for_cancel\n      - message: 不會執行\n",
            "turns[0].steps[0]",
        );
    }

    #[test]
    fn 拒絕分支中結束步驟之後還有步驟() {
        let yaml = "turns:\n  - steps:\n      - permission:\n          tool_call: { title: x }\n          reject:\n            - rate_limit: { retry_after_ms: 1 }\n            - message: 不會執行\n";
        assert_invalid(yaml, "turns[0].steps[0].permission.reject[0]");
    }

    #[test]
    fn 拒絕不完整的_edit() {
        assert_invalid(
            "turns:\n  - steps:\n      - tool_call: { title: x, edit: { path: a.txt } }\n",
            "turns[0].steps[0].tool_call.edit",
        );
        assert_invalid(
            "turns:\n  - steps:\n      - tool_call: { title: x, edit: { path: a.txt, content: a, new_text: b } }\n",
            "turns[0].steps[0].tool_call.edit",
        );
        assert_invalid(
            "turns:\n  - steps:\n      - tool_call: { title: x, edit: { path: '', content: a } }\n",
            "turns[0].steps[0].tool_call.edit",
        );
    }

    #[test]
    fn 拒絕非結束狀態() {
        assert_invalid(
            "turns:\n  - steps:\n      - tool_call: { title: x, status: in_progress }\n",
            "turns[0].steps[0].tool_call",
        );
    }

    #[test]
    fn 拒絕空的_plan_與空的_mcp_server() {
        assert_invalid(
            "turns:\n  - steps:\n      - plan: []\n",
            "turns[0].steps[0]",
        );
        assert_invalid(
            "turns:\n  - steps:\n      - mcp_call: { server: '', tool: echo }\n",
            "turns[0].steps[0]",
        );
    }

    #[test]
    fn 拒絕直接以_cancelled_結束() {
        assert_invalid(
            "turns:\n  - steps:\n      - stop: cancelled\n",
            "turns[0].steps[0]",
        );
    }

    #[test]
    fn 隨附的劇本都能解析() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts");
        let mut count = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "yaml") {
                Script::from_path(&path)
                    .unwrap_or_else(|error| panic!("{} 不合法：{error}", path.display()));
                count += 1;
            }
        }
        assert!(count >= 7, "scripts/ 下的劇本太少：{count}");
    }
}
