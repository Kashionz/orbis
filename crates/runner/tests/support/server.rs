//! 扮演 Server 的測試工具：同一個 port 上同時提供 Runner 的 WebSocket 端點與 blob 的 HTTP PUT，
//! 並啟動真正的 `orbis-runner` 執行檔。
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use orbis_protocol::connection::{HelloAck, RunResume};
use orbis_protocol::control::{RunControl, RunControlAction, RunControlResult};
use orbis_protocol::dispatch::{DispatchOffer, DispatchRepo, DispatchTask};
use orbis_protocol::enums::PermissionPolicy;
use orbis_protocol::event::ContentBlock;
use orbis_protocol::{PROTOCOL_VERSION, RUNNER_WS_PATH, names};
use orbis_runner::config::{ENV_PAIRING_TOKEN, ENV_SERVER_URL};
use orbis_runner::contract::RUNNER_BLOB_PATH;
use orbis_runner::home::ENV_HOME;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

pub const WAIT: Duration = Duration::from_secs(60);

/// 收到的 blob：`blob_id` → 內容。
pub type Blobs = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// 扮演 Server 的端點。
pub struct FakeServer {
    addr: std::net::SocketAddr,
    connections: mpsc::UnboundedReceiver<RunnerSide>,
    pub blobs: Blobs,
}

impl FakeServer {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, connections) = mpsc::unbounded_channel();
        let blobs: Blobs = Arc::default();
        let blobs_for_task = blobs.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let tx = tx.clone();
                let blobs = blobs_for_task.clone();
                tokio::spawn(async move {
                    let mut peek = [0u8; 4];
                    if stream.peek(&mut peek).await.is_ok() && &peek == b"PUT " {
                        handle_put(stream, blobs).await;
                        return;
                    }
                    #[allow(clippy::result_large_err)]
                    let ws = tokio_tungstenite::accept_hdr_async(
                        stream,
                        |req: &Request, resp: Response| {
                            assert_eq!(req.uri().path(), RUNNER_WS_PATH, "Runner 連到錯誤的路徑");
                            Ok(resp)
                        },
                    )
                    .await;
                    if let Ok(ws) = ws {
                        let _ = tx.send(RunnerSide {
                            ws,
                            events: Vec::new(),
                        });
                    }
                });
            }
        });
        Self {
            addr,
            connections,
            blobs,
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// 等 Runner 連上來。
    pub async fn accept(&mut self) -> RunnerSide {
        timeout(WAIT, self.connections.recv())
            .await
            .expect("Runner 沒有連上來")
            .expect("server 已關閉")
    }
}

/// 極簡的 HTTP PUT 處理：讀 header 與 body，存起來，回 200。
async fn handle_put(stream: TcpStream, blobs: Blobs) {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await.unwrap();
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_owned();
    let mut length = 0usize;
    let mut authorized = false;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            length = v.trim().parse().unwrap_or(0);
        }
        if lower.starts_with("authorization: bearer ") {
            authorized = true;
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await.unwrap();
    let id = path
        .strip_prefix(&format!("{RUNNER_BLOB_PATH}/"))
        .and_then(|rest| rest.split('?').next())
        .unwrap_or_default()
        .to_owned();
    let status = if authorized && !id.is_empty() {
        blobs.lock().unwrap().insert(id, body);
        "200 OK"
    } else {
        "401 Unauthorized"
    };
    let mut stream = reader.into_inner();
    let _ = stream
        .write_all(
            format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await;
}

/// Server 端看到的一條 Runner 連線。
pub struct RunnerSide {
    pub ws: WebSocketStream<TcpStream>,
    /// 這條連線上收到的 `event` frame（JSON）。
    pub events: Vec<Value>,
}

impl RunnerSide {
    /// 收下一個 frame（JSON）。連線關閉時回傳 `None`。
    pub async fn recv_value(&mut self) -> Option<Value> {
        loop {
            let message = timeout(WAIT, self.ws.next())
                .await
                .expect("等不到 Runner 的 frame")?;
            match message {
                Ok(Message::Text(text)) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "event" {
                        self.events.push(value.clone());
                    }
                    return Some(value);
                }
                Ok(Message::Close(_)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
    }

    pub async fn recv(&mut self) -> Value {
        self.recv_value().await.expect("Runner 關閉了連線")
    }

    /// 略過 heartbeat 與 agent_availability，取得下一個其他 frame。
    pub async fn recv_significant(&mut self) -> Value {
        loop {
            let v = self.recv().await;
            if v["type"] != "heartbeat" && v["type"] != "agent_availability" {
                return v;
            }
        }
    }

    /// 等到符合條件的 frame，途中的 frame 都略過（event 仍會記在 `events`）。
    pub async fn wait_for(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let v = tokio::time::timeout_at(deadline, self.recv())
                .await
                .unwrap_or_else(|_| {
                    panic!("等不到 {what}；已收到的 event：{:#?}", self.event_summary())
                });
            if pred(&v) {
                return v;
            }
        }
    }

    /// 等某個 kind 的 event。
    pub async fn wait_event(&mut self, kind: &str) -> Value {
        self.wait_for(kind, |v| v["type"] == "event" && v["kind"] == kind)
            .await
    }

    /// 等 Run 進入某個狀態。
    pub async fn wait_status(&mut self, status: &str) -> Value {
        self.wait_for(&format!("status {status}"), |v| {
            v["type"] == "event" && v["kind"] == "status_changed" && v["status"] == status
        })
        .await
    }

    pub async fn wait_control_result(&mut self, control_id: &str) -> Value {
        self.wait_for(&format!("run_control_result {control_id}"), |v| {
            v["type"] == "run_control_result" && v["control_id"] == control_id
        })
        .await
    }

    pub fn event_summary(&self) -> Vec<String> {
        self.events
            .iter()
            .map(|e| {
                let kind = e["kind"].as_str().unwrap_or("?");
                match kind {
                    "status_changed" => format!(
                        "{} status {}",
                        e["seq"],
                        e["status"].as_str().unwrap_or("?")
                    ),
                    "message_chunk" => format!(
                        "{} message {}",
                        e["seq"],
                        e["content"]["text"].as_str().unwrap_or("")
                    ),
                    "error" => format!("{} error {} {}", e["seq"], e["code"], e["message"]),
                    _ => format!("{} {kind}", e["seq"]),
                }
            })
            .collect()
    }

    pub async fn send_value(&mut self, value: &Value) {
        self.ws
            .send(Message::text(serde_json::to_string(value).unwrap()))
            .await
            .unwrap();
    }

    pub async fn send<T: serde::Serialize>(&mut self, frame: &T) {
        self.send_value(&serde_json::to_value(frame).unwrap()).await;
    }

    /// 完成交握：收 hello、回 hello_ack。回傳 hello。
    pub async fn handshake(&mut self, resume: Vec<RunResume>, runner_token: Option<&str>) -> Value {
        let hello = self.recv().await;
        assert_eq!(hello["type"], "hello", "第一個 frame 應該是 hello：{hello}");
        self.send(&orbis_protocol::frame::ServerToRunner::HelloAck(HelloAck {
            protocol_version: PROTOCOL_VERSION,
            runner_id: "0192f3a0-0000-7000-8000-000000000001".into(),
            runner_token: runner_token.map(str::to_owned),
            heartbeat_interval_ms: 200,
            resume,
        }))
        .await;
        hello
    }

    pub async fn control(
        &mut self,
        run_id: &str,
        dispatch_id: &str,
        control_id: &str,
        action: RunControlAction,
    ) -> Value {
        self.send(&orbis_protocol::frame::ServerToRunner::RunControl(
            RunControl {
                control_id: control_id.into(),
                run_id: run_id.into(),
                dispatch_id: dispatch_id.into(),
                action,
            },
        ))
        .await;
        self.wait_control_result(control_id).await
    }

    pub async fn ack(&mut self, run_id: &str, seq: u64) {
        self.send(&orbis_protocol::frame::ServerToRunner::EventAck(
            orbis_protocol::event::EventAck {
                run_id: run_id.into(),
                seq,
            },
        ))
        .await;
    }

    /// 確認這條連線上的 event seq 從 `from` 開始連續遞增。
    pub fn assert_contiguous(&self, run_id: &str, from: u64) {
        let seqs: Vec<u64> = self
            .events
            .iter()
            .filter(|e| e["run_id"] == run_id)
            .map(|e| e["seq"].as_u64().unwrap())
            .collect();
        let expected: Vec<u64> = (from..from + seqs.len() as u64).collect();
        assert_eq!(seqs, expected, "seq 必須連續：{:#?}", self.event_summary());
    }
}

/// 測試用的 DispatchOffer。
pub fn offer(
    run_id: &str,
    dispatch_id: &str,
    repo: DispatchRepo,
    agent: &str,
    prompt: &str,
) -> DispatchOffer {
    DispatchOffer {
        dispatch_id: dispatch_id.into(),
        run_id: run_id.into(),
        expires_at: "2999-01-01T00:00:00.000Z".into(),
        task: DispatchTask {
            task_id: "t1".into(),
            task_key: "ORB-1".into(),
            title: "測試 Task".into(),
        },
        run_seq: 1,
        repo,
        branch: Some(format!("orbis/ORB-1-{run_id}")),
        agent: agent.into(),
        model: None,
        permission_policy: PermissionPolicy::Auto,
        prompt: vec![ContentBlock::Text {
            text: prompt.into(),
        }],
        plan_gate: false,
        delegation: None,
        last_event_seq: 0,
    }
}

pub fn send_offer(offer: DispatchOffer) -> orbis_protocol::frame::ServerToRunner {
    orbis_protocol::frame::ServerToRunner::DispatchOffer(Box::new(offer))
}

pub fn result_outcome(result: &Value) -> &str {
    result["outcome"].as_str().unwrap_or("?")
}

/// 真正的 `orbis-runner` 程序；stderr 持續讀進記憶體（避免 pipe 塞滿），失敗時印出來。
pub struct RunnerProcess {
    pub child: Child,
    pub stderr: Arc<Mutex<String>>,
}

impl RunnerProcess {
    pub fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    pub async fn wait_exit(&mut self) -> std::process::ExitStatus {
        timeout(WAIT, self.child.wait())
            .await
            .unwrap_or_else(|_| panic!("Runner 沒有結束；stderr：\n{}", self.stderr()))
            .unwrap()
    }
}

/// 啟動 Runner 的設定。
pub struct RunnerOptions<'a> {
    pub server: Option<&'a str>,
    pub pairing_token: Option<&'a str>,
    pub home: &'a Path,
    pub extra_args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub stdin_piped: bool,
    pub stdout_piped: bool,
}

impl<'a> RunnerOptions<'a> {
    pub fn new(server: &'a str, home: &'a Path) -> Self {
        Self {
            server: Some(server),
            pairing_token: Some("pt_test"),
            home,
            extra_args: Vec::new(),
            env: Vec::new(),
            stdin_piped: false,
            stdout_piped: false,
        }
    }
}

pub fn spawn_runner(opts: RunnerOptions<'_>) -> RunnerProcess {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_orbis-runner"));
    if let Some(server) = opts.server {
        cmd.args(["--server", server]);
    }
    if let Some(token) = opts.pairing_token {
        cmd.args(["--pairing-token", token]);
    }
    cmd.arg("--home").arg(opts.home);
    cmd.args(&opts.extra_args);
    // 不繼承測試環境中的 Runner 設定。
    for (key, _) in std::env::vars() {
        if key.starts_with(names::ENV_PREFIX) {
            cmd.env_remove(key);
        }
    }
    cmd.env_remove(names::env_var(ENV_SERVER_URL))
        .env_remove(names::env_var(ENV_PAIRING_TOKEN))
        .env_remove(names::env_var(ENV_HOME))
        .env(names::env_var("LOG"), "info,orbis_runner=debug")
        .envs(super::GIT_IDENTITY)
        .envs(opts.env)
        .stdin(if opts.stdin_piped {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if opts.stdout_piped {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().unwrap();
    let stderr = Arc::new(Mutex::new(String::new()));
    let pipe = child.stderr.take().unwrap();
    let sink = stderr.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut s = sink.lock().unwrap();
            s.push_str(&line);
            s.push('\n');
        }
    });
    RunnerProcess { child, stderr }
}

/// 在 Runner 本機目錄寫入 runner.toml。
pub fn write_runner_toml(home: &Path, content: &str) -> PathBuf {
    std::fs::create_dir_all(home).unwrap();
    let path = home.join(orbis_runner::contract::RUNNER_CONFIG_FILE);
    std::fs::write(&path, content).unwrap();
    path
}

/// runner.toml：Worktree 根目錄放在測試的暫存目錄，加上一個以 Fake Agent 執行指定劇本的 Agent `fake`。
pub fn fake_agent_toml(wt_root: &Path, script: &Path) -> String {
    format!(
        "worktree_root = {}\n[agents.fake]\ncommand = {}\nargs = [\"--script\", {}]\n",
        super::toml_string(&wt_root.to_string_lossy()),
        super::toml_string(&super::fake_agent_bin().to_string_lossy()),
        super::toml_string(&script.to_string_lossy()),
    )
}

/// RunControlResult（解析成協定型別，確認格式正確）。
pub fn parse_result(value: &Value) -> RunControlResult {
    serde_json::from_value(value.clone())
        .unwrap_or_else(|e| panic!("不合法的 run_control_result：{e}\n{value}"))
}

/// 行程是否還在執行。
pub fn process_alive(pid: u32) -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!(" {pid} "))
    } else {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success()
    }
}
