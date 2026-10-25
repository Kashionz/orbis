//! 互動式終端機（terminal，ARCHITECTURE §6.5、ADR-0014）：真正的 PTY（Windows 是 ConPTY，macOS 是
//! openpty），shell 用平台預設的（Windows 的 PowerShell、macOS 的 `$SHELL`）。

mod support;

use std::time::Duration;

use base64::Engine as _;
use orbis_protocol::enums::RunnerKind;
use orbis_protocol::frame::ServerToRunner;
use orbis_protocol::terminal::{
    TERMINAL_MAX_CHUNK, TerminalClose, TerminalInput, TerminalOpen, TerminalResize,
};
use serde_json::Value;
use support::flow::Env;
use support::runner_script;
use support::server::{RunnerSide, fake_agent_toml};

/// 跑完一個 Run（Worktree 留著），回傳連線。`kind` 是 `hello_ack` 回報的 Runner 種類。
async fn run_done(
    extra_toml: &str,
    kind: Option<RunnerKind>,
) -> (Env, support::server::RunnerProcess, RunnerSide) {
    let extra = extra_toml.to_owned();
    let mut env = Env::new(&[("README.md", "# web\n")], move |wt| {
        format!(
            "{extra}\n{}",
            fake_agent_toml(wt, &runner_script("simple.yaml"))
        )
    })
    .await;
    let runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake_as(Vec::new(), Some("rt_test"), kind).await;
    env.offer(&mut conn, "r1", "fake", "做事", 1).await;
    conn.wait_status("awaiting_gate").await;
    (env, runner, conn)
}

async fn open(conn: &mut RunnerSide, id: &str, run: &str) {
    conn.send(&ServerToRunner::TerminalOpen(TerminalOpen {
        terminal_id: id.into(),
        run_id: run.into(),
        cols: 120,
        rows: 30,
    }))
    .await;
}

async fn input(conn: &mut RunnerSide, id: &str, text: &str) {
    conn.send(&ServerToRunner::TerminalInput(TerminalInput {
        terminal_id: id.into(),
        data: base64::engine::general_purpose::STANDARD.encode(text),
    }))
    .await;
}

async fn exited(conn: &mut RunnerSide, id: &str) -> Value {
    conn.wait_for(&format!("terminal_exited {id}"), |v| {
        v["type"] == "terminal_exited" && v["terminal_id"] == id
    })
    .await
}

/// 到目前為止 `id` 的輸出（解碼後串起來）與各個 frame 解碼後的大小。
fn output(conn: &RunnerSide, id: &str) -> (String, Vec<usize>) {
    let chunks: Vec<Vec<u8>> = conn
        .frames()
        .iter()
        .filter(|v| v["type"] == "terminal_output" && v["terminal_id"] == id)
        .map(|v| {
            base64::engine::general_purpose::STANDARD
                .decode(v["data"].as_str().unwrap())
                .unwrap()
        })
        .collect();
    let sizes = chunks.iter().map(Vec::len).collect();
    (
        String::from_utf8_lossy(&chunks.concat()).into_owned(),
        sizes,
    )
}

/// 游標位置的查詢（DSR）。ConPTY 啟動時會送出它，等終端機回覆後才繼續；真實環境中由 xterm.js 回覆，
/// 測試扮演終端機回覆。
const CURSOR_QUERY: &str = "\u{1b}[6n";
const CURSOR_REPLY: &str = "\u{1b}[1;1R";

/// 扮演終端機：回覆還沒回覆過的游標位置查詢。`answered` 是這個終端機已回覆的次數。
async fn answer_queries(conn: &mut RunnerSide, id: &str, answered: &mut usize) {
    let asked = output(conn, id).0.matches(CURSOR_QUERY).count();
    while *answered < asked {
        input(conn, id, CURSOR_REPLY).await;
        *answered += 1;
    }
}

/// 等 `id` 的輸出出現 `needle`（期間回覆游標位置的查詢）。
async fn wait_output(conn: &mut RunnerSide, id: &str, needle: &str, answered: &mut usize) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        answer_queries(conn, id, answered).await;
        if output(conn, id).0.contains(needle) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "等不到終端機輸出 {needle:?}；目前的輸出：{:?}",
            output(conn, id).0
        );
        conn.drain(Duration::from_millis(200)).await;
    }
}

/// 等 shell 啟動：有輸出（提示字元）之後再等一下，期間回覆游標位置的查詢。
async fn ready(conn: &mut RunnerSide, id: &str, answered: &mut usize) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while output(conn, id).0.is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "shell 沒有任何輸出");
        conn.drain(Duration::from_millis(200)).await;
    }
    for _ in 0..5 {
        answer_queries(conn, id, answered).await;
        conn.drain(Duration::from_millis(200)).await;
    }
}

/// 印出 `ok-42` 的指令：輸入的字（終端機會回顯）中沒有 `ok-42`，看到它就是指令真的執行了。
fn print_42() -> &'static str {
    if cfg!(windows) {
        "Write-Output ('ok-' + (40 + 2))\r"
    } else {
        "echo ok-$((40 + 2))\r"
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn 在_worktree_中開終端機_輸入指令看到輸出_exit_後結束() {
    let (_env, _runner, mut conn) = run_done("", Some(RunnerKind::Local)).await;
    open(&mut conn, "t1", "r1").await;
    let mut answered = 0;
    ready(&mut conn, "t1", &mut answered).await;
    conn.send(&ServerToRunner::TerminalResize(TerminalResize {
        terminal_id: "t1".into(),
        cols: 100,
        rows: 40,
    }))
    .await;
    input(&mut conn, "t1", print_42()).await;
    wait_output(&mut conn, "t1", "ok-42", &mut answered).await;
    // cwd 是 Worktree（目錄名稱是 `<task-key>-<run-seq>`），注入的環境變數可以用。
    let probe = if cfg!(windows) {
        "Write-Output ('cwd=' + (Split-Path -Leaf (Get-Location)) + ' key=' + $env:TASK_KEY_VAR)\r"
    } else {
        "echo cwd=$(basename \"$PWD\") key=$TASK_KEY_VAR\r"
    };
    let probe = probe.replace("TASK_KEY_VAR", orbis_protocol::names::ENV_TASK_KEY);
    input(&mut conn, "t1", &probe).await;
    wait_output(&mut conn, "t1", "cwd=ORB-1-1 key=ORB-1", &mut answered).await;
    input(&mut conn, "t1", "exit\r").await;
    let done = exited(&mut conn, "t1").await;
    assert_eq!(done["reason"], "exited", "{done}");
    assert_eq!(done["code"], 0, "{done}");
}

#[tokio::test(flavor = "multi_thread")]
async fn 關閉_上限_不認得的_terminal_id_與大量輸出的分塊() {
    let (_env, _runner, mut conn) = run_done("", Some(RunnerKind::Local)).await;
    for id in ["a", "b", "c"] {
        open(&mut conn, id, "r1").await;
    }
    open(&mut conn, "d", "r1").await;
    let limit = exited(&mut conn, "d").await;
    assert_eq!(limit["reason"], "limit_exceeded", "{limit}");

    // 不認得的 terminal_id：忽略，不影響其他終端機。
    input(&mut conn, "nope", "exit\r").await;
    conn.send(&ServerToRunner::TerminalClose(TerminalClose {
        terminal_id: "nope".into(),
    }))
    .await;

    let big = if cfg!(windows) {
        "Write-Output ('x' * 200000); Write-Output ('end-' + 'of-output')\r"
    } else {
        "head -c 200000 /dev/zero | tr '\\0' x; echo; echo end-$(echo of-output)\r"
    };
    let mut answered = 0;
    ready(&mut conn, "a", &mut answered).await;
    input(&mut conn, "a", big).await;
    wait_output(&mut conn, "a", "end-of-output", &mut answered).await;
    let (_, sizes) = output(&conn, "a");
    assert!(sizes.iter().all(|s| *s <= TERMINAL_MAX_CHUNK), "{sizes:?}");

    conn.send(&ServerToRunner::TerminalClose(TerminalClose {
        terminal_id: "b".into(),
    }))
    .await;
    let closed = exited(&mut conn, "b").await;
    assert_eq!(closed["reason"], "closed");
    assert_eq!(closed["code"], Value::Null);
    // 關掉一個之後可以再開。
    open(&mut conn, "e", "r1").await;
    let mut answered = 0;
    ready(&mut conn, "e", &mut answered).await;
    input(&mut conn, "e", print_42()).await;
    wait_output(&mut conn, "e", "ok-42", &mut answered).await;
    assert!(
        !conn
            .frames()
            .iter()
            .any(|v| v["type"] == "terminal_exited" && v["terminal_id"] == "nope"),
        "不認得的 terminal_id 不回 terminal_exited"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn 閒置逾時後關閉() {
    let (_env, _runner, mut conn) =
        run_done("terminal_idle_timeout_secs = 2", Some(RunnerKind::Local)).await;
    open(&mut conn, "t1", "r1").await;
    let started = tokio::time::Instant::now();
    let done = exited(&mut conn, "t1").await;
    assert_eq!(done["reason"], "idle_timeout", "{done}");
    assert!(started.elapsed() >= Duration::from_secs(2));
}

#[tokio::test(flavor = "multi_thread")]
async fn runner_toml_的開關_team_runner_與不知道種類時預設不允許() {
    for (extra, kind, expected) in [
        ("", Some(RunnerKind::Team), "disabled"),
        ("", None, "disabled"),
        (
            "allow_terminal = false",
            Some(RunnerKind::Local),
            "disabled",
        ),
        ("allow_terminal = true", Some(RunnerKind::Team), "exited"),
    ] {
        let (_env, _runner, mut conn) = run_done(extra, kind).await;
        open(&mut conn, "t1", "r1").await;
        if expected == "exited" {
            ready(&mut conn, "t1", &mut 0).await;
            input(&mut conn, "t1", "exit\r").await;
        }
        let done = exited(&mut conn, "t1").await;
        assert_eq!(done["reason"], expected, "{extra} {kind:?}：{done}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn 沒有這個_run_的_worktree() {
    let (_env, _runner, mut conn) = run_done("", Some(RunnerKind::Local)).await;
    open(&mut conn, "t1", "no-such-run").await;
    let done = exited(&mut conn, "t1").await;
    assert_eq!(done["reason"], "worktree_missing", "{done}");
    // Worktree 刪掉之後也一樣。
    let ready = conn
        .frames()
        .iter()
        .find(|v| v["kind"] == "worktree_ready")
        .cloned()
        .unwrap();
    let wt = std::path::PathBuf::from(ready["worktree_path"].as_str().unwrap());
    std::fs::remove_dir_all(wt.join(".git")).ok();
    std::fs::remove_file(wt.join(".git")).ok();
    open(&mut conn, "t2", "r1").await;
    let done = exited(&mut conn, "t2").await;
    assert_eq!(done["reason"], "worktree_missing", "{done}");
}
