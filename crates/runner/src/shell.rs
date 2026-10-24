//! 執行 `<CONFIG_DIR>/<CONFIG_FILE>` 中的腳本（setup、archive、preview）用的 shell（ARCHITECTURE §6.3）。
//!
//! - Windows：預設 `cmd`；腳本以 `#!` 開頭時依 shebang 選：含 `pwsh`／`powershell` 用 PowerShell，
//!   其他（bash、sh）用 Git Bash。
//! - macOS／Linux：預設 `sh`；shebang 含 `pwsh`／`powershell` 而且找得到 pwsh 時用 PowerShell。
//! - 產品注入的環境變數（`<前綴>PORT` 等）在腳本中可以用 `$NAME`、`${NAME}`、`%NAME%`、`$env:NAME`
//!   任何一種寫法；交給 shell 前，Runner 把它們改寫成該 shell 原生的寫法（只改這幾個變數，其他的
//!   `$` 與 `%` 不碰），同一份設定檔在三種 shell 都能用。

use std::path::{Path, PathBuf};

use crate::process::{self, ProcessSpec};

/// 腳本實際使用的 shell。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shell {
    /// Windows 的 `cmd.exe`。
    Cmd,
    /// Git for Windows 附帶的 bash。
    GitBash(PathBuf),
    /// PowerShell（`pwsh`，Windows 上找不到時用 Windows PowerShell 5.1）。
    PowerShell(PathBuf),
    /// POSIX `sh`。
    Sh,
}

impl Shell {
    /// 依平台與腳本內容選擇 shell。
    pub fn for_script(script: &str) -> Self {
        let shebang = script
            .trim_start()
            .strip_prefix("#!")
            .map(|rest| rest.lines().next().unwrap_or_default().to_ascii_lowercase());
        let wants_powershell = shebang
            .as_deref()
            .is_some_and(|line| line.contains("pwsh") || line.contains("powershell"));
        if wants_powershell {
            match powershell() {
                Some(path) => return Self::PowerShell(path),
                None => tracing::warn!("腳本指定 PowerShell，但找不到 pwsh，改用平台預設的 shell"),
            }
        }
        if !cfg!(windows) {
            return Self::Sh;
        }
        if shebang.is_some()
            && let Some(bash) = git_bash()
        {
            return Self::GitBash(bash);
        }
        Self::Cmd
    }

    /// 選 shell、改寫 Orbis 注入的變數、組出程序設定並注入環境變數：執行設定檔腳本的標準入口。
    pub fn script(script: &str, env: Vec<(String, String)>) -> ProcessSpec {
        let shell = Self::for_script(script);
        let rewritten = shell.rewrite_vars(script, env.iter().map(|(k, _)| k.as_str()));
        shell.spec(&rewritten).envs(env)
    }

    /// 組出執行 `script` 的程序設定。
    pub fn spec(&self, script: &str) -> ProcessSpec {
        match self {
            // `/s /c "<script>"`：cmd 去掉最外層的引號後原樣執行，腳本內的引號不需要跳脫。
            Self::Cmd => ProcessSpec::new("cmd.exe")
                .args(["/d", "/s", "/c"])
                .raw_tail(format!("\"{script}\"")),
            Self::GitBash(bash) => ProcessSpec::new(bash).args(["-c", script]),
            // 不載入 profile、不互動；Windows PowerShell 5.1 預設的執行原則會擋 -Command 以外的腳本，
            // 這裡只用 -Command。
            Self::PowerShell(pwsh) => ProcessSpec::new(pwsh)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                ])
                .args(["-Command", script]),
            Self::Sh => ProcessSpec::new("sh").args(["-c", script]),
        }
    }

    /// 把腳本中引用 `names` 這些變數的 `$NAME`、`${NAME}`、`%NAME%`、`$env:NAME` 改寫成這個 shell
    /// 原生的寫法。只改寫 `names` 中的變數，而且名稱後面不能接著其他識別字元（`$<前綴>PORT_X` 不算）。
    pub fn rewrite_vars<'a>(
        &self,
        script: &str,
        names: impl IntoIterator<Item = &'a str>,
    ) -> String {
        let names: Vec<&str> = names.into_iter().collect();
        let native = |name: &str| match self {
            Self::Cmd => format!("%{name}%"),
            Self::PowerShell(_) => format!("${{env:{name}}}"),
            Self::GitBash(_) | Self::Sh => format!("${{{name}}}"),
        };
        let mut out = String::with_capacity(script.len());
        let mut rest = script;
        while let Some(pos) = rest.find(['$', '%']) {
            out.push_str(&rest[..pos]);
            let tail = &rest[pos..];
            match parse_var_ref(tail, &names) {
                Some((name, len)) => {
                    out.push_str(&native(name));
                    rest = &tail[len..];
                }
                None => {
                    out.push_str(&tail[..1]);
                    rest = &tail[1..];
                }
            }
        }
        out.push_str(rest);
        out
    }
}

/// `text` 開頭是否為 `names` 中某個變數的引用；回傳變數名稱與引用的長度。
fn parse_var_ref<'a>(text: &str, names: &[&'a str]) -> Option<(&'a str, usize)> {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let followed_by_ident = |end: usize| text[end..].chars().next().is_some_and(is_ident);
    for name in names {
        let candidates = [
            (format!("${{{name}}}"), false),
            (format!("$env:{name}"), true),
            (format!("${name}"), true),
            (format!("%{name}%"), false),
        ];
        for (form, open_ended) in candidates {
            if text.starts_with(&form) && !(open_ended && followed_by_ident(form.len())) {
                return Some((name, form.len()));
            }
        }
    }
    None
}

/// 找 PowerShell：優先 `pwsh`（PowerShell 7），Windows 上退回 Windows PowerShell 5.1。
pub fn powershell() -> Option<PathBuf> {
    process::which("pwsh").or_else(|| {
        if !cfg!(windows) {
            return None;
        }
        process::which("powershell").or_else(|| {
            std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .and_then(|root| {
                    let path = root
                        .join("System32")
                        .join("WindowsPowerShell")
                        .join("v1.0")
                        .join("powershell.exe");
                    path.is_file().then_some(path)
                })
        })
    })
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
    use orbis_protocol::names::{ENV_PORT, ENV_TASK_KEY, ENV_WORKTREE_PATH};

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

    #[test]
    fn shebang_含_pwsh_或_powershell_時用_powershell() {
        for script in ["#!pwsh\n$x", "#!/usr/bin/env pwsh\n$x", "#!powershell\n$x"] {
            match Shell::for_script(script) {
                Shell::PowerShell(path) => assert!(path.is_file(), "{}", path.display()),
                other => assert!(powershell().is_none(), "{script:?} 得到 {other:?}"),
            }
        }
    }

    const NAMES: [&str; 2] = [ENV_PORT, ENV_WORKTREE_PATH];

    #[test]
    fn 三種寫法都改成_shell_原生的寫法_只改_orbis_的變數() {
        let (p, w) = (ENV_PORT, ENV_WORKTREE_PATH);
        // 四種寫法混用，加上不該被改的：其他變數、名稱後面接著識別字元的。
        let script = format!(
            "cd ${w} && dev --port ${{{p}}} -h %{p}% -e $env:{p} $HOME %PATH% ${p}_X $env:OTHER"
        );
        let tail = format!("$HOME %PATH% ${p}_X $env:OTHER");
        assert_eq!(
            Shell::Cmd.rewrite_vars(&script, NAMES),
            format!("cd %{w}% && dev --port %{p}% -h %{p}% -e %{p}% {tail}")
        );
        assert_eq!(
            Shell::Sh.rewrite_vars(&script, NAMES),
            format!("cd ${{{w}}} && dev --port ${{{p}}} -h ${{{p}}} -e ${{{p}}} {tail}")
        );
        assert_eq!(
            Shell::PowerShell(PathBuf::from("pwsh")).rewrite_vars(&script, NAMES),
            format!(
                "cd ${{env:{w}}} && dev --port ${{env:{p}}} -h ${{env:{p}}} -e ${{env:{p}}} {tail}"
            )
        );
        // 沒有變數引用時原樣。
        assert_eq!(Shell::Cmd.rewrite_vars("echo 100% $", NAMES), "echo 100% $");
    }

    /// 同一段腳本在平台預設的 shell、PowerShell、Git Bash（Windows）中都讀得到 Orbis 注入的變數。
    #[tokio::test]
    async fn 三種_shell_都能讀到_orbis_注入的變數() {
        let (p, k) = (ENV_PORT, ENV_TASK_KEY);
        let env = vec![
            (p.to_owned(), "41234".to_owned()),
            (k.to_owned(), "ORB-7".to_owned()),
        ];
        let mut scripts = vec![format!("echo port=${p} key=%{k}%")];
        if powershell().is_some() {
            scripts.push(format!("#!pwsh\nWrite-Output \"port=${p} key=${{{k}}}\""));
        }
        if cfg!(windows) && git_bash().is_some() {
            scripts.push(format!(
                "#!/usr/bin/env bash\necho \"port=%{p}% key=$env:{k}\""
            ));
        }
        for script in scripts {
            let output = process::run(&Shell::script(&script, env.clone()))
                .await
                .unwrap();
            assert!(output.success(), "{script:?}：{}", output.combined());
            assert!(
                output.stdout.contains("port=41234 key=ORB-7"),
                "{script:?}：{}",
                output.combined()
            );
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
