//! 本機 Repo 的本機合併與 Repo Spec 提交（ARCHITECTURE §5、§12.1、ADR-0013）。
//!
//! 兩者都在本機 checkout 的基準分支上操作，位置的規則相同：
//! - 基準分支沒有簽出：在 `<Worktree 根目錄>/<repo>/.merge-<短 id>` 開暫時的 worktree 簽出基準分支，
//!   做完（成功或失敗）就刪除。
//! - 基準分支簽出在 checkout（或它的某個 worktree）而且乾淨：直接在那裡操作。
//! - 簽出而且有未 commit 的變更（不含未追蹤的檔案）：不操作，回 [`LocalError::Dirty`]。
//!
//! commit 使用 checkout 自己的 git 設定與 hook（不加 `--no-verify`）。

use std::path::{Path, PathBuf};

use orbis_protocol::enums::LocalMergeStrategy;

use crate::git::Git;

/// 不能在基準分支上操作。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LocalError {
    /// 基準分支簽出的位置有未 commit 的變更；內容是 `git status` 的輸出。
    #[error("基準分支 {base} 簽出在 {path}，工作目錄有未 commit 的變更：\n{status}")]
    Dirty {
        base: String,
        path: String,
        status: String,
    },
    /// 合併衝突（已還原）；內容是 git 的輸出。
    #[error("合併 {branch} 到 {base} 時發生衝突，已還原：\n{output}")]
    Conflict {
        branch: String,
        base: String,
        output: String,
    },
    /// 其他 git 操作失敗。
    #[error("{0}")]
    Failed(String),
}

impl From<crate::git::GitError> for LocalError {
    fn from(e: crate::git::GitError) -> Self {
        Self::Failed(e.to_string())
    }
}

/// 在哪裡操作基準分支。
struct Target {
    dir: PathBuf,
    /// 暫時的 worktree（做完要刪）。
    temporary: bool,
}

/// `git worktree list --porcelain` 中簽出 `refs/heads/<base>` 的 worktree。
fn checked_out_at(listing: &str, base: &str) -> Option<PathBuf> {
    let wanted = format!("branch refs/heads/{base}");
    let mut current: Option<&str> = None;
    for line in listing.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current = Some(path);
        } else if line == wanted {
            return current.map(PathBuf::from);
        }
    }
    None
}

/// 找出（或建立）操作基準分支的位置。
async fn prepare(checkout: &Path, temp_root: &Path, base: &str) -> Result<Target, LocalError> {
    let git = Git::new(checkout);
    let listing = git.run(["worktree", "list", "--porcelain"]).await?;
    if let Some(dir) = checked_out_at(&listing, base) {
        let dir = crate::paths::normalize(&dir);
        let status = Git::new(&dir)
            .run(["status", "--porcelain", "--untracked-files=no"])
            .await?;
        if !status.trim().is_empty() {
            return Err(LocalError::Dirty {
                base: base.to_owned(),
                path: dir.display().to_string(),
                status: status.trim_end().to_owned(),
            });
        }
        return Ok(Target {
            dir,
            temporary: false,
        });
    }
    std::fs::create_dir_all(temp_root)
        .map_err(|e| LocalError::Failed(format!("無法建立 {}：{e}", temp_root.display())))?;
    let dir = temp_root.join(format!(
        ".merge-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    git.run(["worktree", "add", "--", &dir.to_string_lossy(), base])
        .await?;
    Ok(Target {
        dir: crate::paths::normalize(&dir),
        temporary: true,
    })
}

/// 刪掉暫時的 worktree（失敗只記 log：之後的 `git worktree prune` 會清掉紀錄）。
async fn cleanup(checkout: &Path, target: &Target) {
    if !target.temporary {
        return;
    }
    let git = Git::new(checkout);
    if let Err(e) = git
        .run([
            "worktree",
            "remove",
            "--force",
            &target.dir.to_string_lossy(),
        ])
        .await
    {
        tracing::warn!(dir = %target.dir.display(), error = %e, "無法刪除暫時的 worktree");
        let _ = std::fs::remove_dir_all(&target.dir);
        let _ = git.run(["worktree", "prune"]).await;
    }
}

/// 把 `branch` 合併到 `base`（squash 或 merge commit），回傳合併後基準分支的 HEAD。
pub async fn merge(
    checkout: &Path,
    temp_root: &Path,
    base: &str,
    branch: &str,
    strategy: LocalMergeStrategy,
    message: &str,
) -> Result<String, LocalError> {
    let target = prepare(checkout, temp_root, base).await?;
    let result = merge_in(&target.dir, base, branch, strategy, message).await;
    cleanup(checkout, &target).await;
    result
}

async fn merge_in(
    dir: &Path,
    base: &str,
    branch: &str,
    strategy: LocalMergeStrategy,
    message: &str,
) -> Result<String, LocalError> {
    let git = Git::new(dir);
    let merged = match strategy {
        // 分支名稱由 Server 產生，建立 Worktree 時已檢查不會被當成選項。
        LocalMergeStrategy::Squash => git.run(["merge", "--squash", branch]).await,
        LocalMergeStrategy::Merge => git.run(["merge", "--no-ff", "-m", message, branch]).await,
    };
    if let Err(e) = merged {
        // 還原：merge commit 有 MERGE_HEAD，squash 沒有。
        if git
            .succeeds(["rev-parse", "-q", "--verify", "MERGE_HEAD"])
            .await
        {
            let _ = git.run(["merge", "--abort"]).await;
        } else {
            let _ = git.run(["reset", "--merge"]).await;
        }
        return Err(LocalError::Conflict {
            branch: branch.to_owned(),
            base: base.to_owned(),
            output: e.message,
        });
    }
    if strategy == LocalMergeStrategy::Squash {
        if git.succeeds(["diff", "--cached", "--quiet"]).await {
            return Err(LocalError::Failed(format!(
                "{branch} 沒有 {base} 上還沒有的變更"
            )));
        }
        if let Err(e) = git.run(["commit", "-m", message]).await {
            let _ = git.run(["reset", "--merge"]).await;
            return Err(e.into());
        }
    }
    Ok(git.rev_parse_commit("HEAD").await?)
}

/// checkout 有 `origin` 時 push 基準分支。沒有 `origin` 時回傳 `Ok(false)`。
pub async fn push_base(checkout: &Path, base: &str) -> Result<bool, String> {
    let git = Git::new(checkout);
    if !git.succeeds(["remote", "get-url", "origin"]).await {
        return Ok(false);
    }
    git.run([
        "push",
        "origin",
        &format!("refs/heads/{base}:refs/heads/{base}"),
    ])
    .await
    .map(|_| true)
    .map_err(|e| e.to_string())
}

/// Repo Spec 提交的結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecCommit {
    Committed(String),
    /// 內容和基準分支上的檔案相同；值是基準分支目前的 HEAD。
    Unchanged(String),
}

/// Repo Spec 的路徑只能是 `.github/` 以外的 `.md` 檔（Server 已檢查，Runner 再檢查一次），
/// 回傳以 `/` 分隔的相對路徑。
pub fn spec_path(raw: &str) -> Result<String, String> {
    let path = crate::repo_config::literal_relative_path(raw)?;
    if !path.to_ascii_lowercase().ends_with(".md") {
        return Err(format!("{raw} 不是 .md 檔"));
    }
    if path
        .split('/')
        .next()
        .is_some_and(|first| first.eq_ignore_ascii_case(".github"))
    {
        return Err(format!("{raw} 在 .github/ 之下"));
    }
    Ok(path)
}

/// 把 `content` 寫進基準分支的 `path` 並 commit（ARCHITECTURE §12.1）。`path` 已經過 [`spec_path`]。
pub async fn commit_file(
    checkout: &Path,
    temp_root: &Path,
    base: &str,
    path: &str,
    content: &str,
    message: &str,
) -> Result<SpecCommit, LocalError> {
    let target = prepare(checkout, temp_root, base).await?;
    let result = commit_in(&target.dir, path, content, message).await;
    cleanup(checkout, &target).await;
    result
}

async fn commit_in(
    dir: &Path,
    path: &str,
    content: &str,
    message: &str,
) -> Result<SpecCommit, LocalError> {
    let git = Git::new(dir);
    let file = dir.join(path);
    let parent = file.parent().unwrap_or(dir);
    // 不跟著連結寫到 checkout 以外：建立目錄之前，先確認已經存在的每一層（含檔案本身）都不是
    // symlink／junction，之後才建立不存在的目錄。
    let mut current = dir.to_path_buf();
    for part in path.split('/') {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(LocalError::Failed(format!(
                    "{path} 經由連結指向 checkout 以外"
                )));
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    std::fs::create_dir_all(parent)
        .map_err(|e| LocalError::Failed(format!("無法建立 {}：{e}", parent.display())))?;
    if !crate::paths::is_within(
        &crate::paths::canonical(parent),
        &crate::paths::canonical(dir),
    ) {
        return Err(LocalError::Failed(format!(
            "{path} 經由連結指向 checkout 以外"
        )));
    }
    let previous = std::fs::read(&file).ok();
    std::fs::write(&file, content)
        .map_err(|e| LocalError::Failed(format!("無法寫入 {path}：{e}")))?;
    let restore = || match &previous {
        Some(bytes) => {
            let _ = std::fs::write(&file, bytes);
        }
        None => {
            let _ = std::fs::remove_file(&file);
        }
    };
    if let Err(e) = git.run(["add", "--", path]).await {
        restore();
        return Err(e.into());
    }
    if git
        .succeeds(["diff", "--cached", "--quiet", "--", path])
        .await
    {
        return Ok(SpecCommit::Unchanged(git.rev_parse_commit("HEAD").await?));
    }
    if let Err(e) = git.run(["commit", "-m", message, "--", path]).await {
        let _ = git.run(["reset", "-q", "--", path]).await;
        restore();
        return Err(e.into());
    }
    Ok(SpecCommit::Committed(git.rev_parse_commit("HEAD").await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 找出簽出基準分支的_worktree() {
        let listing = "worktree D:/code/web\nHEAD abc\nbranch refs/heads/main\n\nworktree D:/wt/feature\nHEAD def\nbranch refs/heads/feature/x\n\nworktree D:/tmp/detached\nHEAD 123\ndetached\n";
        assert_eq!(
            checked_out_at(listing, "main"),
            Some(PathBuf::from("D:/code/web"))
        );
        assert_eq!(
            checked_out_at(listing, "feature/x"),
            Some(PathBuf::from("D:/wt/feature"))
        );
        assert_eq!(checked_out_at(listing, "dev"), None);
        assert_eq!(checked_out_at(listing, "mai"), None, "要完整比對分支名稱");
    }

    /// 建立目錄連結：Windows 用 junction（不需要權限），其他平台用 symlink。
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd.exe")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(status.status.success(), "{status:?}");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// Repo Spec 的路徑經過 checkout 中的目錄連結時拒絕，也不在外面建立任何目錄（安全審查的發現）。
    #[tokio::test]
    async fn repo_spec_不經由目錄連結寫到_checkout_以外() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        Git::new(&repo).run(["init", "-q"]).await.unwrap();
        link_dir(&outside, &repo.join("docs"));
        let error = commit_in(&repo, "docs/deep/spec.md", "# x\n", "m")
            .await
            .unwrap_err();
        assert!(matches!(error, LocalError::Failed(_)), "{error}");
        assert!(!outside.join("deep").exists(), "不可以在外面建立目錄");
    }

    #[test]
    fn repo_spec_只接受_github_以外的_md() {
        assert_eq!(spec_path("docs/spec.md").unwrap(), "docs/spec.md");
        assert_eq!(spec_path("README.MD").unwrap(), "README.MD");
        for bad in [
            "../x.md",
            "/abs.md",
            "docs/a.txt",
            ".github/a.md",
            ".GitHub/x/y.md",
            "C:/x.md",
        ] {
            assert!(spec_path(bad).is_err(), "{bad}");
        }
    }
}
