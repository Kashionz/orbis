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

use crate::enums::{GateDecision, GateKind, wire_enum};
use crate::event::ContentBlock;
use crate::ids::{DispatchId, PermissionRequestId, RunControlId, RunId};

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
    /// Verification 失敗的原因、在 Preview 上的留言）。Agent 接收後回 `applied`。
    Prompt { prompt: Vec<ContentBlock> },
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
}

wire_enum! {
    /// [`RunControlAction`] 的 `action` 值。TS 端的 `RUN_CONTROL_ACTIONS` 由此產生。
    RunControlActionName {
        Cancel => "cancel",
        Prompt => "prompt",
        PermissionResponse => "permission_response",
        GateResult => "gate_result",
        PushBranch => "push_branch",
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
    /// `push_branch` 以外的動作處理成功。
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
