//! 派工：DispatchOffer、DispatchAccept、DispatchReject（ARCHITECTURE §6.1、§6.2）。
//!
//! 流程：Server 送 [`DispatchOffer`] → Runner 在 `expires_at` 之前回 [`DispatchAccept`]
//! 或 [`DispatchReject`]。接受後 Runner 建立 Worktree、啟動 Agent，進度一律以 Event 回報。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::{
    AcceptanceCriterionKind, DelegationMode, Effort, PermissionPolicy, PromptSource, RepoKind,
    RunOrigin, wire_enum,
};
use crate::event::ContentBlock;
use crate::ids::{AcceptanceCriterionId, DispatchId, RunId, TaskId, Timestamp};

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
    /// Agent Profile 的 id，例如 `claude-code`、`codex`、`antigravity`、`grok`。
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

    // 以下是協定版本 2（W5–7）新增的欄位，缺少時視為括號中的值。
    /// Task 的 Acceptance Criterion（結構化），Runner 用來組 prompt（缺少＝沒有）。
    /// 實際的 Verification 由 Server 以 RunControl `verify` 要求。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub acceptance_criteria: Option<Vec<DispatchCriterion>>,
    /// Server 選定的 Credential（[`crate::availability::CredentialInfo::label`]）；
    /// 缺少時由 Runner 依 Agent 的設定決定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credential: Option<String>,
    /// Run 為什麼產生（缺少＝`dispatch`）。`mention` 而且沒有 `delegation` 與
    /// `consult_of_run_id` 時，Runner 從 `base_ref` 開出唯讀的 Worktree。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<RunOrigin>,
    /// 沒有父 Run 的 `consult` Run（@agent）要唯讀讀取哪個 Run 的 Worktree；
    /// Server 只會派給那個 Run 所在的 Runner。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub consult_of_run_id: Option<RunId>,
    /// Feedback Loop 的新 Run：沿用前一個 Run 的 Worktree 與 session（ARCHITECTURE §5.2）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub continuation: Option<DispatchContinuation>,
    /// `prompt` 的來源（缺少＝`user`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt_source: Option<PromptSource>,

    // 以下是協定版本 3 新增的欄位，缺少時視為括號中的值。
    /// 推理強度（缺少＝Agent 的預設值）。Runner 在 session 建立後以 config option 套用，
    /// 並送 `run_settings_changed`（`control_id` 為 `null`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<Effort>,
}

/// DispatchOffer 中的一條 Acceptance Criterion。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchCriterion {
    pub criterion_id: AcceptanceCriterionId,
    pub kind: AcceptanceCriterionKind,
    pub description: String,
    /// `command` 類型要執行的指令；`null` 表示沿用 Repo 設定檔的 `[verify].commands`。
    /// 其他類型一律為 `null`。
    pub command: Option<String>,
}

/// Feedback Loop 的新 Run 要接續的前一個 Run（ARCHITECTURE §5.2）。
/// Server 只會把這種 Run 派給前一個 Run 所在的 Runner；`branch` 與前一個 Run 相同。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchContinuation {
    /// 前一個 Run。Runner 沿用它的 Worktree；Worktree 已經不在時，從 remote 的分支重建。
    pub previous_run_id: RunId,
    /// 前一個 Run 回報的 ACP session id（`agent_session` Event）。有值而且 Agent 支援時以
    /// `session/resume`（或 `session/load`）恢復；沒有或恢復失敗時開新的 session，
    /// 並送 `error(session_resume_failed)`（非 fatal）。
    pub session_id: Option<String>,
    /// 前一個 Run 的 base commit。這個 Run 的 `worktree_ready` 與 review diff 都以它為基準。
    pub base_commit: String,
}

/// DispatchOffer 中 Task 的資訊。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchTask {
    pub task_id: TaskId,
    /// 例如 `ORB-12`。
    pub task_key: String,
    pub title: String,
}

/// DispatchOffer 中 Repo 的資訊，以 `kind` 區分（協定版本 3）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DispatchRepo {
    /// GitHub repository。
    Github {
        /// Repo 名稱（不含 owner），用於 Worktree 路徑 `<repo>`（§6.2）。
        /// 彈性：不同 owner 的同名 Repo 會共用目錄，之後可能改成帶 owner。
        name: String,
        /// `git clone` 用的網址。Runner 用本機的 git 認證存取，Server 不提供 token。
        clone_url: String,
        default_branch: String,
        /// Run 從這個 ref 開出 Worktree，預設是 `origin/<default_branch>`。
        /// `branch` 模式的 Child Run 改從父 Run 當下的 HEAD 開出，忽略這個欄位。
        base_ref: String,
    },
    /// 本機 Repo：Runner 只依 `runner.toml` 的 `[repos.<name>]` 找 checkout，找不到時以
    /// `repo_unavailable` 拒絕。不 clone、不 fetch remote。
    Local {
        /// Repo 名稱，即 `runner.toml` 的 key，也用於 Worktree 路徑。
        name: String,
        /// 基準分支，核准後合併到這裡（RunControl `merge_local`）。
        default_branch: String,
        /// Run 從這個 ref 開出 Worktree，即基準分支本身。
        base_ref: String,
    },
}

impl DispatchRepo {
    pub const fn kind(&self) -> RepoKind {
        match self {
            Self::Github { .. } => RepoKind::Github,
            Self::Local { .. } => RepoKind::Local,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Github { name, .. } | Self::Local { name, .. } => name,
        }
    }

    /// GitHub Repo 的 clone URL；本機 Repo 為 `None`。
    pub fn clone_url(&self) -> Option<&str> {
        match self {
            Self::Github { clone_url, .. } => Some(clone_url),
            Self::Local { .. } => None,
        }
    }

    pub fn default_branch(&self) -> &str {
        match self {
            Self::Github { default_branch, .. } | Self::Local { default_branch, .. } => {
                default_branch
            }
        }
    }

    pub fn base_ref(&self) -> &str {
        match self {
            Self::Github { base_ref, .. } | Self::Local { base_ref, .. } => base_ref,
        }
    }
}

/// Child Run 的 Delegation 資訊（ARCHITECTURE §9）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DispatchDelegation {
    pub parent_run_id: RunId,
    pub mode: DelegationMode,
    /// Child Run 的深度：父 Run 是頂層 Run 時為 1（協定版本 2 新增，缺少時由 Runner 自己計算）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub depth: Option<u32>,
    /// 這是父 Run 的第幾個 Child Run，從 1 開始，即分支名稱 `--c<n>` 的 n
    /// （協定版本 2 新增）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub child_seq: Option<u32>,
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
        /// 該 Agent 使用的 Credential 正在 rate limit 中（ARCHITECTURE §7）。Server 本來就不會派，
        /// 這是 Runner 端的保護。
        RateLimited => "rate_limited",
        /// 這台 Runner 沒有這個 Agent，或 Agent 目前無法使用（未安裝、未登入）。
        AgentUnavailable => "agent_unavailable",
        /// 收到時已超過 `expires_at`。
        Expired => "expired",
        /// 這台 Runner 已在執行同一個 Run。
        Duplicate => "duplicate",
        /// Offer 要求這台 Runner 不支援的功能，例如 Delegation 模式。
        Unsupported => "unsupported",
        /// 本機 Repo 在 `runner.toml` 中沒有對應的 checkout（協定版本 3）。
        RepoUnavailable => "repo_unavailable",
        Internal => "internal",
    }
}
