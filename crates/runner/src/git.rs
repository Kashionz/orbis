//! 執行 git CLI。一律關閉互動式提示（§6.4），並辨識 Git for Windows 的長路徑錯誤。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use orbis_protocol::event::RunErrorCode;

use crate::process::{self, ProcessSpec};

/// git 操作失敗。
#[derive(Debug, Clone, thiserror::Error)]
#[error("{command} 失敗：{message}")]
pub struct GitError {
    pub command: String,
    pub message: String,
    /// 錯誤代碼：長路徑錯誤為 `path_too_long`，其他為 `git_failed`。
    pub code: RunErrorCode,
}

impl GitError {
    fn new(command: String, message: String) -> Self {
        let code = if is_path_too_long(&message) {
            RunErrorCode::PathTooLong
        } else {
            RunErrorCode::GitFailed
        };
        Self {
            command,
            message,
            code,
        }
    }
}

/// git 的輸出是否為 Git for Windows 的「path too long」錯誤（§6.4）。
pub fn is_path_too_long(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("filename too long") || lower.contains("path too long")
}

/// 在 `dir` 執行 git 子指令。
#[derive(Debug, Clone)]
pub struct Git {
    dir: PathBuf,
    env: Vec<(OsString, OsString)>,
}

impl Git {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            env: Vec::new(),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 額外的環境變數（例如測試用的 `GIT_CONFIG_*`）。
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    fn spec<I, S>(&self, args: I) -> ProcessSpec
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        ProcessSpec::new("git")
            .args(args)
            .cwd(&self.dir)
            .unattended_git()
            .envs(self.env.iter().cloned())
    }

    /// 執行並回傳 stdout（去掉結尾換行）；失敗時回傳 [`GitError`]。
    pub async fn run<I, S>(&self, args: I) -> Result<String, GitError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let spec = self.spec(args);
        let display = spec.display();
        let output = process::run(&spec)
            .await
            .map_err(|e| GitError::new(display.clone(), format!("{e:#}")))?;
        if output.success() {
            Ok(output.stdout.trim_end_matches(['\r', '\n']).to_owned())
        } else {
            Err(GitError::new(display, output.combined()))
        }
    }

    /// 執行並回傳 stdout 原樣（不去掉結尾換行，給 `git show` 讀檔案內容用）。
    pub async fn run_raw<I, S>(&self, args: I) -> Result<String, GitError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let spec = self.spec(args);
        let display = spec.display();
        let output = process::run(&spec)
            .await
            .map_err(|e| GitError::new(display.clone(), format!("{e:#}")))?;
        if output.success() {
            Ok(output.stdout)
        } else {
            Err(GitError::new(display, output.combined()))
        }
    }

    /// 指令是否成功（例如 `rev-parse --verify`）。
    pub async fn succeeds<I, S>(&self, args: I) -> bool
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.run(args).await.is_ok()
    }

    /// 解析成 commit SHA。
    pub async fn rev_parse_commit(&self, rev: &str) -> Result<String, GitError> {
        self.run(["rev-parse", "--verify", &format!("{rev}^{{commit}}")])
            .await
    }

    /// 讀取某個 commit 中的檔案；檔案不存在時回傳 `None`。
    pub async fn show_file(&self, commit: &str, path: &str) -> Result<Option<String>, GitError> {
        let spec = format!("{commit}:{path}");
        if !self.succeeds(["cat-file", "-e", &spec]).await {
            return Ok(None);
        }
        self.run_raw(["show", &spec]).await.map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 辨識長路徑錯誤() {
        assert!(is_path_too_long(
            "error: unable to create file a/b/c.txt: Filename too long"
        ));
        assert!(is_path_too_long("fatal: path too long"));
        assert!(!is_path_too_long("fatal: not a git repository"));
        assert_eq!(
            GitError::new("git x".into(), "Filename too long".into()).code,
            RunErrorCode::PathTooLong
        );
        assert_eq!(
            GitError::new("git x".into(), "nope".into()).code,
            RunErrorCode::GitFailed
        );
    }
}
