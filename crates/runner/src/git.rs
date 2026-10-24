//! 執行 git CLI。一律關閉互動式提示（§6.4），並辨識 Git for Windows 的長路徑錯誤。
//!
//! - Windows 上一律加 `-c core.longpaths=true`：Worktree 根目錄雖然很短，Repo 內的深層路徑加起來
//!   仍可能超過 260 字元；Git for Windows 預設會以「Filename too long」失敗。
//! - [`check_native_git`]：PATH 上的 git 必須是 Windows 的 git（Git for Windows）。WSL 的 git
//!   （或 `wsl git` 的包裝）看到的是 Linux 的路徑，沒辦法在 Windows 的 Worktree 上工作。

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
        let spec = ProcessSpec::new("git");
        let spec = if cfg!(windows) {
            spec.args(["-c", "core.longpaths=true"])
        } else {
            spec
        };
        spec.args(args)
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

/// PATH 上的 git 不是 Windows 的 git（例如 WSL 的 git）時的錯誤。
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct NotNativeGit(pub String);

/// Windows 上確認 `git` 是 Git for Windows：`git --exec-path` 要是磁碟代號開頭的 Windows 路徑。
/// WSL 的 git（或呼叫 `wsl git` 的包裝腳本）回的是 `/usr/lib/git-core` 這類 Linux 路徑。
/// 其他平台一律通過。
pub async fn check_native_git() -> anyhow::Result<()> {
    check_native_git_with("git").await
}

/// 同 [`check_native_git`]，`program` 指定要檢查的 git 執行檔（測試用）。
pub async fn check_native_git_with(program: &str) -> anyhow::Result<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    let spec = ProcessSpec::new(program).args(["--exec-path"]);
    let output = process::run(&spec).await.map_err(|e| {
        NotNativeGit(format!(
            "找不到可用的 git（{e:#}）：Windows 上的 Runner 需要 Git for Windows，請安裝並確認 git 在 PATH 上"
        ))
    })?;
    if !output.success() {
        return Err(NotNativeGit(format!(
            "git --exec-path 失敗：{}",
            output.combined().trim()
        ))
        .into());
    }
    let exec_path = output.stdout.trim().to_owned();
    if is_windows_path(&exec_path) {
        return Ok(());
    }
    Err(NotNativeGit(format!(
        "PATH 上的 git 不是 Windows 的 git（exec-path 是 {exec_path}），可能是 WSL 的 git 或 `wsl git` 的包裝。\
Windows 上的 Runner 需要 Git for Windows：請安裝它並放到 PATH 中 WSL 之前；\
Repo 在 WSL 的檔案系統中時，請改在 WSL 中執行 Runner"
    ))
    .into())
}

/// `C:\…`、`C:/…`、`\\?\C:\…`：Windows 的絕對路徑。
fn is_windows_path(path: &str) -> bool {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(drive), Some(':'), Some('\\' | '/')) if drive.is_ascii_alphabetic()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 辨識_windows_路徑() {
        assert!(is_windows_path(r"C:\Program Files\Git\mingw64\libexec\git-core"));
        assert!(is_windows_path("C:/Program Files/Git/mingw64/libexec/git-core"));
        assert!(is_windows_path(r"\\?\D:\x"));
        assert!(!is_windows_path("/usr/lib/git-core"));
        assert!(!is_windows_path("/mnt/c/Program Files/Git"));
        assert!(!is_windows_path(""));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn wsl_的_git_會被拒絕_git_for_windows_通過() {
        check_native_git().await.unwrap();
        // 假的 git：回 Linux 的 exec-path（`wsl git` 包裝的行為）。
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("git.cmd");
        std::fs::write(&fake, "@echo /usr/lib/git-core\r\n").unwrap();
        let err = check_native_git_with(&fake.to_string_lossy())
            .await
            .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("WSL") && text.contains("/usr/lib/git-core"), "{text}");
        assert!(err.downcast_ref::<NotNativeGit>().is_some());
    }

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
