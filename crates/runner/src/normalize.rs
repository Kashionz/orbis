//! 把 ACP 的 `session/update` 轉成協定的 Event（ARCHITECTURE §7「對內契約」、§14）。
//!
//! - ACP 型別不外流：只輸出 `orbis_protocol::event` 的型別。
//! - 送出前遮蔽 secret；diff 與位置的路徑改成 Worktree 相對路徑（`/` 分隔）。
//! - 大型 `TextBody` 改成 blob 由 [`crate::outbox`] 處理；這裡只截斷沒辦法放 blob 的純文字。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1 as acp;
use orbis_protocol::event::{
    ContentBlock, Cost, EventKind, PermissionOption, PermissionOptionKind, PlanEntry,
    PlanEntryPriority, PlanEntryStatus, TextBody, ToolCall, ToolCallContent, ToolCallLocation,
    ToolCallStatus, ToolKind, Usage,
};

use crate::paths;
use crate::secrets::Redactor;

/// 純文字內容（沒辦法改放 blob 的欄位）的上限，超過就截斷。
pub const MAX_PLAIN_TEXT: usize = 64 * 1024;

/// 一個 Run 的正規化狀態。
#[derive(Debug)]
pub struct Normalizer {
    worktree: PathBuf,
    redactor: Redactor,
    /// 已送出建立 Event 的 tool call。
    tool_calls: HashSet<String>,
}

impl Normalizer {
    pub fn new(worktree: impl Into<PathBuf>, redactor: Redactor) -> Self {
        Self {
            worktree: worktree.into(),
            redactor,
            tool_calls: HashSet::new(),
        }
    }

    pub fn redactor(&self) -> &Redactor {
        &self.redactor
    }

    pub fn redact(&self, text: &str) -> String {
        self.redactor.redact(text)
    }

    /// 一筆 `session/update` 對應的 Event（可能沒有）。
    pub fn session_update(&mut self, update: acp::SessionUpdate) -> Vec<EventKind> {
        match update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => vec![EventKind::MessageChunk {
                content: self.content_block(&chunk.content),
            }],
            acp::SessionUpdate::AgentThoughtChunk(chunk) => vec![EventKind::ThoughtChunk {
                text: self.plain(&block_text(&chunk.content)),
            }],
            acp::SessionUpdate::ToolCall(call) => vec![self.tool_call_created(&call)],
            acp::SessionUpdate::ToolCallUpdate(update) => vec![self.tool_call_updated(&update)],
            acp::SessionUpdate::Plan(plan) => vec![EventKind::Plan {
                entries: plan
                    .entries
                    .iter()
                    .map(|e| PlanEntry {
                        content: self.plain(&e.content),
                        priority: priority(&e.priority),
                        status: plan_status(&e.status),
                    })
                    .collect(),
            }],
            acp::SessionUpdate::UsageUpdate(usage) => vec![EventKind::Usage(Usage {
                input_tokens: None,
                output_tokens: None,
                thought_tokens: None,
                cached_read_tokens: None,
                cached_write_tokens: None,
                context_used_tokens: Some(usage.used),
                context_window_tokens: Some(usage.size),
                cost: usage.cost.as_ref().map(|c| Cost {
                    amount: c.amount,
                    currency: c.currency.clone(),
                }),
            })],
            // 使用者訊息由 Runner 自己送出；指令清單、模式、設定選項等不是 Event。
            other => {
                tracing::trace!(update = ?std::mem::discriminant(&other), "略過的 session/update");
                Vec::new()
            }
        }
    }

    /// 權限請求的 tool call 還沒送過建立 Event 時，先補上（協定要求先送 `tool_call`）。
    pub fn ensure_tool_call(&mut self, call: &acp::ToolCallUpdate) -> Option<EventKind> {
        if self.tool_calls.contains(call.tool_call_id.0.as_ref()) {
            return None;
        }
        Some(self.tool_call_updated(call))
    }

    fn tool_call_created(&mut self, call: &acp::ToolCall) -> EventKind {
        self.tool_calls.insert(call.tool_call_id.0.to_string());
        EventKind::ToolCall(ToolCall {
            tool_call_id: call.tool_call_id.0.to_string().into(),
            title: Some(self.plain(&call.title)),
            tool_kind: Some(tool_kind(call.kind)),
            status: Some(tool_status(call.status)),
            content: non_empty(self.contents(&call.content)),
            locations: non_empty(self.locations(&call.locations)),
        })
    }

    fn tool_call_updated(&mut self, update: &acp::ToolCallUpdate) -> EventKind {
        let id = update.tool_call_id.0.to_string();
        let fields = &update.fields;
        let first = self.tool_calls.insert(id.clone());
        let mut call = ToolCall {
            tool_call_id: id.clone().into(),
            title: fields.title.as_deref().map(|t| self.plain(t)),
            tool_kind: fields.kind.map(tool_kind),
            status: fields.status.map(tool_status),
            content: fields.content.as_deref().map(|c| self.contents(c)),
            locations: fields.locations.as_deref().map(|l| self.locations(l)),
        };
        if first {
            // 第一筆是建立：title、tool_kind、status 必須有值。
            call.title.get_or_insert(id);
            call.tool_kind.get_or_insert(ToolKind::Other);
            call.status.get_or_insert(ToolCallStatus::Pending);
        }
        EventKind::ToolCall(call)
    }

    fn contents(&self, contents: &[acp::ToolCallContent]) -> Vec<ToolCallContent> {
        contents
            .iter()
            .map(|content| match content {
                acp::ToolCallContent::Content(c) => ToolCallContent::Text {
                    text: self.plain(&block_text(&c.content)),
                },
                acp::ToolCallContent::Diff(diff) => ToolCallContent::Diff {
                    path: self.event_path(&diff.path),
                    old: diff.old_text.as_deref().map(|t| self.body(t)),
                    new: Some(self.body(&diff.new_text)),
                },
                acp::ToolCallContent::Terminal(t) => ToolCallContent::Text {
                    text: format!("[terminal {}]", t.terminal_id.0),
                },
                _ => ToolCallContent::Text {
                    text: "[不支援的內容]".into(),
                },
            })
            .collect()
    }

    fn locations(&self, locations: &[acp::ToolCallLocation]) -> Vec<ToolCallLocation> {
        locations
            .iter()
            .map(|l| ToolCallLocation {
                path: self.event_path(&l.path),
                line: l.line,
            })
            .collect()
    }

    fn event_path(&self, path: &Path) -> String {
        paths::display_for_event(path, &self.worktree)
    }

    fn content_block(&self, block: &acp::ContentBlock) -> ContentBlock {
        match block {
            acp::ContentBlock::ResourceLink(link) => ContentBlock::ResourceLink {
                uri: self.redact(&link.uri),
                name: self.plain(&link.name),
            },
            other => ContentBlock::Text {
                text: self.plain(&block_text(other)),
            },
        }
    }

    /// 遮蔽並放進 `TextBody`（大型內容之後由 outbox 改成 blob）。
    fn body(&self, text: &str) -> TextBody {
        TextBody::Inline {
            text: self.redact(text),
        }
    }

    /// 遮蔽並截斷純文字。
    pub fn plain(&self, text: &str) -> String {
        truncate(self.redact(text), MAX_PLAIN_TEXT)
    }
}

/// 權限選項（ACP → 協定）。
pub fn permission_options(options: &[acp::PermissionOption]) -> Vec<PermissionOption> {
    options
        .iter()
        .map(|o| PermissionOption {
            option_id: o.option_id.0.to_string(),
            name: o.name.clone(),
            kind: match o.kind {
                acp::PermissionOptionKind::AllowOnce => PermissionOptionKind::AllowOnce,
                acp::PermissionOptionKind::AllowAlways => PermissionOptionKind::AllowAlways,
                acp::PermissionOptionKind::RejectAlways => PermissionOptionKind::RejectAlways,
                _ => PermissionOptionKind::RejectOnce,
            },
        })
        .collect()
}

fn non_empty<T>(items: Vec<T>) -> Option<Vec<T>> {
    (!items.is_empty()).then_some(items)
}

fn block_text(block: &acp::ContentBlock) -> String {
    match block {
        acp::ContentBlock::Text(t) => t.text.clone(),
        acp::ContentBlock::Image(_) => "[圖片]".into(),
        acp::ContentBlock::Audio(_) => "[音訊]".into(),
        acp::ContentBlock::ResourceLink(link) => format!("[{}]({})", link.name, link.uri),
        acp::ContentBlock::Resource(_) => "[內嵌資源]".into(),
        _ => "[不支援的內容]".into(),
    }
}

/// 截斷到 `max` byte 以內（不切斷 UTF-8 字元），並註明原本的大小。
pub fn truncate(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…（已截斷，原本 {} bytes）", &text[..end], text.len())
}

fn tool_kind(kind: acp::ToolKind) -> ToolKind {
    match kind {
        acp::ToolKind::Read => ToolKind::Read,
        acp::ToolKind::Edit => ToolKind::Edit,
        acp::ToolKind::Delete => ToolKind::Delete,
        acp::ToolKind::Move => ToolKind::Move,
        acp::ToolKind::Search => ToolKind::Search,
        acp::ToolKind::Execute => ToolKind::Execute,
        acp::ToolKind::Think => ToolKind::Think,
        acp::ToolKind::Fetch => ToolKind::Fetch,
        _ => ToolKind::Other,
    }
}

fn tool_status(status: acp::ToolCallStatus) -> ToolCallStatus {
    match status {
        acp::ToolCallStatus::InProgress => ToolCallStatus::InProgress,
        acp::ToolCallStatus::Completed => ToolCallStatus::Completed,
        acp::ToolCallStatus::Failed => ToolCallStatus::Failed,
        _ => ToolCallStatus::Pending,
    }
}

fn priority(p: &acp::PlanEntryPriority) -> PlanEntryPriority {
    match p {
        acp::PlanEntryPriority::High => PlanEntryPriority::High,
        acp::PlanEntryPriority::Low => PlanEntryPriority::Low,
        _ => PlanEntryPriority::Medium,
    }
}

fn plan_status(s: &acp::PlanEntryStatus) -> PlanEntryStatus {
    match s {
        acp::PlanEntryStatus::InProgress => PlanEntryStatus::InProgress,
        acp::PlanEntryStatus::Completed => PlanEntryStatus::Completed,
        _ => PlanEntryStatus::Pending,
    }
}

/// 協定的 prompt 內容轉成 ACP（RunControl `prompt`、DispatchOffer 的第一個 prompt）。
pub fn prompt_to_acp(blocks: &[ContentBlock]) -> Vec<acp::ContentBlock> {
    blocks
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => acp::ContentBlock::from(text.clone()),
            ContentBlock::ResourceLink { uri, name } => {
                acp::ContentBlock::ResourceLink(acp::ResourceLink::new(name.clone(), uri.clone()))
            }
            // TODO(A2)：下載 blob 後以圖片送出（Preview 上的留言截圖）。
            ContentBlock::Image(blob) => acp::ContentBlock::from(format!(
                "[圖片 {}（{}，{} bytes）]",
                blob.blob_id, blob.media_type, blob.size
            )),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use acp::{ContentChunk, Diff, Plan, SessionUpdate, ToolCallUpdateFields, UsageUpdate};

    use super::*;

    fn wt() -> PathBuf {
        std::env::temp_dir().join("wt")
    }

    fn normalizer() -> Normalizer {
        Normalizer::new(wt(), Redactor::new())
    }

    #[test]
    fn 訊息與思考片段() {
        let mut n = normalizer();
        let events = n.session_update(SessionUpdate::AgentMessageChunk(ContentChunk::new(
            acp::ContentBlock::from("你好 ghp_0123456789abcdefghijABCDEFGHIJ012345".to_owned()),
        )));
        let [
            EventKind::MessageChunk {
                content: ContentBlock::Text { text },
            },
        ] = events.as_slice()
        else {
            panic!("{events:?}");
        };
        assert!(text.starts_with("你好"));
        assert!(!text.contains("ghp_"), "要遮蔽 secret：{text}");

        let events = n.session_update(SessionUpdate::AgentThoughtChunk(ContentChunk::new(
            acp::ContentBlock::from("想一下".to_owned()),
        )));
        assert_eq!(
            events,
            [EventKind::ThoughtChunk {
                text: "想一下".into()
            }]
        );
    }

    #[test]
    fn tool_call_的建立與更新_diff_路徑改成相對路徑() {
        let mut n = normalizer();
        let created = n.session_update(SessionUpdate::ToolCall(
            acp::ToolCall::new("t1", "編輯 README")
                .kind(acp::ToolKind::Edit)
                .status(acp::ToolCallStatus::Pending)
                .locations(vec![acp::ToolCallLocation::new(wt().join("README.md"))]),
        ));
        let EventKind::ToolCall(call) = &created[0] else {
            panic!()
        };
        assert_eq!(call.title.as_deref(), Some("編輯 README"));
        assert_eq!(call.tool_kind, Some(ToolKind::Edit));
        assert_eq!(call.locations.as_ref().unwrap()[0].path, "README.md");

        let updated = n.session_update(SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(
            "t1",
            ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .content(vec![acp::ToolCallContent::Diff(
                    Diff::new(wt().join("src").join("a.rs"), "new").old_text(Some("old".into())),
                )]),
        )));
        let EventKind::ToolCall(call) = &updated[0] else {
            panic!()
        };
        assert_eq!(call.title, None, "更新時沒變的欄位為 null");
        assert_eq!(call.status, Some(ToolCallStatus::Completed));
        assert_eq!(
            call.content.as_ref().unwrap()[0],
            ToolCallContent::Diff {
                path: "src/a.rs".into(),
                old: Some(TextBody::Inline { text: "old".into() }),
                new: Some(TextBody::Inline { text: "new".into() }),
            }
        );
    }

    #[test]
    fn 沒見過的_tool_call_更新視為建立() {
        let mut n = normalizer();
        let update = acp::ToolCallUpdate::new("t9", ToolCallUpdateFields::new());
        let Some(EventKind::ToolCall(call)) = n.ensure_tool_call(&update) else {
            panic!()
        };
        assert_eq!(call.title.as_deref(), Some("t9"));
        assert_eq!(call.tool_kind, Some(ToolKind::Other));
        assert_eq!(call.status, Some(ToolCallStatus::Pending));
        assert!(n.ensure_tool_call(&update).is_none(), "已建立過就不再補");
    }

    #[test]
    fn plan_與用量() {
        let mut n = normalizer();
        let events = n.session_update(SessionUpdate::Plan(Plan::new(vec![acp::PlanEntry::new(
            "第一步",
            acp::PlanEntryPriority::High,
            acp::PlanEntryStatus::InProgress,
        )])));
        assert_eq!(
            events,
            [EventKind::Plan {
                entries: vec![PlanEntry {
                    content: "第一步".into(),
                    priority: PlanEntryPriority::High,
                    status: PlanEntryStatus::InProgress,
                }]
            }]
        );
        let events = n.session_update(SessionUpdate::UsageUpdate(
            UsageUpdate::new(1200, 200_000).cost(Some(acp::Cost::new(0.5, "USD"))),
        ));
        let [EventKind::Usage(usage)] = events.as_slice() else {
            panic!()
        };
        assert_eq!(usage.context_used_tokens, Some(1200));
        assert_eq!(usage.context_window_tokens, Some(200_000));
        assert_eq!(usage.cost.as_ref().unwrap().currency, "USD");
        assert_eq!(usage.input_tokens, None, "Agent 沒有回報的項目為 null");
    }

    #[test]
    fn 截斷不會切斷中文字() {
        let text = "測".repeat(10);
        let cut = truncate(text, 7);
        assert!(cut.starts_with("測測"), "{cut}");
        assert!(cut.contains("已截斷"));
    }
}
