//! 程序管理（ARCHITECTURE §6.4）。
//!
//! - 每個程序樹放在 Windows 的 Job Object 或 Unix 的 process group 中：結束時整棵樹一起結束，
//!   Runner 自己結束（包括當掉）時子程序也會被清掉。
//! - 執行檔依 `PATH`／`PATHEXT` 解析，npm 安裝的 `.cmd` shim 也找得到。
//! - 參數的引號自己處理：一般執行檔依 MSVC 規則，`.cmd`／`.bat` 經由 `cmd.exe /d /s /c` 並拒絕
//!   cmd 無法安全傳遞的字元。
//! - git 一律關閉互動式提示。

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, bail};
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;

/// 無人值守時關閉 git 互動式提示的環境變數（§6.4）。
pub const GIT_UNATTENDED_ENV: [(&str, &str); 2] =
    [("GIT_TERMINAL_PROMPT", "0"), ("GCM_INTERACTIVE", "never")];

/// 要啟動的程序。
#[derive(Debug, Clone, Default)]
pub struct ProcessSpec {
    /// 執行檔名稱或路徑。只有名稱時依 `PATH` 解析。
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    /// 額外設定的環境變數（覆蓋繼承來的值）。
    pub env: Vec<(OsString, OsString)>,
    /// 不繼承的環境變數。
    pub env_remove: Vec<OsString>,
    /// 只用於 Windows：原樣接在命令列最後、不加引號的部分（`cmd /s /c "<script>"` 的 script）。
    /// 其他平台忽略。
    pub raw_tail: Option<String>,
}

impl ProcessSpec {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            ..Self::default()
        }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn envs<I, K, V>(mut self, vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<OsString>,
        V: Into<OsString>,
    {
        self.env
            .extend(vars.into_iter().map(|(k, v)| (k.into(), v.into())));
        self
    }

    /// 設定 Windows 上原樣接在命令列最後的部分，見 [`Self::raw_tail`]。
    pub fn raw_tail(mut self, tail: impl Into<String>) -> Self {
        self.raw_tail = Some(tail.into());
        self
    }

    /// 加上關閉 git 互動式提示的環境變數。
    pub fn unattended_git(self) -> Self {
        self.envs(GIT_UNATTENDED_ENV)
    }

    /// 給人看的指令列（log 與錯誤訊息用）。
    pub fn display(&self) -> String {
        std::iter::once(self.program.as_os_str())
            .chain(self.args.iter().map(OsString::as_os_str))
            .map(|part| {
                let text = part.to_string_lossy();
                if text.contains(' ') || text.is_empty() {
                    format!("\"{text}\"")
                } else {
                    text.into_owned()
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// 解析執行檔並組出 tokio 的 `Command`（含引號處理），stdio 由呼叫端設定。
    pub fn command(&self) -> anyhow::Result<Command> {
        let resolved = resolve_command(
            &self.program,
            std::env::var_os("PATH").as_deref(),
            std::env::var_os("PATHEXT").as_deref(),
        );
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut command = build_command(&resolved, &self.args)?;
        #[cfg(windows)]
        if let Some(tail) = &self.raw_tail {
            command.raw_arg(tail);
        }
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        for key in &self.env_remove {
            command.env_remove(key);
        }
        for (key, value) in &self.env {
            command.env(key, value);
        }
        Ok(command)
    }
}

#[cfg(windows)]
fn build_command(resolved: &Path, args: &[OsString]) -> anyhow::Result<Command> {
    if is_batch_file(resolved) {
        let line = batch_command_line(resolved, args)?;
        let mut command = Command::new(comspec());
        command.args(["/d", "/s", "/c"]).raw_arg(line);
        return Ok(command);
    }
    let mut command = Command::new(resolved);
    // 一般執行檔：自己依 MSVC 規則組出命令列，與 `.cmd` 的處理方式一致，也方便測試。
    for arg in args {
        command.raw_arg(quote_msvc_arg(&arg.to_string_lossy()));
    }
    Ok(command)
}

#[cfg(not(windows))]
fn build_command(resolved: &Path, args: &[OsString]) -> anyhow::Result<Command> {
    // Unix 的 execve 直接收參數陣列，不需要引號。
    let mut command = Command::new(resolved);
    command.args(args);
    Ok(command)
}

#[cfg(windows)]
fn comspec() -> OsString {
    std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into())
}

/// 是否為 `.cmd`／`.bat`（必須經由 cmd.exe 執行）。
pub fn is_batch_file(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// 依 MSVC C runtime 的規則替一個參數加上引號（`CommandLineToArgvW` 的反向）。
pub fn quote_msvc_arg(arg: &str) -> String {
    let needs_quotes = arg.is_empty() || arg.contains([' ', '\t', '\n', '\x0b', '"']);
    if !needs_quotes {
        return arg.to_owned();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // 引號前的反斜線要加倍，引號本身再跳脫一次。
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // 結尾的反斜線後面接的是收尾的引號，也要加倍。
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// `.cmd`／`.bat` 的命令列：交給 `cmd.exe /d /s /c "<line>"`。
///
/// 每個部分都加上引號，cmd 的特殊字元（`& | < > ^ ( )`）在引號內是字面值。`"`、`%` 與換行在 cmd
/// 中沒有可靠的跳脫方式，含有這些字元的參數直接拒絕，避免指令注入。
/// shim 通常把 `%*` 原樣轉給 node.exe，所以參數內容另外依 MSVC 規則處理反斜線。
pub fn batch_command_line(program: &Path, args: &[OsString]) -> anyhow::Result<String> {
    let mut parts = Vec::with_capacity(args.len() + 1);
    let program = program.to_string_lossy();
    if program.contains(['"', '%', '\r', '\n']) {
        bail!("{program} 的路徑含有 cmd 無法安全處理的字元");
    }
    parts.push(format!("\"{program}\""));
    for arg in args {
        let arg = arg.to_string_lossy();
        if arg.contains(['"', '%', '\r', '\n']) {
            bail!("參數 {arg:?} 含有 cmd 無法安全傳遞的字元（\"、% 或換行）");
        }
        let quoted = quote_msvc_arg(&arg);
        parts.push(if quoted.starts_with('"') {
            quoted
        } else {
            format!("\"{quoted}\"")
        });
    }
    // `/s` 會去掉最外層的一對引號，其餘原樣交給 cmd 解析。
    Ok(format!("\"{}\"", parts.join(" ")))
}

/// 解析要 spawn 的執行檔。
///
/// - 含路徑分隔的指令照原樣使用；Windows 上若沒有副檔名，依 `PATHEXT` 補上。
/// - 只有名稱的指令依 `PATH` 逐一搜尋；Windows 上同時嘗試 `PATHEXT` 的副檔名（找得到 `.cmd` shim）。
/// - 找不到時回傳原本的指令，交給作業系統回報錯誤。
pub fn resolve_command(
    command: &Path,
    path_var: Option<&OsStr>,
    pathext_var: Option<&OsStr>,
) -> PathBuf {
    find_command(command, path_var, pathext_var).unwrap_or_else(|| command.to_owned())
}

/// 同 [`resolve_command`]，找不到時回傳 `None`（用來偵測 Agent 是否已安裝）。
pub fn find_command(
    command: &Path,
    path_var: Option<&OsStr>,
    pathext_var: Option<&OsStr>,
) -> Option<PathBuf> {
    let extensions = executable_extensions(pathext_var);
    let has_separator = command.components().count() > 1 || command.is_absolute();
    if has_separator {
        return with_extension_candidates(command, &extensions)
            .into_iter()
            .find(|candidate| candidate.is_file());
    }
    std::env::split_paths(path_var?)
        .flat_map(|dir| with_extension_candidates(&dir.join(command), &extensions))
        .find(|candidate| candidate.is_file())
}

/// 依目前環境的 `PATH` 找執行檔。
pub fn which(command: &str) -> Option<PathBuf> {
    find_command(
        Path::new(command),
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("PATHEXT").as_deref(),
    )
}

fn executable_extensions(pathext_var: Option<&OsStr>) -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let raw = pathext_var
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_owned());
    raw.split(';')
        .map(str::trim)
        .filter(|ext| ext.starts_with('.') && ext.len() > 1)
        .map(str::to_ascii_lowercase)
        .collect()
}

fn with_extension_candidates(base: &Path, extensions: &[String]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if base.extension().is_some() || extensions.is_empty() {
        candidates.push(base.to_owned());
    }
    if base.extension().is_none() {
        for ext in extensions {
            let mut name = base.as_os_str().to_owned();
            name.push(ext);
            candidates.push(PathBuf::from(name));
        }
    }
    candidates
}

/// 一個程序樹（Job Object／process group）。drop 時整棵樹一起結束。
#[derive(Debug)]
pub struct ProcessTree {
    child: Box<dyn ChildWrapper>,
}

/// stdio 的設定。
#[derive(Debug, Clone, Copy)]
pub struct Pipes {
    pub stdin: bool,
    pub stdout: bool,
    pub stderr: bool,
}

impl Pipes {
    pub const ALL: Self = Self {
        stdin: true,
        stdout: true,
        stderr: true,
    };
    pub const OUTPUT: Self = Self {
        stdin: false,
        stdout: true,
        stderr: true,
    };
}

fn stdio(piped: bool) -> Stdio {
    if piped { Stdio::piped() } else { Stdio::null() }
}

impl ProcessTree {
    /// 在新的 Job Object／process group 中啟動程序。
    pub fn spawn(spec: &ProcessSpec, pipes: Pipes) -> anyhow::Result<Self> {
        let mut command = spec.command()?;
        command
            .stdin(stdio(pipes.stdin))
            .stdout(stdio(pipes.stdout))
            .stderr(stdio(pipes.stderr));
        let mut wrap = CommandWrap::from(command);
        #[cfg(windows)]
        wrap.wrap(process_wrap::tokio::JobObject);
        #[cfg(unix)]
        wrap.wrap(process_wrap::tokio::ProcessGroup::leader());
        wrap.wrap(KillOnDrop);
        let child = wrap
            .spawn()
            .with_context(|| format!("無法啟動 {}", spec.display()))?;
        Ok(Self { child })
    }

    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn take_stdin(&mut self) -> Option<tokio::process::ChildStdin> {
        self.child.stdin().take()
    }

    pub fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.child.stdout().take()
    }

    pub fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child.stderr().take()
    }

    /// 結束整個程序樹並等它結束。
    pub async fn kill(&mut self) -> anyhow::Result<()> {
        Box::into_pin(self.child.kill())
            .await
            .context("無法結束程序樹")
    }

    pub async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }
}

/// 一次性執行指令的結果。
#[derive(Debug, Clone)]
pub struct Output {
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn success(&self) -> bool {
        self.status.success()
    }

    /// stdout 與 stderr 合併，給錯誤訊息用。
    pub fn combined(&self) -> String {
        let mut text = self.stdout.trim_end().to_owned();
        let stderr = self.stderr.trim_end();
        if !stderr.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(stderr);
        }
        text
    }
}

/// 執行指令直到結束，**同時**讀取 stdout 與 stderr（避免其中一邊塞滿造成 backpressure 卡住）。
pub async fn run(spec: &ProcessSpec) -> anyhow::Result<Output> {
    let mut tree = ProcessTree::spawn(spec, Pipes::OUTPUT)?;
    let stdout = tree.take_stdout();
    let stderr = tree.take_stderr();
    let (stdout, stderr, status) = tokio::join!(read_all(stdout), read_all(stderr), tree.wait());
    Ok(Output {
        status: status.with_context(|| format!("等待 {} 結束失敗", spec.display()))?,
        stdout,
        stderr,
    })
}

async fn read_all<R: AsyncRead + Unpin>(reader: Option<R>) -> String {
    let Some(mut reader) = reader else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut buf).await;
    String::from_utf8_lossy(&buf).into_owned()
}

/// 持續讀取 `reader` 的每一行交給 `on_line`，直到 EOF。用來排空 Agent 的 stderr。
pub async fn drain_lines<R: AsyncRead + Unpin>(reader: R, mut on_line: impl FnMut(String)) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        on_line(line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msvc_引號規則() {
        assert_eq!(quote_msvc_arg("plain"), "plain");
        assert_eq!(quote_msvc_arg(""), "\"\"");
        assert_eq!(quote_msvc_arg("with space"), "\"with space\"");
        assert_eq!(
            quote_msvc_arg(r"C:\Program Files\"),
            r#""C:\Program Files\\""#
        );
        assert_eq!(quote_msvc_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_msvc_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote_msvc_arg(r"a\b"), r"a\b");
    }

    #[test]
    fn batch_命令列每個部分都有引號() {
        let line = batch_command_line(
            Path::new(r"C:\Program Files\x\tool.cmd"),
            &["--script".into(), r"C:\a b\c.yaml".into(), "x&y".into()],
        )
        .unwrap();
        assert_eq!(
            line,
            r#"""C:\Program Files\x\tool.cmd" "--script" "C:\a b\c.yaml" "x&y"""#
        );
    }

    #[test]
    fn batch_命令列拒絕無法安全傳遞的字元() {
        for bad in ["%PATH%", "a\"b", "a\nb"] {
            assert!(
                batch_command_line(Path::new("x.cmd"), &[bad.into()]).is_err(),
                "{bad:?} 應該被拒絕"
            );
        }
    }

    #[test]
    fn 辨識_batch_檔() {
        assert!(is_batch_file(Path::new("npm.cmd")));
        assert!(is_batch_file(Path::new("X.BAT")));
        assert!(!is_batch_file(Path::new("node.exe")));
        assert!(!is_batch_file(Path::new("node")));
    }

    #[test]
    fn 依_path_找到執行檔() {
        let dir = tempfile::Builder::new()
            .prefix("orbis resolve ")
            .tempdir()
            .unwrap();
        let file_name = if cfg!(windows) { "tool.cmd" } else { "tool" };
        let file = dir.path().join(file_name);
        std::fs::write(&file, "").unwrap();
        let path_var = std::env::join_paths([Path::new("does-not-exist"), dir.path()]).unwrap();
        assert_eq!(
            resolve_command(Path::new("tool"), Some(&path_var), None),
            file
        );
        assert_eq!(resolve_command(&file, Some(&path_var), None), file);
        assert_eq!(
            find_command(Path::new("missing-tool"), Some(&path_var), None),
            None
        );
    }

    #[tokio::test]
    async fn 同時讀取_stdout_與_stderr() {
        let spec = shell_spec("echo out && echo err 1>&2");
        let output = run(&spec).await.unwrap();
        assert!(output.success());
        assert_eq!(output.stdout.trim(), "out");
        assert_eq!(output.stderr.trim(), "err");
    }

    #[tokio::test]
    async fn 大量輸出不會卡住() {
        // 兩邊各輸出遠超過 pipe 緩衝區的量。
        let spec = if cfg!(windows) {
            shell_spec("for /L %i in (1,1,3000) do @(echo line %i & echo err %i 1>&2)")
        } else {
            shell_spec(
                "i=0; while [ $i -lt 3000 ]; do echo line $i; echo err $i 1>&2; i=$((i+1)); done",
            )
        };
        let output = tokio::time::timeout(std::time::Duration::from_secs(60), run(&spec))
            .await
            .expect("讀取輸出卡住了")
            .unwrap();
        assert_eq!(output.stdout.lines().count(), 3000);
        assert_eq!(output.stderr.lines().count(), 3000);
    }

    /// 用平台的 shell 執行一行指令（測試用）。
    fn shell_spec(line: &str) -> ProcessSpec {
        if cfg!(windows) {
            ProcessSpec::new("cmd.exe").args(["/d", "/c", line])
        } else {
            ProcessSpec::new("sh").args(["-c", line])
        }
    }
}
