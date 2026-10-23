//! Verification（ARCHITECTURE §5.1）：Server 發起、Runner 執行、結果以 Event 回報。
//!
//! 流程：主 Run 的 Agent 結束回合（`awaiting_gate`，review）→ Server 送 RunControl `verify`，
//! 列出這一輪要檢查的條件 → Runner 回報 `status_changed(verifying)`，逐條執行：
//!
//! - `command`：在 Worktree 執行指令。
//! - `agent`／`browser`：以 Orbis 工具呼叫 `delegate`（`purpose = verification`）請 Server 建立
//!   `consult` Child Run 判定；`browser` 另外注入 Playwright MCP，連到這個 Run 的 Preview。
//!
//! 每條條件一筆 `verification_result`，全部結束送 `verification_completed`，再回到
//! `awaiting_gate`（review）。重試、次數上限與 Needs You 都由 Server 決定。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::wire_enum;
use crate::event::{BlobRef, ContentBlock, TextBody};
use crate::ids::{AcceptanceCriterionId, RunId, VerificationId};

wire_enum! {
    /// 送給 Runner 檢查的條件類型。`manual` 在 Review Gate 由人打勾，不會出現在這裡。
    VerificationKind {
        Command => "command",
        Agent => "agent",
        Browser => "browser",
    }
}

wire_enum! {
    /// 一條條件的判定結果。
    VerificationOutcome {
        Passed => "passed",
        Failed => "failed",
        /// 無法判定，例如找不到指令、Repo 沒有設定 Preview、判定用的 Child Run 失敗。
        /// Server 視為失敗，UI 另外標示。
        Error => "error",
    }
}

/// RunControl `verify` 的內容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct VerificationRequest {
    pub verification_id: VerificationId,
    /// 這個 Run 的第幾輪 Verification，從 1 開始。人選擇「附意見再試」時 Server 重新從 1 算。
    pub attempt: u32,
    /// 這一輪要檢查的條件，依 Task 中的順序。
    pub criteria: Vec<VerificationCriterion>,
    /// 判定 `agent`／`browser` 條件用的 Agent；`null` 表示與被驗證的 Run 相同。
    pub judge: Option<VerificationJudge>,
    /// 判定需要的上下文，例如 Task 描述與 Repo Spec 的連結。
    pub context: Vec<ContentBlock>,
}

/// 一條要檢查的條件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct VerificationCriterion {
    pub criterion_id: AcceptanceCriterionId,
    pub kind: VerificationKind,
    pub description: String,
    /// `command` 類型要執行的指令；`null` 表示沿用 Repo 設定檔 `[verify].commands`
    /// （從 base commit 讀）。其他類型一律為 `null`。
    pub command: Option<String>,
}

/// 判定用的 Agent。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct VerificationJudge {
    /// Agent Profile 的 id。
    pub agent: String,
    /// `null` 表示用 Agent 的預設值。
    pub model: Option<String>,
}

/// 判定的證據，以 `type` 區分。
/// 彈性：之後可能增加種類，接收端遇到不認得的種類要略過。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VerificationEvidence {
    /// 指令的輸出。內嵌的是摘要（失敗的段落），完整 log 放 blob。
    CommandOutput {
        command: String,
        /// 被訊號結束或逾時時為 `null`。
        exit_code: Option<i32>,
        output: TextBody,
        /// `output` 只有部分內容時為 `true`。
        truncated: bool,
    },
    /// 截圖（`browser` 類型）。
    Screenshot {
        image: BlobRef,
        caption: Option<String>,
        /// 截圖時的網址。
        url: Option<String>,
    },
    /// Playwright 的操作紀錄，每個步驟一行。
    ActionLog { steps: Vec<String> },
    /// 判定的理由或引用。
    Text { text: String },
}

/// `verification_result` Event 的內容：一條條件的結果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct VerificationResult {
    pub verification_id: VerificationId,
    pub attempt: u32,
    pub criterion_id: AcceptanceCriterionId,
    pub outcome: VerificationOutcome,
    /// 給人看的摘要；失敗時也是送回 Agent 重試的原因。
    pub summary: String,
    pub evidence: Vec<VerificationEvidence>,
    /// 判定這條條件的 `consult` Child Run；`command` 類型為 `null`。
    pub judged_by_run_id: Option<RunId>,
}
