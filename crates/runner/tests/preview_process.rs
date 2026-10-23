//! Preview 的 dev server（ARCHITECTURE §13）：真正的 `orbis-runner` 執行檔 ↔ 扮演 Server 的
//! WebSocket，Agent 是 Fake Agent，Repo 是真實 git 的 bare remote，dev server 是 node 寫的小 server。

mod support;

use std::time::Duration;

use orbis_protocol::control::RunControlAction;
use orbis_protocol::enums::{GateDecision, GateKind};
use orbis_protocol::names::{ENV_PORT, ENV_RUN_ID};
use serde_json::Value;
use support::server::{
    FakeServer, RunnerOptions, RunnerSide, fake_agent_toml, offer, process_alive, result_outcome,
    send_offer, spawn_runner, write_runner_toml,
};
use support::{Remote, cfg, runner_script, script, temp_dir, toml_string};

/// 測試用的 dev server：
/// - 監聽注入的 port（不指定 host，和 Vite 一樣可能只綁 IPv6）。
/// - 啟動後 1 秒內 `/ready` 回 503，之後回 200。
/// - `/info` 回傳自己與子程序的 pid、收到的環境變數。
/// - 另外開一個不會自己結束的子程序，用來確認結束時整個程序樹都被結束。
fn dev_server_js() -> String {
    format!(
        r#"const http = require("http");
const {{ spawn }} = require("child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{ stdio: "ignore" }});
const started = Date.now();
console.log("dev server 啟動中");
http.createServer((req, res) => {{
  if (req.url === "/ready") {{
    res.writeHead(Date.now() - started > 1000 ? 200 : 503);
    res.end();
    return;
  }}
  if (req.url === "/info") {{
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({{
      pid: process.pid,
      child: child.pid,
      port: process.env.{ENV_PORT},
      runId: process.env.{ENV_RUN_ID},
      host: req.headers.host,
    }}));
    return;
  }}
  res.end("hello preview");
}}).listen(Number(process.env.{ENV_PORT}));
"#
    )
}

/// 啟動後輸出一行再以結束碼 3 結束的 dev server。
const CRASHING_SERVER_JS: &str = r#"console.log("無法載入 vite.config.ts");
process.exit(3);
"#;

fn preview_config(command: &str, ready_path: &str) -> String {
    format!(
        "[preview]\ncommand = {}\nready_path = {}\n",
        toml_string(command),
        toml_string(ready_path)
    )
}

struct Env {
    _dir: tempfile::TempDir,
    _remote: Remote,
    server: FakeServer,
    home: std::path::PathBuf,
    repo: orbis_protocol::dispatch::DispatchRepo,
}

impl Env {
    async fn new(files: &[(&str, &str)], agent_script: &std::path::Path) -> Self {
        let dir = temp_dir("orbis preview");
        let remote = Remote::new(files);
        let home = dir.path().join("home");
        // 各測試平行執行、各有自己的 Runner 本機目錄，預設的 port 範圍會互相衝突，所以從
        // 系統分配的空閒 port 開始。
        let free = std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        write_runner_toml(
            &home,
            &format!(
                "port_range = [{free}, {}]
{}",
                free.saturating_add(10),
                fake_agent_toml(&dir.path().join("wt"), agent_script)
            ),
        );
        let repo = remote.dispatch_repo("web");
        Self {
            _dir: dir,
            _remote: remote,
            server: FakeServer::start().await,
            home,
            repo,
        }
    }

    /// 啟動 Runner、送出 Dispatch，並核准設定檔中的腳本（Preview 指令也需要核准）。
    async fn dispatch(&mut self) -> (support::server::RunnerProcess, RunnerSide) {
        let runner = spawn_runner(RunnerOptions::new(&self.server.base_url(), &self.home));
        let mut conn = self.server.accept().await;
        conn.handshake(Vec::new(), Some("rt_test")).await;
        conn.send(&send_offer(offer(
            "r1",
            "d-r1",
            self.repo.clone(),
            "fake",
            "做事",
        )))
        .await;
        let reply = conn
            .wait_for("dispatch 回覆", |v| v["type"] == "dispatch_accept")
            .await;
        assert_eq!(reply["type"], "dispatch_accept", "{reply}");
        let request = conn.wait_event("permission_request").await;
        assert_eq!(request["purpose"], "config_trust", "{request}");
        assert!(
            request["title"].as_str().unwrap().contains("node"),
            "Preview 指令要列在信任核准中：{request}"
        );
        let result = conn
            .control(
                "r1",
                "d-r1",
                "trust",
                RunControlAction::PermissionResponse {
                    request_id: request["request_id"].as_str().unwrap().into(),
                    option_id: "allow_once".into(),
                },
            )
            .await;
        assert_eq!(result_outcome(&result), "applied");
        (runner, conn)
    }
}

async fn get(url: &str) -> reqwest::Response {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(url)
        .send()
        .await
        .unwrap_or_else(|e| panic!("GET {url} 失敗：{e}"))
}

/// 等到 `pid` 不在執行，最多 15 秒。
async fn wait_dead(pid: u64, what: &str) {
    let pid = u32::try_from(pid).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while process_alive(pid) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{what}（pid {pid}）仍在執行"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 等到 port 沒有人監聽，最多 15 秒。
async fn wait_port_closed(port: u16) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let v4 = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok();
        let v6 = tokio::net::TcpStream::connect(("::1", port)).await.is_ok();
        if !v4 && !v6 {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "port {port} 仍在監聽"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 等 Run 進入某個狀態；已經收過就直接回傳（和 `preview_ready` 的先後順序不固定）。
async fn reached_status(conn: &mut RunnerSide, status: &str) {
    let seen = conn
        .events
        .iter()
        .any(|e| e["kind"] == "status_changed" && e["status"] == status);
    if !seen {
        conn.wait_status(status).await;
    }
}

async fn preview_info(ready: &Value) -> Value {
    let port = ready["port"].as_u64().unwrap();
    let text = get(&format!("http://localhost:{port}/info"))
        .await
        .text()
        .await
        .unwrap();
    serde_json::from_str(&text).unwrap_or_else(|e| {
        panic!(
            "/info 不是 JSON：{e}
{text}"
        )
    })
}

/// 完成條件：依 `[preview].command` 以注入的 port 啟動 dev server，`ready_path` 就緒後送出
/// `preview_ready`；Run 取消後整個程序樹結束、port 釋放。
#[tokio::test(flavor = "multi_thread")]
async fn 依設定啟動_就緒後回報_取消後結束整個程序樹() {
    let mut env = Env::new(
        &[
            ("server.js", &dev_server_js()),
            (&cfg(), &preview_config("node server.js", "/ready")),
        ],
        &runner_script("simple.yaml"),
    )
    .await;
    let (_runner, mut conn) = env.dispatch().await;

    let ready = conn.wait_event("preview_ready").await;
    let port = u16::try_from(ready["port"].as_u64().unwrap()).unwrap();
    assert_eq!(
        ready["url"],
        format!("http://localhost:{port}/ready"),
        "{ready}"
    );
    // 就緒判斷要等 /ready 回 200，不能在 503 時就回報。
    assert_eq!(
        get(&format!("http://localhost:{port}/ready"))
            .await
            .status(),
        200
    );
    let info = preview_info(&ready).await;
    assert_eq!(info["port"], port.to_string(), "{info}");
    assert_eq!(info["runId"], "r1", "{info}");

    reached_status(&mut conn, "awaiting_gate").await;
    // 等待 Review Gate 時 Preview 仍在執行。
    assert_eq!(
        get(&format!("http://localhost:{port}/"))
            .await
            .text()
            .await
            .unwrap(),
        "hello preview"
    );

    let result = conn
        .control("r1", "d-r1", "c1", RunControlAction::Cancel)
        .await;
    assert_eq!(result_outcome(&result), "applied");
    conn.wait_status("canceled").await;
    wait_dead(info["pid"].as_u64().unwrap(), "dev server").await;
    wait_dead(info["child"].as_u64().unwrap(), "dev server 開的子程序").await;
    wait_port_closed(port).await;
}

/// Review 核准並 push 後 Run 進入 completed，Preview 一併結束。
#[tokio::test(flavor = "multi_thread")]
async fn run_完成後結束_preview() {
    let mut env = Env::new(
        &[
            ("server.js", &dev_server_js()),
            (&cfg(), &preview_config("node server.js", "/ready")),
        ],
        &script("diff.yaml"),
    )
    .await;
    let (_runner, mut conn) = env.dispatch().await;
    let ready = conn.wait_event("preview_ready").await;
    let info = preview_info(&ready).await;
    reached_status(&mut conn, "awaiting_gate").await;

    let result = conn
        .control(
            "r1",
            "d-r1",
            "approve",
            RunControlAction::GateResult {
                gate: GateKind::Review,
                decision: GateDecision::Approved,
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied");
    let result = conn
        .control("r1", "d-r1", "push", RunControlAction::PushBranch)
        .await;
    assert_eq!(result_outcome(&result), "branch_pushed", "{result}");
    conn.wait_status("completed").await;
    wait_dead(info["pid"].as_u64().unwrap(), "dev server").await;
    wait_dead(info["child"].as_u64().unwrap(), "dev server 開的子程序").await;
}

/// dev server 自己結束時回報原因、結束碼與輸出尾段，Run 本身不受影響。
#[tokio::test(flavor = "multi_thread")]
async fn dev_server_自己結束時回報輸出() {
    let mut env = Env::new(
        &[
            ("crash.js", CRASHING_SERVER_JS),
            (&cfg(), &preview_config("node crash.js", "/")),
        ],
        &runner_script("simple.yaml"),
    )
    .await;
    let (_runner, mut conn) = env.dispatch().await;
    // TODO(contract): 契約 v2 加入 `preview_stopped` Event 後改成等它，並檢查 reason／exit_code 欄位（#29）。
    let stopped = conn
        .wait_for("Preview 停止", |v| {
            v["kind"] == "error"
                && v["message"]
                    .as_str()
                    .is_some_and(|m| m.starts_with("Preview 已停止"))
        })
        .await;
    let message = stopped["message"].as_str().unwrap();
    assert!(message.contains("exited"), "{message}");
    assert!(message.contains('3'), "{message}");
    assert!(message.contains("無法載入 vite.config.ts"), "{message}");
    assert_eq!(stopped["fatal"], false, "{stopped}");
    reached_status(&mut conn, "awaiting_gate").await;
    assert!(
        !conn.events.iter().any(|e| e["kind"] == "preview_ready"),
        "沒有就緒就不能回報 preview_ready"
    );
}
