//! Orbis MCP 工具呼叫的轉送（ARCHITECTURE §9、ADR-0009）。
//!
//! Runner 在每個 ACP session 注入 Orbis MCP server。Agent 呼叫工具時，Runner 把它轉成
//! [`ToolCallFrame`]（frame `tool_call`）送給 Server，Server 處理後以 [`ToolResultFrame`]
//! （frame `tool_result`）回覆，Runner 再把結果交回 Agent。只在 Runner 本機處理的工具
//! （例如判定 Verification 用的回報工具）不經過 Server。
//!
//! - Runner 斷線重連後，以同一個 `call_id` 重送還沒有結果的呼叫；Server 依 `call_id` 去除重複
//!   （`delegate` 不會建出兩個 Child Run），已有結果的直接重送結果。
//! - `wait_run` 與 `ask_parent` 會阻塞：Server 等到有結果才回 `tool_result`。
//! - 工具的參數放在 `call` 中，不和 frame 的欄位放在同一層（`get_run` 等工具本身就有 `run_id`）。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::{
    AcceptanceCriterionKind, DelegationMode, PermissionPolicy, RunStatus, wire_enum,
};
use crate::event::Usage;
use crate::ids::{ChildQuestionId, DispatchId, OrbisCallId, RunId, VerificationId};

/// Runner 把 Agent 的 Orbis MCP 工具呼叫轉給 Server（frame `tool_call`，Runner→Server）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ToolCallFrame {
    pub call_id: OrbisCallId,
    /// 呼叫工具的 Run。
    pub run_id: RunId,
    /// 這個 Run 目前的 Dispatch；不是目前的 Dispatch 時 Server 回 `invalid_state`。
    pub dispatch_id: DispatchId,
    pub call: OrbisToolCall,
}

/// Server 回覆工具呼叫的結果（frame `tool_result`，Server→Runner）。每個 `call_id` 恰好回一次
/// （重送的呼叫回同樣的結果）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ToolResultFrame {
    pub call_id: OrbisCallId,
    pub run_id: RunId,
    pub result: OrbisToolResult,
}

/// 轉給 Server 的工具與參數，以 `tool` 區分。
/// 彈性：之後可能增加工具；Server 遇到不認得的工具回 `invalid_state`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "tool", rename_all = "snake_case")]
pub enum OrbisToolCall {
    /// 產生 Child Run。深度、數量、允許的 Agent、Permission Policy 都由 Server 檢查。
    Delegate {
        /// Agent Profile 的 id。
        agent: String,
        /// `null` 表示用 Agent 的預設值。
        model: Option<String>,
        mode: DelegationMode,
        prompt: String,
        /// 只能與父 Run 相同或更嚴格；`null` 表示沿用父 Run。
        permission_policy: Option<PermissionPolicy>,
        purpose: DelegationPurpose,
        /// `purpose` 為 `verification` 時是哪一輪 Verification，其他為 `null`。
        verification_id: Option<VerificationId>,
    },
    /// 查詢一個 Child Run。
    GetRun { run_id: RunId },
    /// 阻塞等待一個 Child Run 終止、提出問題，或逾時，回傳當下的狀態。
    WaitRun {
        run_id: RunId,
        /// `null` 表示用 Server 的上限。
        timeout_ms: Option<u64>,
    },
    /// 列出呼叫者的所有 Child Run。
    ListRuns,
    /// 取得 `branch` 模式 Child Run 的分支，讓 Runner 在父 Worktree merge
    /// （結果以 `child_merged` Event 回報）。
    MergeChild { run_id: RunId },
    /// Child Run 向父 Run 提問並阻塞，直到父 Agent 以 `answer_child` 回答，
    /// 或（父 Run 的回合已結束時）由人在 Needs You 回答。
    AskParent { question: String },
    /// 父 Agent 回答 Child Run 的問題。
    AnswerChild {
        run_id: RunId,
        question_id: ChildQuestionId,
        answer: String,
    },
    /// 提出 Draft Task，經人確認後才進入 Backlog。
    ProposeTasks {
        /// Spec 內容或 Repo 內 Spec 的路徑。
        spec: Option<String>,
        tasks: Vec<ProposedTask>,
    },
    /// 在 Task 上留下進度或決策紀錄。
    UpdateTaskNote {
        /// Task Key（例如 `ORB-12`）；`null` 表示呼叫者自己的 Task。
        task: Option<String>,
        note: String,
    },
}

wire_enum! {
    /// `delegate` 的用途。
    DelegationPurpose {
        /// Agent 自己決定分派工作。
        Tool => "tool",
        /// Runner 為了判定 `agent`／`browser` 條件而建立的 `consult` Child Run（ARCHITECTURE §5.1）。
        Verification => "verification",
    }
}

/// `propose_tasks` 的一個 Draft Task。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ProposedTask {
    pub title: String,
    pub description: String,
    pub acceptance_criteria: Vec<ProposedCriterion>,
    /// 依賴的 Task：同一批的 `#<n>`（從 1 開始），或既有的 Task Key。
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ProposedCriterion {
    pub kind: AcceptanceCriterionKind,
    pub description: String,
    /// 只有 `command` 類型可以有值。
    pub command: Option<String>,
}

/// 工具呼叫的結果，以 `outcome` 區分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum OrbisToolResult {
    Ok {
        // ChildRunSummary 比錯誤大很多，放進 Box 避免整個列舉都變大。
        output: Box<OrbisToolOutput>,
    },
    Error {
        code: OrbisToolErrorCode,
        /// 給 Agent 看的說明。
        message: String,
    },
}

/// 成功時的輸出，以 `tool` 區分，與 [`OrbisToolCall`] 一一對應。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "tool", rename_all = "snake_case")]
pub enum OrbisToolOutput {
    Delegate {
        child_run_id: RunId,
        /// `consult` 模式為 `null`。
        branch: Option<String>,
    },
    GetRun(ChildRunSummary),
    WaitRun(ChildRunSummary),
    ListRuns {
        runs: Vec<ChildRunSummary>,
    },
    MergeChild {
        /// 要 merge 的子分支。
        branch: String,
        /// 子分支目前的 HEAD。
        head_commit: String,
    },
    AskParent {
        answer: String,
    },
    AnswerChild,
    ProposeTasks {
        draft_task_ids: Vec<String>,
    },
    UpdateTaskNote {
        note_id: String,
    },
}

/// 給父 Agent 看的 Child Run 狀態。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ChildRunSummary {
    pub run_id: RunId,
    pub agent: String,
    pub model: Option<String>,
    pub mode: DelegationMode,
    pub status: RunStatus,
    /// `consult` 模式為 `null`。
    pub branch: Option<String>,
    /// Child Run 最後的回覆（`final_message` Event）；還沒有時為 `null`。
    pub final_message: Option<String>,
    /// 等待父 Run 回答的問題；沒有時為 `null`。
    pub pending_question: Option<PendingQuestion>,
    /// 累計用量；還沒有回報時為 `null`。
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PendingQuestion {
    pub question_id: ChildQuestionId,
    pub question: String,
}

wire_enum! {
    /// 工具呼叫失敗的理由。
    /// 彈性：之後可能增加代碼，Runner 遇到不認得的值要當成 `internal`。
    OrbisToolErrorCode {
        /// Project 關閉了 Delegation。
        DelegationDisabled => "delegation_disabled",
        /// Agent 不在 Project 允許分派的清單中。
        AgentNotAllowed => "agent_not_allowed",
        /// 父 Run 所在的 Runner 沒有這個 Agent，或目前無法使用。
        AgentUnavailable => "agent_unavailable",
        /// 超過 Delegation 的深度上限（2 層）。
        DepthExceeded => "depth_exceeded",
        /// 這個 Run 同時進行中的 Child Run 已達上限（5 個）。
        ChildLimitExceeded => "child_limit_exceeded",
        /// 要求的 Permission Policy 比父 Run 寬鬆。
        PermissionNotNarrower => "permission_not_narrower",
        /// 找不到 Run、Task 或問題。
        NotFound => "not_found",
        /// 指定的 Run 不是呼叫者的 Child Run。
        NotChild => "not_child",
        /// 目前的狀態不能做這件事，例如 merge `consult` 模式或還沒結束的 Child Run。
        InvalidState => "invalid_state",
        Internal => "internal",
    }
}

wire_enum! {
    /// [`OrbisToolCall`] 的 `tool` 值。TS 端的 `ORBIS_TOOLS` 由此產生。
    OrbisToolName {
        Delegate => "delegate",
        GetRun => "get_run",
        WaitRun => "wait_run",
        ListRuns => "list_runs",
        MergeChild => "merge_child",
        AskParent => "ask_parent",
        AnswerChild => "answer_child",
        ProposeTasks => "propose_tasks",
        UpdateTaskNote => "update_task_note",
    }
}

impl OrbisToolCall {
    /// 這個呼叫的 `tool` 值。新增工具時這裡的 match 會編譯失敗，提醒同步更新 [`OrbisToolName`]。
    pub const fn name(&self) -> OrbisToolName {
        match self {
            Self::Delegate { .. } => OrbisToolName::Delegate,
            Self::GetRun { .. } => OrbisToolName::GetRun,
            Self::WaitRun { .. } => OrbisToolName::WaitRun,
            Self::ListRuns => OrbisToolName::ListRuns,
            Self::MergeChild { .. } => OrbisToolName::MergeChild,
            Self::AskParent { .. } => OrbisToolName::AskParent,
            Self::AnswerChild { .. } => OrbisToolName::AnswerChild,
            Self::ProposeTasks { .. } => OrbisToolName::ProposeTasks,
            Self::UpdateTaskNote { .. } => OrbisToolName::UpdateTaskNote,
        }
    }
}

impl OrbisToolOutput {
    /// 這個輸出的 `tool` 值，必須與呼叫的工具相同。
    pub const fn name(&self) -> OrbisToolName {
        match self {
            Self::Delegate { .. } => OrbisToolName::Delegate,
            Self::GetRun(_) => OrbisToolName::GetRun,
            Self::WaitRun(_) => OrbisToolName::WaitRun,
            Self::ListRuns { .. } => OrbisToolName::ListRuns,
            Self::MergeChild { .. } => OrbisToolName::MergeChild,
            Self::AskParent { .. } => OrbisToolName::AskParent,
            Self::AnswerChild => OrbisToolName::AnswerChild,
            Self::ProposeTasks { .. } => OrbisToolName::ProposeTasks,
            Self::UpdateTaskNote { .. } => OrbisToolName::UpdateTaskNote,
        }
    }
}
