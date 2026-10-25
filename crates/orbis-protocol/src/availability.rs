//! 能力回報：AgentAvailability（ARCHITECTURE §7、§15；ADR-0007）。
//!
//! Runner 收到 HelloAck 後送一次完整清單，之後內容有變化（Agent 安裝或登入狀態改變、
//! 並行使用數改變）時再送一次完整清單，取代前一次的內容。
//!
//! **絕不放 Credential 本身**：Credential 只以識別用的標籤出現（ADR-0007）。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::{Effort, wire_enum};

/// 每組 Credential 預設的並行上限（ARCHITECTURE §7）。
pub const DEFAULT_MAX_CONCURRENT_RUNS: u32 = 30;

/// 這台 Runner 能跑哪些 Agent，以及各 Credential 的並行狀況（Runner→Server）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AgentAvailability {
    pub agents: Vec<AgentInfo>,
    pub credentials: Vec<CredentialInfo>,
    /// `runner.toml` 中 `[repos.<key>]` 的 key（clone URL 或 Repo 名稱），不含本機路徑（協定版本 3）。
    /// Server 據此判斷哪台 Local Runner 能接本機 Repo 的 Run：本機 Repo 以名稱比對。
    pub mapped_repos: Vec<String>,
}

/// 一個 Agent 在這台 Runner 上的狀態。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AgentInfo {
    /// Agent Profile 的 id，例如 `claude-code`。與 DispatchOffer 的 `agent` 相同。
    pub id: String,
    /// Agent CLI（或 ACP adapter）的版本；偵測不到時為 `null`。
    pub version: Option<String>,
    /// 目前是否能接受這個 Agent 的 Dispatch。
    pub available: bool,
    /// `available` 為 `false` 時的原因，例如「未安裝」「未登入」；可用時為 `null`。
    pub unavailable_reason: Option<String>,
    /// 從 ACP `initialize` 與 Agent Profile 得到的能力旗標，上層據此降級處理。
    pub capabilities: Vec<AgentCapability>,
    /// 可以選擇的 model（協定版本 3 改成物件）。Agent Profile 內建一份清單（`source = profile`）；
    /// Runner 記下這個 Agent 最近一次真實 session 回傳的 config option（`model`、`thought_level`
    /// 兩類）之後，改回報那一份（`source = session`）。空陣列表示無法列出，只能用預設值。
    pub models: Vec<ModelInfo>,
    /// 這個 Agent 在 Permission Policy 下無法攔截的操作，給人看的說明，UI 要顯示出來
    /// （ADR-0006）。彈性：之後可能改成列舉。
    pub permission_gaps: Vec<String>,
    /// 使用的 Credential 的 [`CredentialInfo::label`]；沒有對應的 Credential 時為 `null`。
    pub credential: Option<String>,

    // 以下是協定版本 3 新增的欄位。
    /// 顯示名稱，例如 `Claude Code`（取自 Agent Profile；`runner.toml` 自訂的 Agent 為 id）。
    pub display_name: String,
    /// 提供這個 Agent 的廠商，例如 `Anthropic`；不知道時為 `null`。
    pub vendor: Option<String>,
    /// Agent 的 CLI 代號，例如 `claude`；不知道時為 `null`。
    pub cli: Option<String>,
    /// 是否已登入；Runner 無法得知（Agent 自己處理登入、還沒有跑過 session）時為 `null`。
    pub signed_in: Option<bool>,
    /// 怎麼登入或重新登入；Agent 不需要登入時為 `null`。
    pub login_hint: Option<LoginHint>,
}

/// Agent 可以選擇的一個 model（協定版本 3）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ModelInfo {
    /// 送給 Agent 的 model id（ACP config option 的值），例如 `claude-sonnet-5-5`。
    pub id: String,
    /// 顯示名稱，例如 `Sonnet 5.5`。
    pub name: String,
    /// UI 選單右側的標記；沒有時為 `null`。
    pub tag: Option<ModelTag>,
    pub effort: EffortSupport,
    pub source: ModelSource,
}

/// model 的推理強度能力，以 `kind` 區分。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EffortSupport {
    /// 可以選 `fast`、`std`、`deep`。
    Adjustable,
    /// 固定為某個等級，不能調整。
    Fixed { level: Effort },
    /// 不支援推理強度。
    Unsupported,
}

wire_enum! {
    /// model 的標記。
    ModelTag {
        Best => "best",
        Balanced => "balanced",
        Fast => "fast",
        Coding => "coding",
    }
}

wire_enum! {
    /// [`ModelInfo`] 的來源。
    ModelSource {
        /// Agent Profile 內建的靜態清單。
        Profile => "profile",
        /// 這個 Agent 最近一次真實 session 回傳的 config option。
        Session => "session",
    }
}

/// 怎麼登入或重新登入一個 Agent（協定版本 3）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LoginHint {
    pub kind: LoginHintKind,
    /// 要執行的指令，例如 `orbis-runner login antigravity` 或 `claude login`。
    pub command: String,
}

wire_enum! {
    /// 登入的方式。
    LoginHintKind {
        /// Runner 代為登入（Agent Profile 有 ACP 的認證方式）：Desktop 在這台電腦上執行
        /// `command`（`orbis-runner login <agent>`）。
        Runner => "runner",
        /// Agent 自己的 CLI 處理登入：在終端機執行 `command`。
        Cli => "cli",
    }
}

/// 一組 Credential 的並行狀況。只有識別用的標籤，不含任何 secret（ADR-0007）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct CredentialInfo {
    /// 識別用的標籤，在這台 Runner 內唯一，例如 `claude-subscription`。
    pub label: String,
    /// 並行上限，預設 [`DEFAULT_MAX_CONCURRENT_RUNS`]。
    pub max_concurrent_runs: u32,
    /// 目前使用這組 Credential 的 Run 數（含 Child Run）。
    pub active_runs: u32,
}

wire_enum! {
    /// Agent 的能力旗標。
    /// 彈性：A1／A2 接上真實 Agent 後會增加值；接收端遇到不認得的值要忽略。
    AgentCapability {
        /// 可以用 `session/load` 或 `session/resume` 恢復已結束的 session（Feedback Loop 需要）。
        LoadSession => "load_session",
        /// 有可靠的 plan 模式（Planning 需要；沒有時改用只產出 plan 的 prompt）。
        PlanMode => "plan_mode",
        /// prompt 可以帶圖片（在 Preview 上留言的截圖需要）。
        ImagePrompt => "image_prompt",
        /// 會回報 token 用量。
        UsageReport => "usage_report",
    }
}
