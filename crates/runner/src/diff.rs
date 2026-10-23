//! Review Gate 用的整份 diff：Worktree 目前的內容（含未 commit 與未追蹤的檔案）相對於 base commit。
//! 每個檔案帶完整的新舊內容（C1 的 Monaco DiffEditor 需要），大檔由 outbox 改成 blob。

use std::path::Path;

use orbis_protocol::event::TextBody;

use crate::git::{Git, GitError};
use crate::secrets::Redactor;
use orbis_protocol::event::{FileChange, RunDiff, RunDiffFile};

/// 一邊（修改前或修改後）的內容。
enum Content {
    Text(TextBody),
    /// 二進位檔案：`binary` 為 `true`，新舊內容一律為 `null`。
    Binary,
}

/// 計算 Worktree 相對於 `base_commit` 的 diff。
///
/// `local_only` 是只在本機使用的路徑（`copy` 進來的檔案、`shared_dirs` 的連結），不列入 diff，
/// 也不會被加進 index。
pub async fn run_diff(
    worktree: &Path,
    base_commit: &str,
    redactor: &Redactor,
    local_only: &[String],
) -> Result<RunDiff, GitError> {
    let git = Git::new(worktree);
    let excludes: Vec<String> = local_only
        .iter()
        .map(|p| format!(":(exclude,literal){p}"))
        .collect();
    // 先把未追蹤的檔案以 intent-to-add 加入 index，讓 rename 偵測也涵蓋它們；
    // 不會改變檔案內容，`git add -A` 時也會正常處理。
    let mut ls: Vec<String> = [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
    ]
    .map(String::from)
    .to_vec();
    ls.extend(excludes.iter().cloned());
    let untracked = git.run(ls).await?;
    let untracked: Vec<&str> = untracked.split('\0').filter(|p| !p.is_empty()).collect();
    if !untracked.is_empty() {
        let mut args = vec!["add", "--intent-to-add", "--"];
        args.extend(untracked.iter().copied());
        git.run(args).await?;
    }
    let mut diff_args: Vec<String> = ["diff", "--name-status", "-z", "-M", "--no-ext-diff"]
        .map(String::from)
        .to_vec();
    diff_args.extend([base_commit.to_owned(), "--".into(), ".".into()]);
    diff_args.extend(excludes);
    let raw = git.run_raw(diff_args).await?;
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
                None => Content::Text(TextBody::Inline {
                    text: String::new(),
                }),
            }),
        };
        let new = match change {
            FileChange::Deleted => None,
            _ => Some(read_worktree_file(worktree, &path, redactor)),
        };
        let binary = [&old, &new]
            .into_iter()
            .any(|side| matches!(side, Some(Content::Binary)));
        let text = |side: Option<Content>| match side {
            Some(Content::Text(body)) if !binary => Some(body),
            _ => None,
        };
        files.push(RunDiffFile {
            path,
            old_path,
            change,
            binary,
            old: text(old),
            new: text(new),
        });
    }
    Ok(RunDiff {
        base_commit: base_commit.to_owned(),
        files,
    })
}

/// 讀 Worktree 中檔案的新內容，不跟著連結讀到 Worktree 以外：
/// symlink 回報連結目標（和 git 記錄的內容一樣），解開後落在 Worktree 外的路徑不讀。
fn read_worktree_file(worktree: &Path, path: &str, redactor: &Redactor) -> Content {
    let full = worktree.join(path);
    if let Ok(meta) = std::fs::symlink_metadata(&full)
        && meta.file_type().is_symlink()
    {
        let target = std::fs::read_link(&full)
            .map(|t| t.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Content::Text(TextBody::Inline {
            text: redactor.redact(&target),
        });
    }
    if !crate::paths::is_within(
        &crate::paths::resolve_existing(&full),
        &crate::paths::canonical(worktree),
    ) {
        return Content::Text(TextBody::Inline {
            text: OUTSIDE_PLACEHOLDER.into(),
        });
    }
    match std::fs::read(&full) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => body(&text, redactor),
            Err(_) => Content::Binary,
        },
        Err(_) => Content::Text(TextBody::Inline {
            text: String::new(),
        }),
    }
}

/// 經由連結指向 Worktree 以外的檔案的替代文字。
const OUTSIDE_PLACEHOLDER: &str = "[指向 Worktree 以外的連結，不讀取內容]";

fn body(text: &str, redactor: &Redactor) -> Content {
    if text.contains('\0') {
        return Content::Binary;
    }
    Content::Text(TextBody::Inline {
        text: redactor.redact(text),
    })
}
