//! 執行 `.orbis/config.toml` 中的腳本（setup、archive）用的 shell（ARCHITECTURE §6.3）。
//!
//! - Windows：預設 `cmd`；腳本以 `#!` 開頭而且找得到 Git Bash 時改用 Git Bash。
//! - macOS／Linux：`sh`。

use std::path::{Path, PathBuf};

use crate::process::{self, ProcessSpec};

/// 腳本實際使用的 shell。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shell {
    /// Windows 的 `cmd.exe`。
    Cmd,
    /// Git for Windows 附帶的 bash。
    GitBash(PathBuf),
    /// POSIX `sh`。
    Sh,
}

impl Shell {
    /// 依平台與腳本內容選擇 shell。
    pub fn for_script(script: &str) -> Self {
        if !cfg!(windows) {
            return Self::Sh;
        }
        if script.trim_start().starts_with("#!")
            && let Some(bash) = git_bash()
        {
            return Self::GitBash(bash);
        }
        Self::Cmd
    }

    /// 組出執行 `script` 的程序設定。
    pub fn spec(&self, script: &str) -> ProcessSpec {
        match self {
            // `/s /c "<script>"`：cmd 去掉最外層的引號後原樣執行，腳本內的引號不需要跳脫。
            Self::Cmd => ProcessSpec::new("cmd.exe")
                .args(["/d", "/s", "/c"])
                .raw_tail(format!("\"{script}\"")),
            Self::GitBash(bash) => ProcessSpec::new(bash).args(["-c", script]),
            Self::Sh => ProcessSpec::new("sh").args(["-c", script]),
        }
    }
}

/// 找 Git for Windows 的 `bash.exe`。不用 `PATH` 上的 `bash`，因為那可能是 WSL 的 `bash.exe`。
pub fn git_bash() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let from_git = process::which("git").and_then(|git| git_bash_near(&git));
    from_git.or_else(|| {
        ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .flat_map(|base| {
                [
                    base.join("Git").join("bin").join("bash.exe"),
                    base.join("Programs")
                        .join("Git")
                        .join("bin")
                        .join("bash.exe"),
                ]
            })
            .find(|p| p.is_file())
    })
}

/// 由 `git.exe` 的位置推出 Git for Windows 安裝目錄下的 `bin\bash.exe`。
fn git_bash_near(git: &Path) -> Option<PathBuf> {
    // <root>\cmd\git.exe、<root>\bin\git.exe、<root>\mingw64\bin\git.exe
    git.ancestors()
        .skip(1)
        .take(3)
        .map(|dir| dir.join("bin").join("bash.exe"))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 非_windows_一律用_sh() {
        if !cfg!(windows) {
            assert_eq!(Shell::for_script("#!/bin/bash\necho"), Shell::Sh);
            assert_eq!(Shell::for_script("echo"), Shell::Sh);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_預設用_cmd_有_shebang_時用_git_bash() {
        assert_eq!(Shell::for_script("pnpm install"), Shell::Cmd);
        match Shell::for_script("#!/usr/bin/env bash\necho hi") {
            Shell::GitBash(path) => assert!(path.is_file()),
            // CI 的 Windows runner 一定有 Git for Windows；本機沒有時退回 cmd。
            Shell::Cmd => assert!(git_bash().is_none()),
            other => panic!("預期 Git Bash 或 cmd，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn 腳本中的引號與特殊字元原樣傳遞() {
        let script = r#"echo "a b" && echo x&y"#;
        let script = if cfg!(windows) {
            script.replace("x&y", "x^&y")
        } else {
            script.replace("x&y", "'x&y'")
        };
        let output = process::run(&Shell::for_script(&script).spec(&script))
            .await
            .unwrap();
        assert!(output.success(), "{}", output.combined());
        let lines: Vec<_> = output.stdout.lines().map(str::trim).collect();
        assert_eq!(lines[0].trim_matches('"'), "a b");
        assert_eq!(lines[1], "x&y");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn shebang_腳本在_git_bash_中執行() {
        if git_bash().is_none() {
            return;
        }
        let script = "#!/usr/bin/env bash\necho \"$((1 + 2))\"";
        let output = process::run(&Shell::for_script(script).spec(script))
            .await
            .unwrap();
        assert!(output.success(), "{}", output.combined());
        assert_eq!(output.stdout.trim(), "3");
    }
}
