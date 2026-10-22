//! 正規化的 Event 模型（ARCHITECTURE §7、§14）。
//!
//! Runner 把 Agent 的 ACP `session/update` 等訊息轉成這裡的型別再送到 Server，
//! ACP 的原始型別不外流（ADR-0002）。設計時參考了 ACP v1 的 `SessionUpdate`、
//! `ToolCall`、`ToolCallUpdate`、`Plan`、`UsageUpdate` 與 `RequestPermissionRequest`。
//!
//! 傳輸格式：`kind` 與 payload 欄位都和 `run_id`、`seq`、`ts` 放在同一層，例如
//!
//! ```json
//! { "type": "event", "dispatch_id": "…", "run_id": "…", "seq": 3, "ts": "…",
//!   "kind": "thought_chunk", "text": "…" }
//! ```
//!
//! 因此 payload 的頂層欄位不可以叫 `type`、`dispatch_id`、`run_id`、`seq`、`ts`、`kind`。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::{GateKind, RunStatus, wire_enum};
use crate::ids::{BlobId, DispatchId, PermissionRequestId, RunId, Timestamp, ToolCallId};

/// Runner 送給 Server 的一筆 Event 的 frame（`event`）：[`EventEnvelope`] 再加上產生它的 Dispatch。
/// Server 拒絕不是該 Run 目前 Dispatch 的 Event（ARCHITECTURE §6.1），
/// 存進 `run_events` 的只有 [`EventEnvelope`]。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct EventFrame {
    pub dispatch_id: DispatchId,
    #[serde(flatten)]
    pub event: EventEnvelope,
}

/// 一筆 Event：Run、序號、時間與內容。這是 Event 保存與重播的單位。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct EventEnvelope {
    pub run_id: RunId,
    /// 在每個 Run 內從 1 開始連續遞增，不跳號。Server 依 `(run_id, seq)` 去除重複，
    /// 並以 [`EventAck`] 回報已保存的位置。
    pub seq: u64,
    /// Runner 產生這筆 Event 的時間。
    pub ts: Timestamp,
    #[serde(flatten)]
    pub kind: EventKind,
}

/// Server 回報某個 Run 已保存到哪一個 seq（frame `event_ack`）。
/// Runner 收到後可以清除 `seq` 以前（含）暫存的 Event（ARCHITECTURE §14）。
/// 不帶 `dispatch_id`：seq 在 Run 內連續編號，跨 Dispatch 也不重複，ack 只看 Run。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct EventAck {
    pub run_id: RunId,
    /// 已連續保存的最大 seq；Server 不保證每筆 Event 都回 ack，可以定期合併回報。
    pub seq: u64,
}

/// Event 的種類與內容，以 `kind` 區分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventKind {
    /// Agent 回覆訊息的一個片段（ACP `agent_message_chunk`）。UI 依序串接同一段回覆的片段。
    /// 彈性：Runner 可以把連續的片段合併後再送，以減少 Event 數量。
    MessageChunk { content: ContentBlock },
    /// Agent 思考過程的一個片段（ACP `agent_thought_chunk`）。
    ThoughtChunk { text: String },
    /// Tool call 的建立或更新，見 [`ToolCall`]。
    ToolCall(ToolCall),
    /// 需要人回覆的權限請求。依 Permission Policy 自動回覆的請求不會產生這個 Event。
    /// Run 同時以 `status_changed` 進入 `awaiting_permission`。
    PermissionRequest {
        request_id: PermissionRequestId,
        /// 觸發請求的 tool call；Runner 會先送出這個 id 的 `tool_call` Event。
        tool_call_id: Option<ToolCallId>,
        /// 給人看的說明，例如要執行的指令。
        title: String,
        options: Vec<PermissionOption>,
    },
    /// 權限請求已結束（人回覆、Run 被中止或 Agent 撤回請求），Server 據此移除 Needs You 項目。
    PermissionResolved {
        request_id: PermissionRequestId,
        /// 被選擇的 [`PermissionOption::option_id`]；請求被取消時為 `null`。
        selected_option_id: Option<String>,
    },
    /// Agent 目前的 plan。每次都送完整清單，取代前一次的內容（同 ACP `plan`）。
    Plan { entries: Vec<PlanEntry> },
    /// 用量，見 [`Usage`]。
    Usage(Usage),
    /// Run 狀態變更。
    StatusChanged {
        status: RunStatus,
        /// `status` 為 `awaiting_gate` 時等待的 Gate，其他狀態為 `null`。
        gate: Option<GateKind>,
        /// 補充說明，例如失敗原因或 Agent 結束 turn 的理由。
        message: Option<String>,
    },
    /// 錯誤。`fatal` 為 `true` 時，Run 接著會以 `status_changed` 進入 `failed`。
    Error {
        code: RunErrorCode,
        message: String,
        fatal: bool,
    },
    /// 偵測到 rate limit，Run 暫停（同時以 `status_changed` 進入 `rate_limited`），
    /// 額度恢復後在同一個 session 繼續，不會改用其他 Agent（ARCHITECTURE §7）。
    RateLimited {
        /// 預估恢復的時間；Agent 沒有提供時為 `null`。
        resets_at: Option<Timestamp>,
        /// Agent 回報的原始訊息（已遮蔽 secret）。
        message: String,
    },
    /// Preview 的 dev server 已就緒（ARCHITECTURE §13）。
    PreviewReady {
        /// 分配給這個 Worktree 的 port（ARCHITECTURE §6.3 注入的 port 環境變數）。
        port: u16,
        /// Runner 本機可以開啟的網址，例如 `http://localhost:4123/`（含 `ready_path`）。
        /// 分享給 Team 的網址由 Server 另外產生。
        url: String,
    },
    /// Worktree 已建立，Run 的 `worktree_path`、`branch`、`base_commit` 以此為準（ARCHITECTURE §4、§6.2）。
    WorktreeReady {
        /// Runner 本機上正規化後的絕對路徑，只用於顯示與除錯。
        worktree_path: String,
        /// Run 使用的分支；`consult` 模式的 Child Run 沒有自己的分支，為 `null`。
        branch: Option<String>,
        /// 開出 Worktree 時的 commit SHA（40 個十六進位字元）。
        base_commit: String,
    },
}

wire_enum! {
    /// [`EventKind`] 的 `kind` 值。TS 端的 `EVENT_KINDS` 由此產生。
    EventKindName {
        MessageChunk => "message_chunk",
        ThoughtChunk => "thought_chunk",
        ToolCall => "tool_call",
        PermissionRequest => "permission_request",
        PermissionResolved => "permission_resolved",
        Plan => "plan",
        Usage => "usage",
        StatusChanged => "status_changed",
        Error => "error",
        RateLimited => "rate_limited",
        PreviewReady => "preview_ready",
        WorktreeReady => "worktree_ready",
    }
}

impl EventKind {
    /// 這筆 Event 的 `kind` 值。新增種類時這裡的 match 會編譯失敗，提醒同步更新 [`EventKindName`]。
    pub const fn name(&self) -> EventKindName {
        match self {
            Self::MessageChunk { .. } => EventKindName::MessageChunk,
            Self::ThoughtChunk { .. } => EventKindName::ThoughtChunk,
            Self::ToolCall(_) => EventKindName::ToolCall,
            Self::PermissionRequest { .. } => EventKindName::PermissionRequest,
            Self::PermissionResolved { .. } => EventKindName::PermissionResolved,
            Self::Plan { .. } => EventKindName::Plan,
            Self::Usage(_) => EventKindName::Usage,
            Self::StatusChanged { .. } => EventKindName::StatusChanged,
            Self::Error { .. } => EventKindName::Error,
            Self::RateLimited { .. } => EventKindName::RateLimited,
            Self::PreviewReady { .. } => EventKindName::PreviewReady,
            Self::WorktreeReady { .. } => EventKindName::WorktreeReady,
        }
    }
}

/// Tool call 的建立或更新（ARCHITECTURE 共同規則：tool call 只用 `tool_call` 一種 kind）。
///
/// 同一個 `tool_call_id` 的第一筆 Event 是建立，`title`、`tool_kind`、`status` 必定有值；
/// 之後的 Event 是更新：值為 `null` 的欄位維持前一筆的內容，有值的欄位整個取代
/// （`content` 與 `locations` 也是整個清單取代，不是附加）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ToolCall {
    pub tool_call_id: ToolCallId,
    /// 給人看的標題，例如「Edit src/main.rs」或要執行的指令。
    pub title: Option<String>,
    pub tool_kind: Option<ToolKind>,
    pub status: Option<ToolCallStatus>,
    pub content: Option<Vec<ToolCallContent>>,
    /// 受影響的檔案位置，UI 用來跳到對應的程式碼。
    pub locations: Option<Vec<ToolCallLocation>>,
}

/// Tool call 產生的內容，以 `type` 區分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolCallContent {
    /// 文字輸出（已遮蔽 secret）。
    Text { text: String },
    /// 檔案的修改。`path` 的規則同 [`ToolCallLocation::path`]。
    Diff {
        path: String,
        /// 修改前的內容；新增檔案時為 `null`。
        old: Option<TextBody>,
        /// 修改後的內容；刪除檔案時為 `null`。
        new: Option<TextBody>,
    },
    /// 指令的執行輸出。
    /// 彈性：目前每次更新都送到目前為止的完整輸出；之後可能改成只送增量。
    Terminal {
        /// Runner 為這個 terminal 產生的 ID，同一個 Run 內唯一。
        terminal_id: String,
        /// 執行的指令；Agent 沒有提供時為 `null`。
        command: Option<String>,
        output: TextBody,
        /// 指令結束後的 exit code；還在執行或被訊號結束時為 `null`。
        exit_code: Option<i32>,
    },
}

/// 一段文字內容。小的直接內嵌，大的（例如完整的檔案內容）改放 blob（ARCHITECTURE §14）。
/// 彈性：內嵌與 blob 的大小門檻由 Runner 決定，接收端兩種都要能處理。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TextBody {
    Inline { text: String },
    Blob(BlobRef),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ToolCallLocation {
    /// Worktree 內的檔案用相對於 Worktree 根目錄、以 `/` 分隔的路徑；
    /// Worktree 外的檔案用正規化後的絕對路徑。
    pub path: String,
    /// 從 1 開始的行號；不指定行時為 `null`。
    pub line: Option<u32>,
}

wire_enum! {
    /// Tool call 的類別，UI 用來選圖示與分組（對應 ACP `ToolKind`）。
    ToolKind {
        Read => "read",
        Edit => "edit",
        Delete => "delete",
        Move => "move",
        Search => "search",
        Execute => "execute",
        Think => "think",
        Fetch => "fetch",
        /// 其他，包含 ACP 的 `switch_mode` 與無法分類的工具。
        Other => "other",
    }
}

wire_enum! {
    /// Tool call 的狀態（對應 ACP `ToolCallStatus`）。
    ToolCallStatus {
        Pending => "pending",
        InProgress => "in_progress",
        Completed => "completed",
        Failed => "failed",
    }
}

/// 權限請求中可以選擇的一個選項（對應 ACP `PermissionOption`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PermissionOption {
    /// 回覆時放在 RunControl `permission_response` 的 `option_id`。
    pub option_id: String,
    /// 給人看的選項名稱。
    pub name: String,
    pub kind: PermissionOptionKind,
}

wire_enum! {
    /// 權限選項的性質，UI 用來決定按鈕樣式（對應 ACP `PermissionOptionKind`）。
    PermissionOptionKind {
        AllowOnce => "allow_once",
        AllowAlways => "allow_always",
        RejectOnce => "reject_once",
        RejectAlways => "reject_always",
    }
}

/// Plan 中的一個項目（對應 ACP `PlanEntry`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PlanEntry {
    pub content: String,
    pub priority: PlanEntryPriority,
    pub status: PlanEntryStatus,
}

wire_enum! {
    PlanEntryPriority {
        High => "high",
        Medium => "medium",
        Low => "low",
    }
}

wire_enum! {
    PlanEntryStatus {
        Pending => "pending",
        InProgress => "in_progress",
        Completed => "completed",
    }
}

/// Run 的用量。每次都送 **Run 開始至今的累計值**，取代前一次的內容。
/// Agent 沒有回報的項目為 `null`。單位都是 token，`cost` 除外。
/// 彈性：各 Agent 能回報的項目差異很大，之後可能增加欄位。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub thought_tokens: Option<u64>,
    pub cached_read_tokens: Option<u64>,
    pub cached_write_tokens: Option<u64>,
    /// 目前 context 已使用的 token 數（不是累計值）。
    pub context_used_tokens: Option<u64>,
    /// Model 的 context window 大小。
    pub context_window_tokens: Option<u64>,
    pub cost: Option<Cost>,
}

/// 金額。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Cost {
    pub amount: f64,
    /// ISO 4217 幣別代碼，例如 `USD`。
    pub currency: String,
}

wire_enum! {
    /// `error` Event 的錯誤代碼。
    /// 彈性：A1／A2 實作時可能增加代碼，接收端遇到不認得的值要當成 `internal` 處理。
    RunErrorCode {
        /// Agent 程序無法啟動（找不到執行檔、未登入等）。
        AgentStartFailed => "agent_start_failed",
        /// Agent 程序非預期結束。
        AgentCrashed => "agent_crashed",
        /// Agent 回報的錯誤。
        AgentError => "agent_error",
        /// 建立或刪除 Worktree 失敗。
        WorktreeFailed => "worktree_failed",
        /// Repo 設定檔中 `[worktree].setup` 的指令失敗（ARCHITECTURE §6.3）。
        SetupFailed => "setup_failed",
        /// 其他 git 操作失敗（fetch、push 等）。
        GitFailed => "git_failed",
        /// Git for Windows 的 path too long 錯誤，UI 要提示縮短路徑（ARCHITECTURE §6.4）。
        PathTooLong => "path_too_long",
        Internal => "internal",
    }
}

/// 訊息或 prompt 的一個內容區塊（對應 ACP `ContentBlock` 的子集合），以 `type` 區分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    /// 圖片一律以 blob 傳遞，例如在 Preview 上留言時附的截圖。
    Image(BlobRef),
    /// 指向一個資源的連結，例如 Repo 中的 Spec 檔。
    ResourceLink {
        uri: String,
        name: String,
    },
}

/// 大型內容的參照（共同規則第 5 條）。內容本身另外上傳，Event 中只放參照。
/// 彈性：上傳途徑（WebSocket 或 HTTP）與 `blob_id` 的產生方式尚未決定。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct BlobRef {
    pub blob_id: BlobId,
    /// 內容的 SHA-256，64 個小寫十六進位字元。
    pub sha256: String,
    /// 內容的大小，單位是 byte。
    pub size: u64,
    /// MIME type，例如 `text/plain; charset=utf-8`、`image/png`。
    pub media_type: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_kind_name_matches_serde_tag() {
        let kind = EventKind::ThoughtChunk {
            text: "想一下".into(),
        };
        let value = serde_json::to_value(&kind).unwrap();
        assert_eq!(value["kind"], kind.name().as_str());
    }

    #[test]
    fn envelope_puts_kind_and_payload_beside_run_id() {
        let envelope = EventEnvelope {
            run_id: "r".into(),
            seq: 1,
            ts: "2026-10-23T08:00:00.000Z".into(),
            kind: EventKind::ThoughtChunk {
                text: "想一下".into(),
            },
        };
        let value = serde_json::to_value(&envelope).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "run_id": "r",
                "seq": 1,
                "ts": "2026-10-23T08:00:00.000Z",
                "kind": "thought_chunk",
                "text": "想一下",
            })
        );
    }
}
