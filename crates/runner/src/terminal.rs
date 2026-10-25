//! 互動式終端機（ARCHITECTURE §6.5、ADR-0014）：在 Run 的 Worktree 中開 PTY（`portable-pty`，Windows 是
//! ConPTY），輸入輸出經由 Runner 連線轉送（frame `terminal_*`，資料是 base64）。
//!
//! - 只接受自己開過的 `terminal_id`；不認得的 `terminal_input`／`terminal_resize`／`terminal_close` 忽略。
//! - 每個 `terminal_open` 最後恰好有一個 `terminal_exited`（開不起來時也是）。
//! - 終端機是人自己下指令，不經過 Permission Policy；誰能開由 Server 判斷，Runner 另有自己的開關
//!   （`runner.toml` 的 `allow_terminal`，Team Runner 預設 `false`、Local Runner 預設 `true`）。
//! - 每個 Run 最多 [`TERMINAL_MAX_PER_RUN`] 個；閒置（沒有輸入也沒有輸出）超過設定的秒數就關閉。
//! - 輸出不經過 credit 背壓：放進專用的 channel，連線送出時排在 Event、control 與 Heartbeat 之後。
//! - 一條連線一個 [`Terminals`]：連線結束（斷線或 Runner 結束）時關閉這條連線開的所有終端機，不支援重新接上。

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use orbis_protocol::frame::RunnerToServer;
use orbis_protocol::ids::{RunId, TerminalId};
use orbis_protocol::terminal::{
    TERMINAL_MAX_CHUNK, TERMINAL_MAX_PER_RUN, TerminalClose, TerminalExitReason, TerminalExited,
    TerminalInput, TerminalOpen, TerminalOutput, TerminalResize,
};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{mpsc, oneshot};

/// 結束終端機時等讀取執行緒送完剩下輸出的時間上限。
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

/// 開終端機需要的、和連線無關的資訊（由 Supervisor 提供）。
pub struct TerminalEnv {
    /// `runner.toml` 與 Runner 的種類決定的開關。
    pub allowed: bool,
    /// shell 與它的參數。
    pub shell: Vec<String>,
    pub idle_timeout: Duration,
}

/// 一個 Run 的 Worktree：路徑與注入的環境變數（ARCHITECTURE §6.3）。
pub struct TerminalWorktree {
    pub path: PathBuf,
    pub env: Vec<(String, String)>,
}

/// 開著的一個終端機。
struct Entry {
    run_id: RunId,
    input: std::sync::mpsc::Sender<Vec<u8>>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    close: Option<oneshot::Sender<TerminalExitReason>>,
    activity: Arc<Mutex<Instant>>,
}

/// 這條連線上的終端機。
pub struct Terminals {
    out: mpsc::UnboundedSender<RunnerToServer>,
    entries: Arc<Mutex<HashMap<TerminalId, Entry>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn exited(
    terminal_id: TerminalId,
    reason: TerminalExitReason,
    code: Option<i32>,
    message: Option<String>,
) -> RunnerToServer {
    RunnerToServer::TerminalExited(TerminalExited {
        terminal_id,
        code,
        reason,
        message,
    })
}

impl Terminals {
    /// 回傳的 receiver 是要送給 Server 的 `terminal_output`／`terminal_exited`（優先順序最低）。
    pub fn new() -> (Self, mpsc::UnboundedReceiver<RunnerToServer>) {
        let (out, rx) = mpsc::unbounded_channel();
        (
            Self {
                out,
                entries: Arc::new(Mutex::new(HashMap::new())),
            },
            rx,
        )
    }

    fn send(&self, frame: RunnerToServer) {
        let _ = self.out.send(frame);
    }

    /// `terminal_open`。`worktree` 是這個 Run 在這台 Runner 上的 Worktree（沒有時為 `None`）。
    pub fn open(&self, open: TerminalOpen, env: &TerminalEnv, worktree: Option<TerminalWorktree>) {
        let id = open.terminal_id.clone();
        if lock(&self.entries).contains_key(&id) {
            tracing::warn!(terminal_id = %id, "重複的 terminal_open，略過");
            return;
        }
        if !env.allowed {
            return self.send(exited(
                id,
                TerminalExitReason::Disabled,
                None,
                Some(format!(
                    "這台 Runner 的 {} 不允許終端機（allow_terminal）",
                    orbis_protocol::names::RUNNER_CONFIG_FILE
                )),
            ));
        }
        let Some(worktree) = worktree.filter(|w| w.path.is_dir()) else {
            return self.send(exited(
                id,
                TerminalExitReason::WorktreeMissing,
                None,
                Some(format!(
                    "這台 Runner 上沒有 Run {} 的 Worktree",
                    open.run_id
                )),
            ));
        };
        let open_count = lock(&self.entries)
            .values()
            .filter(|e| e.run_id == open.run_id)
            .count();
        if open_count >= TERMINAL_MAX_PER_RUN as usize {
            return self.send(exited(
                id,
                TerminalExitReason::LimitExceeded,
                None,
                Some(format!("每個 Run 同時最多 {TERMINAL_MAX_PER_RUN} 個終端機")),
            ));
        }
        match self.spawn(&open, env, worktree) {
            Ok(entry) => {
                lock(&self.entries).insert(id, entry);
            }
            Err(e) => self.send(exited(
                id,
                TerminalExitReason::SpawnFailed,
                None,
                Some(format!("{e:#}")),
            )),
        }
    }

    fn spawn(
        &self,
        open: &TerminalOpen,
        env: &TerminalEnv,
        worktree: TerminalWorktree,
    ) -> anyhow::Result<Entry> {
        let (program, args) = env
            .shell
            .split_first()
            .ok_or_else(|| anyhow::anyhow!("沒有設定 shell"))?;
        let pair = native_pty_system().openpty(PtySize {
            rows: open.rows.max(1),
            cols: open.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new(program);
        command.args(args);
        command.cwd(&worktree.path);
        for (key, value) in &worktree.env {
            command.env(key, value);
        }
        let mut child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let killer = child.clone_killer();
        let master = Arc::new(Mutex::new(Some(pair.master)));
        let activity = Arc::new(Mutex::new(Instant::now()));
        let id = open.terminal_id.clone();

        // 讀取：每次最多 64 KiB，各自一個 frame。
        let (drained_tx, drained) = oneshot::channel::<()>();
        {
            let (out, id, activity) = (self.out.clone(), id.clone(), activity.clone());
            std::thread::spawn(move || {
                let mut buf = vec![0u8; TERMINAL_MAX_CHUNK];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            *lock(&activity) = Instant::now();
                            let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                            let frame = RunnerToServer::TerminalOutput(TerminalOutput {
                                terminal_id: id.clone(),
                                data,
                            });
                            if out.send(frame).is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = drained_tx.send(());
            });
        }
        // 輸入：寫入可能卡住（shell 沒有在讀），放在自己的執行緒。
        let (input, inputs) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(bytes) = inputs.recv() {
                if writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        // shell 自己結束。
        let (exit_tx, exit) = oneshot::channel::<Option<i32>>();
        std::thread::spawn(move || {
            let code = child
                .wait()
                .ok()
                .map(|status| i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
            let _ = exit_tx.send(code);
        });
        let (close, closed) = oneshot::channel::<TerminalExitReason>();
        tokio::spawn(lifecycle(Lifecycle {
            id,
            out: self.out.clone(),
            entries: self.entries.clone(),
            master: master.clone(),
            killer,
            activity: activity.clone(),
            idle_timeout: env.idle_timeout,
            exit,
            closed,
            drained,
        }));
        Ok(Entry {
            run_id: open.run_id.clone(),
            input,
            master,
            close: Some(close),
            activity,
        })
    }

    /// `terminal_input`：base64 解碼後寫入 PTY。解不開的資料與不認得的終端機略過。
    pub fn input(&self, input: TerminalInput) {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(input.data.as_bytes())
        else {
            tracing::warn!(terminal_id = %input.terminal_id, "terminal_input 不是合法的 base64，略過");
            return;
        };
        if let Some(entry) = lock(&self.entries).get(&input.terminal_id) {
            *lock(&entry.activity) = Instant::now();
            let _ = entry.input.send(bytes);
        }
    }

    pub fn resize(&self, resize: TerminalResize) {
        if let Some(entry) = lock(&self.entries).get(&resize.terminal_id)
            && let Some(master) = lock(&entry.master).as_ref()
            && let Err(e) = master.resize(PtySize {
                rows: resize.rows.max(1),
                cols: resize.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
        {
            tracing::warn!(terminal_id = %resize.terminal_id, error = %e, "無法改變終端機的大小");
        }
    }

    pub fn close(&self, close: TerminalClose) {
        self.close_with(&close.terminal_id, TerminalExitReason::Closed);
    }

    fn close_with(&self, id: &TerminalId, reason: TerminalExitReason) {
        let sender = lock(&self.entries)
            .get_mut(id)
            .and_then(|entry| entry.close.take());
        if let Some(sender) = sender {
            let _ = sender.send(reason);
        }
    }

    /// 連線結束：關閉這條連線開的所有終端機（`runner_shutdown`）。
    pub fn close_all(&self) {
        let ids: Vec<TerminalId> = lock(&self.entries).keys().cloned().collect();
        for id in ids {
            self.close_with(&id, TerminalExitReason::RunnerShutdown);
        }
    }

    /// 開著的終端機數（測試用）。
    pub fn len(&self) -> usize {
        lock(&self.entries).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        self.close_all();
    }
}

struct Lifecycle {
    id: TerminalId,
    out: mpsc::UnboundedSender<RunnerToServer>,
    entries: Arc<Mutex<HashMap<TerminalId, Entry>>>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    activity: Arc<Mutex<Instant>>,
    idle_timeout: Duration,
    exit: oneshot::Receiver<Option<i32>>,
    closed: oneshot::Receiver<TerminalExitReason>,
    drained: oneshot::Receiver<()>,
}

/// 一個終端機從開啟到 `terminal_exited`：shell 自己結束、收到關閉，或閒置逾時。
async fn lifecycle(mut t: Lifecycle) {
    let check = (t.idle_timeout / 4).clamp(Duration::from_millis(200), Duration::from_secs(30));
    let mut ticker = tokio::time::interval(check);
    let (reason, code) = loop {
        tokio::select! {
            code = &mut t.exit => break (TerminalExitReason::Exited, code.ok().flatten()),
            reason = &mut t.closed => break (reason.unwrap_or(TerminalExitReason::RunnerShutdown), None),
            _ = ticker.tick() => {
                if lock(&t.activity).elapsed() >= t.idle_timeout {
                    break (TerminalExitReason::IdleTimeout, None);
                }
            }
        }
    };
    if reason != TerminalExitReason::Exited {
        let _ = t.killer.kill();
    }
    // 關掉 PTY：Windows 關閉 ConPTY 會結束掛在上面的程序，macOS／Linux 送 SIGHUP 給整個 session。
    // 讀取執行緒因此讀到結尾，送完剩下的輸出後才送 terminal_exited。
    drop(lock(&t.master).take());
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, t.drained).await;
    lock(&t.entries).remove(&t.id);
    tracing::info!(terminal_id = %t.id, reason = reason.as_str(), ?code, "終端機已結束");
    let _ = t.out.send(exited(t.id, reason, code, None));
}

/// 預設的 shell（ARCHITECTURE §6.5）：Windows 用 PowerShell（優先 pwsh），其他平台用 `$SHELL`，
/// 沒有時 `/bin/sh`。
pub fn default_shell() -> Vec<String> {
    if cfg!(windows) {
        let program = crate::shell::powershell().map_or_else(
            || "powershell.exe".to_owned(),
            |p| p.to_string_lossy().into_owned(),
        );
        return vec![program, "-NoLogo".into()];
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    vec![shell]
}

/// `runner.toml` 的 `terminal_shell`：第一個元素不是絕對路徑時依 PATH 找到絕對路徑，
/// 不在 Worktree（cwd）中搜尋（Worktree 的內容可能是 Agent 寫的）。
pub fn resolve_shell(configured: Option<&[String]>) -> Vec<String> {
    let Some((program, args)) = configured.and_then(<[String]>::split_first) else {
        return default_shell();
    };
    let resolved = crate::process::which(program)
        .map_or_else(|| program.clone(), |p| p.to_string_lossy().into_owned());
    std::iter::once(resolved)
        .chain(args.iter().cloned())
        .collect()
}
