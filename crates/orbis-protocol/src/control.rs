//! 控制：RunControl 與它的執行結果 RunControlResult。
//!
//! Server 對進行中的 Run 下指令（[`RunControl`]），Runner 處理完後以 [`RunControlResult`]
//! 回報結果（以 `control_id` 對應）。動作對 Run 造成的後續變化（狀態、訊息等）
//! 仍以 Event 回報，RunControlResult 只回答「這個指令處理成功了沒有」。
//!
//! 傳輸格式：`action`（或 `outcome`）與它的欄位和 `control_id` 等放在同一層，例如
//!
//! ```json
//! { "type": "run_control", "control_id": "…", "run_id": "…", "dispatch_id": "…", "action": "cancel" }
//! ```

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::dispatch::DispatchCriterion;
use crate::enums::{
    Effort, GateDecision, GateKind, LocalMergeStrategy, PermissionPolicy, PromptDelivery,
    PromptSource, wire_enum,
};
use crate::event::{ContentBlock, TextBody};
use crate::ids::{DispatchId, PermissionRequestId, RunControlId, RunId};
use crate::verification::VerificationRequest;

/// Server 對進行中的 Run 下的指令（Server→Runner）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RunControl {
    pub control_id: RunControlId,
    pub run_id: RunId,
    /// 這個 Run 目前的 Dispatch。與 Runner 手上的不同時，Runner 以 `stale_dispatch` 拒絕。
    pub dispatch_id: DispatchId,
    #[serde(flatten)]
    pub action: RunControlAction,
}

/// RunControl 的動作，以 `action` 區分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum RunControlAction {
    /// 中止 Run：結束整個程序樹，Run 進入 `canceled`。處理完回 `applied`。
    Cancel,
    /// 送出後續 prompt，在**同一個 session** 繼續（例如 Review Gate 退回的行內留言、
    /// Verification 失敗的原因、在 Preview 上的留言、執行中人傳給 Agent 的訊息）。
    ///
    /// - Gate 等待時：照舊立即交給 Agent，`delivery` 不適用。
    /// - 回合中或等待權限回覆時（協定版本 3）：依 `delivery` 排隊或中斷。排隊時 Runner 先送
    ///   `prompt_queued`，回合結束後不進入 Gate，直接以排隊的訊息開始下一個回合（多則依序以空行
    ///   合併成一則），並對每則排隊的訊息各送一筆帶自己 `control_id` 的 `prompt_submitted`。
    ///   `interrupt` 先 `session/cancel` 目前的回合，回合結束後立即送出（接在已排隊的訊息之後）。
    ///
    /// Runner 收下（交給 Agent 或排進佇列）後回 `applied`。
    Prompt {
        prompt: Vec<ContentBlock>,
        /// prompt 的來源；缺少時視為 `user`（W5–7 之前的 Server 不會送這個欄位）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        source: Option<PromptSource>,
        /// 回合中送出時的處理方式；缺少時視為 `queue`（協定版本 3）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        delivery: Option<PromptDelivery>,
    },
    /// 回覆 `permission_request` Event。轉給 Agent 後回 `applied`。
    PermissionResponse {
        request_id: PermissionRequestId,
        /// 被選擇的 [`crate::event::PermissionOption::option_id`]。
        option_id: String,
    },
    /// Gate 的結果。Plan Gate 核准後 Runner 切換成執行模式；退回時附帶的意見另外以
    /// `prompt` 送出。處理完回 `applied`。
    GateResult {
        gate: GateKind,
        decision: GateDecision,
    },
    /// 把 Run 的分支 push 到 remote（供開 PR 使用）。push 完成後回 `branch_pushed`。
    /// 彈性：Worktree 中未 commit 的變更由誰、以什麼訊息 commit，留給 A1 決定。
    PushBranch,
    /// 執行一輪 Verification（ARCHITECTURE §5.1，見 [`crate::verification`]）。Runner 開始執行後回
    /// `applied`，結果以 `verification_result` 與 `verification_completed` Event 回報。
    Verify(VerificationRequest),
    /// 封存 Run（ARCHITECTURE §6.2）：執行 `archive` hook、刪除 Worktree，連同 Child Run 一起處理；
    /// 分支上有未合併的 commit 時保留分支。處理完回 `applied`；hook 失敗時回 `rejected`（`failed`），
    /// Worktree 不刪除。
    Archive,
    /// 重新啟動 Preview 的 dev server（ARCHITECTURE §13）。重新啟動後回 `applied`，
    /// 就緒時照常送 `preview_ready`。這個 Run 沒有設定 Preview 時回 `rejected`（`invalid_state`）。
    RestartPreview,

    // 以下是協定版本 3 新增的動作。
    /// 收回還在排隊的 prompt（`prompt_control_id` 是當初 `prompt` 的 `control_id`）。
    /// 收回後送 `prompt_withdrawn` 並回 `applied`；已經交給 Agent 或不在佇列中時回
    /// `rejected`（`invalid_state`）。欄位不叫 `control_id`，因為會和 [`RunControl::control_id`] 撞名。
    WithdrawPrompt { prompt_control_id: RunControlId },
    /// 切換模型與推理強度（至少一個有值）。Runner 收下就回 `applied`，在下一個回合開始前
    /// （閒置時立即）以 ACP `session/set_config_option` 套用，套用後送 `run_settings_changed`；
    /// Agent 不支援的項目列在該 Event 的 `not_applied`。
    SetSessionConfig {
        model: Option<String>,
        effort: Option<Effort>,
    },
    /// 換掉 Run 的 Permission Policy，從下一個權限請求開始套用。處理後送
    /// `run_settings_changed` 並回 `applied`。
    SetPermissionPolicy { policy: PermissionPolicy },
    /// 換 Agent 並接續作業（同一個 Run、同一個 Worktree）。只在回合之間生效：回合中收到時
    /// 和排隊的 prompt 一樣等回合結束。Runner 結束舊 Agent 的 session，以新的 Agent 開新的 session，
    /// 依新 Agent 的 Agent Profile 重新套用 session mode，送出交接 prompt（來源 `handoff`），
    /// 並送 `agent_switched`。Child Run 不受影響。收下就回 `applied`；這台 Runner 沒有這個 Agent
    /// 時回 `rejected`（`failed`）。
    SwitchAgent {
        /// 新的 Agent Profile id。
        agent: String,
        /// 新 Agent 的 model；`null` 表示用 Agent 的預設值。
        model: Option<String>,
        effort: Option<Effort>,
        /// Server 選定的 Credential（同 DispatchOffer 的 `credential`）；`null` 時由 Runner 決定。
        credential: Option<String>,
        /// 交接 prompt 中只有 Server 知道的部分，見 [`HandoffContext`]。
        /// 放在 `Box` 中避免整個 RunControlAction 變大（JSON 形狀不受影響）。
        handoff: Box<HandoffContext>,
    },
    /// 本機 Repo 核准後，把 Run 的分支合併到本機 checkout 的基準分支（ARCHITECTURE §5）。
    /// 和 `push_branch` 一樣先結束 Agent、自動 commit 未提交的變更。
    /// - 基準分支沒有在 checkout 中簽出：在暫時的 worktree 中合併。
    /// - 已簽出且工作目錄乾淨：直接在 checkout 中合併。
    /// - 工作目錄有未 commit 的變更，或合併衝突：不合併（衝突時還原），回 `rejected`（`failed`），
    ///   `message` 是 git 的輸出（Server 據此讓 Run 停下，`local_merge_blocked`）。
    ///
    /// 成功後送 `local_merged` 並回 `applied`。`push_base` 為 `true` 而且 checkout 有 `origin` 時，
    /// 合併後 push 基準分支；push 失敗不影響合併的結果，另送非 fatal 的 `error`（`git_failed`）。
    MergeLocal {
        strategy: LocalMergeStrategy,
        push_base: bool,
    },
}

/// 換 Agent 的交接 prompt 中只有 Server 知道的部分（ARCHITECTURE §7、ADR-0016）。
///
/// Runner 依固定格式組出交接 prompt，依序是：
/// 1. Task 的規格與驗收條件（這裡的 `task_spec`、`acceptance_criteria`）
/// 2. 人送出的所有 prompt（依時間，取自 Run 的 `prompt_submitted`）
/// 3. Agent 每個回合最後的回覆（`final_message`）
/// 4. 目前的計畫（最新的 `plan_proposed`／`plan`）
/// 5. diff 摘要：改了哪些檔案、各增減幾行（Runner 自己從 Worktree 算出）
/// 6. 還沒處理的審查留言（這裡的 `review_comments`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct HandoffContext {
    /// Task 目前的規格：Task 描述，或連結的 Repo Spec 內容（markdown）。
    pub task_spec: TextBody,
    pub acceptance_criteria: Vec<DispatchCriterion>,
    /// 目前 Review Gate 上還沒送回 Agent 的留言；沒有時為空陣列。
    pub review_comments: Vec<HandoffReviewComment>,
}

/// 交接 prompt 中一則還沒處理的審查留言。diff 行內留言有 `path` 與 `line`；Preview 留言有 `url`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct HandoffReviewComment {
    /// 相對於 Worktree 根目錄、以 `/` 分隔的路徑。
    pub path: Option<String>,
    /// 從 1 開始的行號。
    pub line: Option<u32>,
    /// 留言時 Preview 的網址。
    pub url: Option<String>,
    pub body: String,
}

wire_enum! {
    /// [`RunControlAction`] 的 `action` 值。TS 端的 `RUN_CONTROL_ACTIONS` 由此產生。
    RunControlActionName {
        Cancel => "cancel",
        Prompt => "prompt",
        PermissionResponse => "permission_response",
        GateResult => "gate_result",
        PushBranch => "push_branch",
        Verify => "verify",
        Archive => "archive",
        RestartPreview => "restart_preview",
        WithdrawPrompt => "withdraw_prompt",
        SetSessionConfig => "set_session_config",
        SetPermissionPolicy => "set_permission_policy",
        SwitchAgent => "switch_agent",
        MergeLocal => "merge_local",
    }
}

impl RunControlAction {
    /// 這個動作的 `action` 值。新增動作時這裡的 match 會編譯失敗，提醒同步更新 [`RunControlActionName`]。
    pub const fn name(&self) -> RunControlActionName {
        match self {
            Self::Cancel => RunControlActionName::Cancel,
            Self::Prompt { .. } => RunControlActionName::Prompt,
            Self::PermissionResponse { .. } => RunControlActionName::PermissionResponse,
            Self::GateResult { .. } => RunControlActionName::GateResult,
            Self::PushBranch => RunControlActionName::PushBranch,
            Self::Verify(_) => RunControlActionName::Verify,
            Self::Archive => RunControlActionName::Archive,
            Self::RestartPreview => RunControlActionName::RestartPreview,
            Self::WithdrawPrompt { .. } => RunControlActionName::WithdrawPrompt,
            Self::SetSessionConfig { .. } => RunControlActionName::SetSessionConfig,
            Self::SetPermissionPolicy { .. } => RunControlActionName::SetPermissionPolicy,
            Self::SwitchAgent { .. } => RunControlActionName::SwitchAgent,
            Self::MergeLocal { .. } => RunControlActionName::MergeLocal,
        }
    }
}

/// RunControl 的處理結果（Runner→Server）。每個 RunControl 恰好回一次。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RunControlResult {
    pub control_id: RunControlId,
    pub run_id: RunId,
    pub dispatch_id: DispatchId,
    #[serde(flatten)]
    pub outcome: RunControlOutcome,
}

/// 處理結果，以 `outcome` 區分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum RunControlOutcome {
    /// `push_branch` 以外的動作處理成功（`merge_local` 的合併結果另以 `local_merged` 回報）。
    Applied,
    /// `push_branch` 成功。
    BranchPushed {
        branch: String,
        /// push 出去的 HEAD commit SHA（40 個十六進位字元）。
        commit_sha: String,
    },
    /// 無法處理。
    Rejected {
        reason: RunControlRejectReason,
        /// 給人看的說明（已遮蔽 secret），例如 git push 的錯誤訊息。
        message: String,
    },
}

wire_enum! {
    /// RunControl 被拒絕的理由。
    RunControlRejectReason {
        /// 這台 Runner 上沒有這個 Run。
        UnknownRun => "unknown_run",
        /// `dispatch_id` 不是這個 Run 目前的 Dispatch。
        StaleDispatch => "stale_dispatch",
        /// Run 目前的狀態不能做這個動作，例如已結束的 Run、沒有在等待的 Gate。
        InvalidState => "invalid_state",
        /// 沒有這個權限請求，或請求已經結束，或 `option_id` 不在選項中。
        UnknownPermissionRequest => "unknown_permission_request",
        /// 執行時失敗，例如 git push 失敗。
        Failed => "failed",
    }
}
