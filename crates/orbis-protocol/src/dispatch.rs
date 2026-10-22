//! 派工：DispatchOffer、DispatchAccept、DispatchReject（ARCHITECTURE §6.1、§6.2）。
//!
//! 流程：Server 送 [`DispatchOffer`] → Runner 在 `expires_at` 之前回 [`DispatchAccept`]
//! 或 [`DispatchReject`]。接受後 Runner 建立 Worktree、啟動 Agent，進度一律以 Event 回報。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::{DelegationMode, PermissionPolicy, wire_enum};
use crate::event::ContentBlock;
use crate::ids::{DispatchId, RunId, TaskId, Timestamp};

/// Server 把一個 Run 指派給 Runner（Server→Runner）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchOffer {
    pub dispatch_id: DispatchId,
    pub run_id: RunId,
    /// Runner 必須在這個時間之前回覆；過期後 Server 視為未接受，Runner 收到過期的 Offer
    /// 要以 `expired` 拒絕。
    pub expires_at: Timestamp,
    pub task: DispatchTask,
    /// 這個 Run 在 Task 中的序號，從 1 開始。用於 Worktree 路徑 `<task-key>-<run-seq>`（§6.2）。
    pub run_seq: u32,
    pub repo: DispatchRepo,
    /// Run 使用的完整分支名稱，由 Server 產生（含分支前綴、Task 標題的 slug，
    /// Child Run 另加 `--c<n>`，§6.2）。`consult` 模式的 Child Run 沒有自己的分支，為 `null`。
    pub branch: Option<String>,
    /// Agent Profile 的 id，例如 `claude-code`、`codex`、`gemini`、`grok`。
    pub agent: String,
    /// 使用的 model；`null` 表示用 Agent 的預設值。
    pub model: Option<String>,
    pub permission_policy: PermissionPolicy,
    /// 送給 Agent 的第一個 prompt。
    pub prompt: Vec<ContentBlock>,
    /// `true` 時先以 plan 模式執行，產出 plan 後進入 `awaiting_gate`（Plan Gate），
    /// 核准後才修改 Worktree；Plan Gate 被關閉時為 `false`（ARCHITECTURE §5）。
    /// 彈性：A2 實作 Planning 時可能改成更細的設定。
    pub plan_gate: bool,
    /// 這個 Run 是 Child Run 時的 Delegation 資訊；一般 Run 為 `null`。
    pub delegation: Option<DispatchDelegation>,
    /// Server 已收到這個 Run 的最後 seq。新 Run 為 0；Run 被改派時，新的 Dispatch
    /// 從 `last_event_seq + 1` 接續編號。
    pub last_event_seq: u64,
}

/// DispatchOffer 中 Task 的資訊。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchTask {
    pub task_id: TaskId,
    /// 例如 `ORB-12`。
    pub task_key: String,
    pub title: String,
}

/// DispatchOffer 中 Repo 的資訊。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchRepo {
    /// Repo 名稱（不含 owner），用於 Worktree 路徑 `<repo>`（§6.2）。
    /// 彈性：不同 owner 的同名 Repo 會共用目錄，之後可能改成帶 owner。
    pub name: String,
    /// `git clone` 用的網址。Runner 用本機的 git 認證存取，Server 不提供 token。
    pub clone_url: String,
    pub default_branch: String,
    /// Run 從這個 ref 開出 Worktree，預設是 `origin/<default_branch>`。
    /// `branch` 模式的 Child Run 改從父 Run 當下的 HEAD 開出，忽略這個欄位。
    pub base_ref: String,
}

/// Child Run 的 Delegation 資訊（ARCHITECTURE §9）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchDelegation {
    pub parent_run_id: RunId,
    pub mode: DelegationMode,
}

/// Runner 接受 Dispatch（Runner→Server）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchAccept {
    pub dispatch_id: DispatchId,
}

/// Runner 拒絕 Dispatch（Runner→Server）。Server 讓 Run 回到佇列。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchReject {
    pub dispatch_id: DispatchId,
    pub reason: DispatchRejectReason,
    /// 給人看的說明，UI 與 log 使用。
    pub message: String,
}

wire_enum! {
    /// Runner 拒絕 Dispatch 的理由。
    DispatchRejectReason {
        /// 該 Agent 使用的 Credential 已達並行上限（ARCHITECTURE §7）。
        ConcurrencyLimit => "concurrency_limit",
        /// 這台 Runner 沒有這個 Agent，或 Agent 目前無法使用（未安裝、未登入）。
        AgentUnavailable => "agent_unavailable",
        /// 收到時已超過 `expires_at`。
        Expired => "expired",
        /// 這台 Runner 已在執行同一個 Run。
        Duplicate => "duplicate",
        /// Offer 要求這台 Runner 不支援的功能，例如 Delegation 模式。
        Unsupported => "unsupported",
        Internal => "internal",
    }
}
