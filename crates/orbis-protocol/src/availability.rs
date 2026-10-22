//! 能力回報：AgentAvailability（ARCHITECTURE §7、§15；ADR-0007）。
//!
//! Runner 收到 HelloAck 後送一次完整清單，之後內容有變化（Agent 安裝或登入狀態改變、
//! 並行使用數改變）時再送一次完整清單，取代前一次的內容。
//!
//! **絕不放 Credential 本身**：Credential 只以識別用的標籤出現（ADR-0007）。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::wire_enum;

/// 每組 Credential 預設的並行上限（ARCHITECTURE §7）。
pub const DEFAULT_MAX_CONCURRENT_RUNS: u32 = 30;

/// 這台 Runner 能跑哪些 Agent，以及各 Credential 的並行狀況（Runner→Server）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AgentAvailability {
    pub agents: Vec<AgentInfo>,
    pub credentials: Vec<CredentialInfo>,
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
    /// 可以選擇的 model；空陣列表示無法列出，只能用預設值。
    /// 彈性：A1／A2 接上真實 Agent 後可能改成帶顯示名稱的物件。
    pub models: Vec<String>,
    /// 這個 Agent 在 Permission Policy 下無法攔截的操作，給人看的說明，UI 要顯示出來
    /// （ADR-0006）。彈性：之後可能改成列舉。
    pub permission_gaps: Vec<String>,
    /// 使用的 Credential 的 [`CredentialInfo::label`]；沒有對應的 Credential 時為 `null`。
    pub credential: Option<String>,
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
