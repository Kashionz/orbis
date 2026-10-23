//! Preview 的 dev server 程序（ARCHITECTURE §13「啟動與生命週期」）。
//!
//! - 執行方式與 setup 相同（§6.3 的 shell 規則與注入的環境變數），程序樹放進 Job Object 或
//!   process group，結束時整棵樹一起結束。
//! - 每隔一段時間對 `localhost:<注入的 port>` 加上 `ready_path` 送 `GET`，同時嘗試 IPv4 與 IPv6
//!   （dev server 可能只綁 `::1`），收到 2xx 或 3xx 就視為就緒。
//! - Run 進入終止狀態、Run 本身結束（狀態的 sender 被 drop）或呼叫 [`Preview::stop`] 時結束程序樹。

use std::collections::VecDeque;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbis_protocol::enums::RunStatus;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

use super::registry::Registration;
use crate::process::{self, Pipes, ProcessTree};
use crate::secrets::Redactor;
use crate::shell::Shell;
use crate::worktree::Worktree;

/// 回報時保留的輸出尾段行數。
const TAIL_LINES: usize = 60;
/// 每一行最多保留的字元數。
const TAIL_LINE_CHARS: usize = 500;
/// 程序結束後，等 stdout／stderr 讀完的時間。
const DRAIN_GRACE: Duration = Duration::from_secs(1);

/// 啟動 Preview 需要的資訊。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewSpec {
    pub command: String,
    /// 以 `/` 開頭的路徑（可以帶 query）。
    pub ready_path: String,
    pub port: u16,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

impl PreviewSpec {
    /// 由 Worktree 的設定組出；沒有設定 `[preview].command` 時回傳 `None`。
    pub fn from_worktree(wt: &Worktree) -> Option<Self> {
        let preview = &wt.config.config.preview;
        let command = preview
            .command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())?;
        Some(Self {
            command: command.to_owned(),
            ready_path: normalize_ready_path(preview.ready_path.as_deref()),
            port: wt.port,
            cwd: wt.path.clone(),
            env: wt.env(),
        })
    }

    /// Runner 本機可以開啟的網址（含 `ready_path`），放進 `preview_ready` Event。
    pub fn local_url(&self) -> String {
        local_url(self.port, &self.ready_path)
    }
}

/// Runner 本機開啟 Preview 的網址。A2 的 browser 驗證（Playwright MCP）也用這個網址。
pub fn local_url(port: u16, path: &str) -> String {
    format!(
        "http://localhost:{port}{}",
        normalize_ready_path(Some(path))
    )
}

/// `ready_path` 沒有設定時是 `/`；沒有以 `/` 開頭時補上。
fn normalize_ready_path(path: Option<&str>) -> String {
    match path.map(str::trim).filter(|p| !p.is_empty()) {
        None => "/".to_owned(),
        Some(p) if p.starts_with('/') => p.to_owned(),
        Some(p) => format!("/{p}"),
    }
}

/// Preview 停下來的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewStopReason {
    /// dev server 自己結束。
    Exited,
    /// 在時限內沒有就緒，Runner 結束了程序。
    ReadyTimeout,
    /// 無法啟動。
    SpawnFailed,
}

impl PreviewStopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exited => "exited",
            Self::ReadyTimeout => "ready_timeout",
            Self::SpawnFailed => "spawn_failed",
        }
    }
}

/// Preview 狀態的變化，由 Run 轉成 Event。因 Run 結束或 [`Preview::stop`] 而停止時不回報。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewNotice {
    Ready {
        port: u16,
        url: String,
    },
    Stopped {
        reason: PreviewStopReason,
        exit_code: Option<i32>,
        /// 遮蔽過 secret 的輸出尾段。
        output: String,
    },
}

/// 時間參數；測試可以縮短。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewTiming {
    /// 從啟動到就緒的時限（Windows 上 Next.js 第一次編譯很慢，預設 300 秒）。
    pub ready_timeout: Duration,
    /// 檢查就緒的間隔。
    pub poll_interval: Duration,
}

impl Default for PreviewTiming {
    fn default() -> Self {
        Self {
            ready_timeout: Duration::from_secs(300),
            poll_interval: Duration::from_millis(500),
        }
    }
}

/// 執行中的 Preview。drop 時（或 Run 進入終止狀態時）結束程序樹。
#[derive(Debug)]
pub struct Preview {
    port: u16,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl Preview {
    /// 在背景啟動 dev server。`status` 進入終止狀態或 sender 被 drop 時結束。
    ///
    /// `after` 是在背景執行的 setup 的結果（`wait_for_setup = false`）：等它成功才啟動，
    /// 失敗時不啟動（setup 的失敗已另外回報）。
    pub fn start(
        spec: PreviewSpec,
        after: Option<oneshot::Receiver<bool>>,
        registration: Option<Registration>,
        redactor: Redactor,
        status: watch::Receiver<RunStatus>,
        timing: PreviewTiming,
        notify: impl Fn(PreviewNotice) + Send + 'static,
    ) -> Self {
        let (stop, stop_rx) = oneshot::channel();
        let port = spec.port;
        let task = tokio::spawn(supervise(
            spec,
            after,
            registration,
            redactor,
            status,
            timing,
            stop_rx,
            notify,
        ));
        Self {
            port,
            stop: Some(stop),
            task,
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// 結束 dev server 並等整個程序樹結束。
    pub async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = (&mut self.task).await;
    }
}

/// 輸出尾段。
#[derive(Debug, Default)]
struct Tail(VecDeque<String>);

impl Tail {
    fn push(&mut self, line: String) {
        let line = if line.chars().count() > TAIL_LINE_CHARS {
            let mut cut: String = line.chars().take(TAIL_LINE_CHARS).collect();
            cut.push('…');
            cut
        } else {
            line
        };
        if self.0.len() == TAIL_LINES {
            self.0.pop_front();
        }
        self.0.push_back(line);
    }

    fn text(&self) -> String {
        self.0
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// 為什麼不再監看。
enum End {
    /// Run 結束或被要求停止：結束程序，不回報。
    Stopped,
    Exited(Option<i32>),
}

#[allow(clippy::too_many_arguments)]
async fn supervise(
    spec: PreviewSpec,
    after: Option<oneshot::Receiver<bool>>,
    registration: Option<Registration>,
    redactor: Redactor,
    mut status: watch::Receiver<RunStatus>,
    timing: PreviewTiming,
    mut stop: oneshot::Receiver<()>,
    notify: impl Fn(PreviewNotice) + Send + 'static,
) {
    if let Some(after) = after {
        let setup_ok = tokio::select! {
            ok = after => ok.unwrap_or(false),
            () = wait_terminal(&mut status) => false,
            _ = &mut stop => false,
        };
        if !setup_ok {
            return;
        }
    }
    let process_spec = Shell::for_script(&spec.command)
        .spec(&spec.command)
        .cwd(&spec.cwd)
        .envs(spec.env.clone())
        .unattended_git();
    let mut tree = match ProcessTree::spawn(&process_spec, Pipes::OUTPUT) {
        Ok(tree) => tree,
        Err(e) => {
            notify(PreviewNotice::Stopped {
                reason: PreviewStopReason::SpawnFailed,
                exit_code: None,
                output: redactor.redact(&format!("{e:#}")),
            });
            return;
        }
    };
    // 程序在執行期間登記 port，relay 才會轉送；結束（這個函式返回）時取消登記
    let _registered = registration.map(|r| r.register(spec.port));
    let tail = Arc::new(Mutex::new(Tail::default()));
    let drains = [
        tree.take_stdout().map(|r| drain(r, tail.clone())),
        tree.take_stderr().map(|r| drain(r, tail.clone())),
    ];
    let output = |tail: &Arc<Mutex<Tail>>| {
        redactor.redact(&tail.lock().unwrap_or_else(|e| e.into_inner()).text())
    };

    // 第一階段：等就緒。
    let ready = wait_ready(spec.port, &spec.ready_path, timing);
    let end = tokio::select! {
        () = wait_terminal(&mut status) => End::Stopped,
        _ = &mut stop => End::Stopped,
        exit = tree.wait() => End::Exited(exit.ok().and_then(|s| s.code())),
        ok = ready => {
            if ok {
                notify(PreviewNotice::Ready { port: spec.port, url: spec.local_url() });
                // 第二階段：就緒後持續到 Run 結束或 dev server 自己結束。
                tokio::select! {
                    () = wait_terminal(&mut status) => End::Stopped,
                    _ = &mut stop => End::Stopped,
                    exit = tree.wait() => End::Exited(exit.ok().and_then(|s| s.code())),
                }
            } else {
                kill(&mut tree, spec.port).await;
                settle(drains).await;
                notify(PreviewNotice::Stopped {
                    reason: PreviewStopReason::ReadyTimeout,
                    exit_code: None,
                    output: output(&tail),
                });
                return;
            }
        }
    };
    // 殼（cmd、sh）結束時，它開的子程序可能還在，一律結束整棵樹。
    kill(&mut tree, spec.port).await;
    settle(drains).await;
    if let End::Exited(exit_code) = end {
        notify(PreviewNotice::Stopped {
            reason: PreviewStopReason::Exited,
            exit_code,
            output: output(&tail),
        });
    }
}

fn drain<R>(reader: R, tail: Arc<Mutex<Tail>>) -> JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(process::drain_lines(reader, move |line| {
        tail.lock().unwrap_or_else(|e| e.into_inner()).push(line);
    }))
}

/// 等 stdout／stderr 讀完；子程序被結束後 pipe 會關閉，最多等 [`DRAIN_GRACE`]。
async fn settle(drains: [Option<JoinHandle<()>>; 2]) {
    for handle in drains.into_iter().flatten() {
        let _ = tokio::time::timeout(DRAIN_GRACE, handle).await;
    }
}

async fn kill(tree: &mut ProcessTree, port: u16) {
    if let Err(e) = tree.kill().await {
        tracing::warn!(port, error = %e, "無法結束 Preview 的程序樹");
    }
}

/// Run 進入終止狀態，或 sender 被 drop（Run 已結束）時回傳。
async fn wait_terminal(status: &mut watch::Receiver<RunStatus>) {
    loop {
        if status.borrow_and_update().is_terminal() {
            return;
        }
        if status.changed().await.is_err() {
            return;
        }
    }
}

/// 在時限內反覆檢查是否就緒。
async fn wait_ready(port: u16, path: &str, timing: PreviewTiming) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    let deadline = tokio::time::Instant::now() + timing.ready_timeout;
    loop {
        if is_ready(&client, port, path).await {
            return true;
        }
        if tokio::time::Instant::now() + timing.poll_interval > deadline {
            return false;
        }
        tokio::time::sleep(timing.poll_interval).await;
    }
}

async fn is_ready(client: &reqwest::Client, port: u16, path: &str) -> bool {
    let addrs = [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ];
    for addr in addrs {
        // Host 用 localhost：dev server 的 host 檢查（Vite 的 allowedHosts）一定接受。
        let response = client
            .get(format!("http://{addr}{path}"))
            .header(reqwest::header::HOST, format!("localhost:{port}"))
            .send()
            .await;
        if let Ok(response) = response {
            let status = response.status();
            if status.is_success() || status.is_redirection() {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use orbis_protocol::names::ENV_PORT;
    use tokio::sync::mpsc;

    use super::*;

    /// 監聽 port 的 dev server（node）。`PORT_ENV` 會換成注入 port 的環境變數名稱。
    const LISTEN_JS: &str =
        "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT_ENV))";

    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    /// 以 node 執行一段 JS 的 Preview 設定。
    fn node_spec(dir: &std::path::Path, js: &str) -> PreviewSpec {
        let file = dir.join("preview.js");
        std::fs::write(&file, js.replace("PORT_ENV", ENV_PORT)).unwrap();
        PreviewSpec {
            command: "node preview.js".into(),
            ready_path: "/".into(),
            port: free_port(),
            cwd: dir.to_path_buf(),
            env: vec![(ENV_PORT.into(), String::new())],
        }
    }

    fn start(
        mut spec: PreviewSpec,
        after: Option<oneshot::Receiver<bool>>,
        timing: PreviewTiming,
    ) -> (
        Preview,
        mpsc::UnboundedReceiver<PreviewNotice>,
        watch::Sender<RunStatus>,
    ) {
        spec.env = vec![(ENV_PORT.into(), spec.port.to_string())];
        let (tx, rx) = mpsc::unbounded_channel();
        let (status_tx, status) = watch::channel(RunStatus::Running);
        let preview = Preview::start(
            spec,
            after,
            None,
            Redactor::new(),
            status,
            timing,
            move |n| {
                let _ = tx.send(n);
            },
        );
        (preview, rx, status_tx)
    }

    async fn next(rx: &mut mpsc::UnboundedReceiver<PreviewNotice>) -> PreviewNotice {
        tokio::time::timeout(Duration::from_secs(30), rx.recv())
            .await
            .expect("等不到 Preview 的通知")
            .expect("通知的 channel 已關閉")
    }

    const FAST: PreviewTiming = PreviewTiming {
        ready_timeout: Duration::from_secs(30),
        poll_interval: Duration::from_millis(100),
    };

    #[tokio::test]
    async fn 時限內沒有就緒就結束程序並回報() {
        let dir = tempfile::tempdir().unwrap();
        let spec = node_spec(
            dir.path(),
            "console.log('還在編譯'); setInterval(() => {}, 1000)",
        );
        let timing = PreviewTiming {
            ready_timeout: Duration::from_secs(2),
            poll_interval: Duration::from_millis(100),
        };
        let (_preview, mut rx, _status) = start(spec, None, timing);
        match next(&mut rx).await {
            PreviewNotice::Stopped { reason, output, .. } => {
                assert_eq!(reason, PreviewStopReason::ReadyTimeout);
                assert!(output.contains("還在編譯"), "{output}");
            }
            other => panic!("預期逾時，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn 背景_setup_失敗時不啟動() {
        let dir = tempfile::tempdir().unwrap();
        let spec = node_spec(
            dir.path(),
            "require('fs').writeFileSync('started.txt', 'x'); setInterval(() => {}, 1000)",
        );
        let (done, after) = oneshot::channel();
        let (preview, mut rx, _status) = start(spec, Some(after), FAST);
        done.send(false).unwrap();
        preview.stop().await;
        assert!(rx.try_recv().is_err(), "setup 失敗時不回報 Preview 的狀態");
        assert!(
            !dir.path().join("started.txt").exists(),
            "setup 失敗時不可以啟動"
        );
    }

    #[tokio::test]
    async fn 背景_setup_成功後才啟動() {
        let dir = tempfile::tempdir().unwrap();
        let spec = node_spec(dir.path(), LISTEN_JS);
        let port = spec.port;
        let (done, after) = oneshot::channel();
        let (preview, mut rx, _status) = start(spec, Some(after), FAST);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
                && tokio::net::TcpStream::connect(("::1", port)).await.is_err(),
            "setup 完成前不可以啟動"
        );
        done.send(true).unwrap();
        assert_eq!(
            next(&mut rx).await,
            PreviewNotice::Ready {
                port,
                url: local_url(port, "/"),
            }
        );
        preview.stop().await;
    }

    #[tokio::test]
    async fn run_進入終止狀態時結束且不回報() {
        let dir = tempfile::tempdir().unwrap();
        let spec = node_spec(dir.path(), LISTEN_JS);
        let (preview, mut rx, status) = start(spec, None, FAST);
        assert!(matches!(next(&mut rx).await, PreviewNotice::Ready { .. }));
        status.send_replace(RunStatus::Canceled);
        tokio::time::timeout(Duration::from_secs(15), preview.task)
            .await
            .expect("Run 終止後 Preview 要結束")
            .unwrap();
        assert!(rx.try_recv().is_err(), "因 Run 結束而停止時不回報");
    }

    #[test]
    fn ready_path_預設是根目錄並補上斜線() {
        assert_eq!(normalize_ready_path(None), "/");
        assert_eq!(normalize_ready_path(Some("  ")), "/");
        assert_eq!(normalize_ready_path(Some("health")), "/health");
        assert_eq!(normalize_ready_path(Some("/app?x=1")), "/app?x=1");
        assert_eq!(local_url(4123, "/"), "http://localhost:4123/");
    }

    #[test]
    fn 輸出尾段只保留最後幾行並截斷過長的行() {
        let mut tail = Tail::default();
        for i in 0..(TAIL_LINES + 5) {
            tail.push(format!("line {i}"));
        }
        let text = tail.text();
        assert!(!text.contains("line 4\n"));
        assert!(text.starts_with("line 5"));
        assert!(text.ends_with(&format!("line {}", TAIL_LINES + 4)));
        tail.push("x".repeat(TAIL_LINE_CHARS + 10));
        assert!(tail.text().ends_with('…'));
    }
}
