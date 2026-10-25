//! 換 Agent 的交接 prompt（ARCHITECTURE §7、ADR-0016）。
//!
//! Runner 依固定格式組出交接 prompt，依序是：
//! 1. Task 的規格與驗收條件（Server 在 `switch_agent` 的 `handoff` 中提供）
//! 2. 人送出的所有 prompt（依時間）
//! 3. Agent 每個回合最後的回覆
//! 4. 目前的計畫
//! 5. diff 摘要：改了哪些檔案、各增減幾行（細節請新的 Agent 自己讀 Worktree）
//! 6. 還沒處理的審查留言（Server 提供）
//!
//! 2–4 取自 Run 的歷史（[`History`]）。歷史隨 Run 的 Worktree 紀錄存在狀態目錄（`run-history/`），
//! Runner 重新啟動後仍然完整，Worktree 封存時一起刪除；Run 改派到另一台 Runner 時那台沒有這份歷史。
//! 不請舊的 Agent 寫摘要：會想換 Agent 的時候，舊的 Agent 常常已經不能用。

use orbis_protocol::control::HandoffContext;
use orbis_protocol::enums::{AcceptanceCriterionKind, PromptSource};
use orbis_protocol::event::{ContentBlock, PlanEntry, PlanEntryStatus};
use serde::{Deserialize, Serialize};

/// 一個 Run 中交接 prompt 用得到的歷史。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct History {
    /// 交給 Agent 的 prompt（依時間，含 Runner 自己產生的；組交接 prompt 時只取人送出的）。
    #[serde(default)]
    pub prompts: Vec<HistoryPrompt>,
    /// Agent 每個回合最後的回覆（`final_message`），依時間。
    #[serde(default)]
    pub replies: Vec<String>,
    /// 最新的 `plan_proposed` 全文。
    #[serde(default)]
    pub plan_proposed: Option<String>,
    /// 最新的 `plan`（待辦清單），已轉成文字。
    #[serde(default)]
    pub plan_entries: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryPrompt {
    pub source: PromptSource,
    pub text: String,
}

impl History {
    pub fn record_prompt(&mut self, blocks: &[ContentBlock], source: PromptSource) {
        self.prompts.push(HistoryPrompt {
            source,
            text: blocks_text(blocks),
        });
    }

    pub fn record_reply(&mut self, text: &str) {
        self.replies.push(text.to_owned());
    }

    pub fn record_plan_entries(&mut self, entries: &[PlanEntry]) {
        let text = entries
            .iter()
            .map(|e| {
                let mark = match e.status {
                    PlanEntryStatus::Completed => "x",
                    PlanEntryStatus::InProgress => "~",
                    PlanEntryStatus::Pending => " ",
                };
                format!("- [{mark}] {}", e.content)
            })
            .collect::<Vec<_>>()
            .join("\n");
        self.plan_entries = Some(text);
    }
}

/// prompt 的內容轉成文字：圖片與其他附件寫成說明。
fn blocks_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text.clone(),
            ContentBlock::Image(blob) => format!("（圖片：{}）", blob.media_type),
            ContentBlock::ResourceLink { uri, name } => format!("（連結：{name} {uri}）"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 人送出的 prompt（交接 prompt 的第 2 段）：Runner 自己產生的、Server 自動產生的（Verification 重試、
/// CI 失敗）與 Child Run 的提問不算。
fn from_human(source: PromptSource) -> bool {
    matches!(
        source,
        PromptSource::User
            | PromptSource::PlanGate
            | PromptSource::ReviewGate
            | PromptSource::FeedbackReview
    )
}

fn source_label(source: PromptSource) -> &'static str {
    match source {
        PromptSource::User => "訊息",
        PromptSource::PlanGate => "Plan Gate 退回",
        PromptSource::ReviewGate => "Review Gate 退回",
        PromptSource::FeedbackReview => "PR review",
        _ => "其他",
    }
}

/// diff 摘要中的一個檔案。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    pub path: String,
    /// 增減行數；二進位檔案為 `None`。
    pub lines: Option<(u64, u64)>,
    /// 還沒加入 git 的新檔案。
    pub untracked: bool,
}

/// 組出交接 prompt。`task_spec` 是 Task 規格的文字（Server 給的是 blob 時，呼叫端先下載）。
pub fn prompt(
    from_agent: &str,
    context: &HandoffContext,
    task_spec: &str,
    history: &History,
    changes: &[ChangedFile],
) -> String {
    let mut out = String::new();
    let mut section = |title: &str, body: String| {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str("## ");
        out.push_str(title);
        out.push('\n');
        out.push_str(body.trim_end());
    };
    let none = || "（沒有）".to_owned();
    section(
        "交接",
        format!(
            "這個 Run 原本由 {from_agent} 執行，現在換你接手，繼續同一個 Worktree 中的工作。以下是到目前為止的脈絡；請先檢查 Worktree 的現況再繼續，不要從頭開始。"
        ),
    );
    section(
        "Task 的規格",
        if task_spec.trim().is_empty() {
            none()
        } else {
            task_spec.to_owned()
        },
    );
    section(
        "驗收條件",
        if context.acceptance_criteria.is_empty() {
            none()
        } else {
            context
                .acceptance_criteria
                .iter()
                .map(|c| {
                    let kind = match c.kind {
                        AcceptanceCriterionKind::Command => "指令",
                        AcceptanceCriterionKind::Agent => "Agent 判定",
                        AcceptanceCriterionKind::Browser => "瀏覽器",
                        AcceptanceCriterionKind::Manual => "人工",
                    };
                    match &c.command {
                        Some(command) => format!("- （{kind}）{}：`{command}`", c.description),
                        None => format!("- （{kind}）{}", c.description),
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        },
    );
    let prompts: Vec<String> = history
        .prompts
        .iter()
        .filter(|p| from_human(p.source))
        .enumerate()
        .map(|(i, p)| format!("{}. （{}）{}", i + 1, source_label(p.source), p.text.trim()))
        .collect();
    section(
        "人送出的 prompt（依時間）",
        if prompts.is_empty() {
            none()
        } else {
            prompts.join("\n")
        },
    );
    let replies: Vec<String> = history
        .replies
        .iter()
        .filter(|r| !r.trim().is_empty())
        .enumerate()
        .map(|(i, r)| format!("{}. {}", i + 1, r.trim()))
        .collect();
    section(
        "Agent 每個回合最後的回覆（依時間）",
        if replies.is_empty() {
            none()
        } else {
            replies.join("\n")
        },
    );
    section(
        "目前的計畫",
        history
            .plan_proposed
            .clone()
            .or_else(|| history.plan_entries.clone())
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(none),
    );
    let files: Vec<String> = changes
        .iter()
        .map(|f| match (f.lines, f.untracked) {
            (None, _) => format!("- {}（二進位）", f.path),
            (Some((added, _)), true) => format!("- {}（新檔案，+{added}）", f.path),
            (Some((added, removed)), false) => format!("- {}（+{added} −{removed}）", f.path),
        })
        .collect();
    section(
        "目前的變更（相對 base commit）",
        if files.is_empty() {
            none()
        } else {
            format!("{}\n細節請直接讀 Worktree 中的檔案。", files.join("\n"))
        },
    );
    let comments: Vec<String> = context
        .review_comments
        .iter()
        .map(|c| {
            let at = match (&c.path, c.line, &c.url) {
                (Some(path), Some(line), _) => format!("`{path}:{line}`"),
                (Some(path), None, _) => format!("`{path}`"),
                (None, _, Some(url)) => format!("預覽 {url}"),
                (None, _, None) => "整體".to_owned(),
            };
            format!("- {at}：{}", c.body.trim())
        })
        .collect();
    section(
        "還沒處理的審查留言",
        if comments.is_empty() {
            none()
        } else {
            comments.join("\n")
        },
    );
    out.push('\n');
    out
}

/// 解析 `git diff --numstat` 的輸出（`<增>\t<減>\t<路徑>`，二進位是 `-\t-\t<路徑>`）。
pub fn parse_numstat(text: &str) -> Vec<ChangedFile> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let added = parts.next()?;
            let removed = parts.next()?;
            let path = parts.next()?.to_owned();
            let lines = match (added.parse::<u64>(), removed.parse::<u64>()) {
                (Ok(a), Ok(r)) => Some((a, r)),
                _ => None,
            };
            Some(ChangedFile {
                path,
                lines,
                untracked: false,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析_numstat() {
        let files = parse_numstat("3\t1\tsrc/a.rs\n-\t-\timg.png\n");
        assert_eq!(
            files,
            [
                ChangedFile {
                    path: "src/a.rs".into(),
                    lines: Some((3, 1)),
                    untracked: false
                },
                ChangedFile {
                    path: "img.png".into(),
                    lines: None,
                    untracked: false
                },
            ]
        );
    }

    #[test]
    fn 只取人送出的_prompt() {
        let mut history = History::default();
        let text = |t: &str| vec![ContentBlock::Text { text: t.into() }];
        history.record_prompt(&text("第一個"), PromptSource::User);
        history.record_prompt(&text("請繼續"), PromptSource::VerificationRetry);
        history.record_prompt(&text("交接"), PromptSource::Handoff);
        history.record_prompt(&text("改一下"), PromptSource::ReviewGate);
        let context = HandoffContext {
            task_spec: orbis_protocol::event::TextBody::Inline {
                text: String::new(),
            },
            acceptance_criteria: Vec::new(),
            review_comments: Vec::new(),
        };
        let out = prompt("a", &context, "", &history, &[]);
        assert!(out.contains("1. （訊息）第一個"), "{out}");
        assert!(out.contains("2. （Review Gate 退回）改一下"), "{out}");
        assert!(!out.contains("請繼續"));
    }
}
