//! Review Gate 用的整份 diff：Worktree 目前的內容（含未 commit 與未追蹤的檔案）相對於 base commit。
//! 每個檔案帶完整的新舊內容（C1 的 Monaco DiffEditor 需要），大檔由 outbox 改成 blob。

use std::path::Path;

use orbis_protocol::event::TextBody;

use crate::contract::{FileChange, RunDiff, RunDiffFile};
use crate::git::{Git, GitError};
use crate::secrets::Redactor;

/// 二進位檔案的替代文字。
const BINARY_PLACEHOLDER: &str = "[二進位檔案]";

/// 計算 Worktree 相對於 `base_commit` 的 diff。
pub async fn run_diff(
    worktree: &Path,
    base_commit: &str,
    redactor: &Redactor,
) -> Result<RunDiff, GitError> {
    let git = Git::new(worktree);
    // 先把未追蹤的檔案以 intent-to-add 加入 index，讓 rename 偵測也涵蓋它們；
    // 不會改變檔案內容，`git add -A` 時也會正常處理。
    let untracked = git
        .run(["ls-files", "--others", "--exclude-standard", "-z"])
        .await?;
    let untracked: Vec<&str> = untracked.split('\0').filter(|p| !p.is_empty()).collect();
    if !untracked.is_empty() {
        let mut args = vec!["add", "--intent-to-add", "--"];
        args.extend(untracked.iter().copied());
        git.run(args).await?;
    }
    let raw = git
        .run_raw([
            "diff",
            "--name-status",
            "-z",
            "-M",
            "--no-ext-diff",
            base_commit,
        ])
        .await?;
    let mut files = Vec::new();
    let mut parts = raw.split('\0').filter(|p| !p.is_empty());
    while let Some(status) = parts.next() {
        let code = status.chars().next().unwrap_or('M');
        let (change, old_path, path) = match code {
            'R' | 'C' => {
                let old = parts.next().unwrap_or_default().to_owned();
                let new = parts.next().unwrap_or_default().to_owned();
                (FileChange::Renamed, Some(old), new)
            }
            'A' => (
                FileChange::Added,
                None,
                parts.next().unwrap_or_default().to_owned(),
            ),
            'D' => (
                FileChange::Deleted,
                None,
                parts.next().unwrap_or_default().to_owned(),
            ),
            _ => (
                FileChange::Modified,
                None,
                parts.next().unwrap_or_default().to_owned(),
            ),
        };
        if path.is_empty() {
            continue;
        }
        let old_source = old_path.as_deref().unwrap_or(&path);
        let old = match change {
            FileChange::Added => None,
            _ => Some(match git.show_file(base_commit, old_source).await? {
                Some(text) => body(&text, redactor),
                None => TextBody::Inline {
                    text: String::new(),
                },
            }),
        };
        let new = match change {
            FileChange::Deleted => None,
            _ => Some(match std::fs::read(worktree.join(&path)) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) if !text.contains('\0') => body(&text, redactor),
                    _ => TextBody::Inline {
                        text: BINARY_PLACEHOLDER.into(),
                    },
                },
                Err(_) => TextBody::Inline {
                    text: String::new(),
                },
            }),
        };
        files.push(RunDiffFile {
            path,
            old_path,
            change,
            old,
            new,
        });
    }
    Ok(RunDiff {
        base_commit: base_commit.to_owned(),
        files,
    })
}

fn body(text: &str, redactor: &Redactor) -> TextBody {
    if text.contains('\0') {
        return TextBody::Inline {
            text: BINARY_PLACEHOLDER.into(),
        };
    }
    TextBody::Inline {
        text: redactor.redact(text),
    }
}
