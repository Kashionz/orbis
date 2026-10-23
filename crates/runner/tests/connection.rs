//! 啟動真正的 `orbis-runner` 執行檔，用扮演 Server 的 WebSocket 驗證連線流程：
//! Pairing 與 Runner token、重新連線、Dispatch 的驗證、RunControl 的分派、sidecar 協定、結束碼。

mod support;

use std::time::Duration;

use orbis_protocol::connection::{HelloRejectReason, HelloRejected};
use orbis_protocol::control::RunControlAction;
use orbis_protocol::dispatch::DispatchDelegation;
use orbis_protocol::enums::DelegationMode;
use orbis_protocol::frame::ServerToRunner;
use orbis_protocol::sidecar::{
    SIDECAR_EXIT_NEEDS_PAIRING, SIDECAR_EXIT_VERSION_MISMATCH, SIDECAR_FLAG,
};
use orbis_protocol::{PROTOCOL_VERSION, names};
use support::server::{
    FakeServer, RunnerOptions, fake_agent_toml, offer, send_offer, spawn_runner, write_runner_toml,
};
use support::{Remote, runner_script, script, temp_dir};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn reject(reason: HelloRejectReason) -> ServerToRunner {
    ServerToRunner::HelloRejected(HelloRejected {
        reason,
        server_protocol_version: PROTOCOL_VERSION,
        message: "Server 拒絕".into(),
    })
}

/// 第一個 frame 是合法的 Hello（Pairing token、名稱、平台）。
#[tokio::test]
async fn first_frame_is_a_valid_hello() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let base = server.base_url();
    let mut opts = RunnerOptions::new(&base, home.path());
    opts.extra_args = vec!["--name".into(), "測試 Runner".into()];
    let _runner = spawn_runner(opts);
    let mut conn = server.accept().await;
    let hello = conn.recv().await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol_version"], PROTOCOL_VERSION);
    assert_eq!(hello["pairing"]["kind"], "pairing_token");
    assert_eq!(hello["pairing"]["token"], "pt_test");
    assert_eq!(hello["runner"]["name"], "測試 Runner");
    assert_eq!(hello["runner"]["os"], std::env::consts::OS);
    assert_eq!(hello["runner"]["arch"], std::env::consts::ARCH);
    assert_eq!(hello["runner"]["runner_version"], env!("CARGO_PKG_VERSION"));
}

/// HelloAck 之後回報 AgentAvailability（內建的 Claude Code 與 runner.toml 的 Agent），並持續送 Heartbeat。
#[tokio::test]
async fn reports_availability_and_heartbeats_after_hello_ack() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    write_runner_toml(
        home.path(),
        &fake_agent_toml(&home.path().join("wt"), &runner_script("simple.yaml")),
    );
    let _runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    conn.handshake(Vec::new(), Some("rt_1")).await;
    let availability = conn.recv().await;
    assert_eq!(availability["type"], "agent_availability");
    let agents = availability["agents"].as_array().unwrap();
    let ids: Vec<&str> = agents.iter().map(|a| a["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"claude-code"), "{ids:?}");
    assert!(ids.contains(&"fake"), "{ids:?}");
    let fake = agents.iter().find(|a| a["id"] == "fake").unwrap();
    assert_eq!(fake["available"], true, "{fake}");
    let claude = agents.iter().find(|a| a["id"] == "claude-code").unwrap();
    assert!(
        claude["permission_gaps"]
            .as_array()
            .is_some_and(|g| !g.is_empty()),
        "Claude Code 的權限落差要回報：{claude}"
    );
    let credentials = availability["credentials"].as_array().unwrap();
    assert!(credentials.iter().all(|c| c["max_concurrent_runs"] == 30));

    let mut heartbeats = 0;
    while heartbeats < 2 {
        let hb = conn.recv().await;
        // 背景探測完 Agent 的能力旗標後會再送一次 agent_availability（issue #18）。
        if hb["type"] == "agent_availability" {
            continue;
        }
        heartbeats += 1;
        assert_eq!(hb["type"], "heartbeat", "{hb}");
        assert!(hb["ts"].as_str().unwrap().ends_with('Z'));
        assert_eq!(hb["active_run_ids"], serde_json::json!([]));
        assert_eq!(hb["accepting_dispatches"], true);
    }
}

/// 第一次 Pairing 後保存 Runner token；Runner 重新啟動後改用 Runner token，忽略 Pairing token。
#[tokio::test]
async fn saves_runner_token_and_uses_it_after_restart() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let mut runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    conn.handshake(Vec::new(), Some("rt_saved")).await;
    conn.recv().await; // agent_availability
    runner.child.kill().await.unwrap();
    drop(conn);

    let _runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    let hello = conn.recv().await;
    assert_eq!(hello["pairing"]["kind"], "runner_token", "{hello}");
    assert_eq!(hello["pairing"]["token"], "rt_saved");
    assert_eq!(
        hello["pairing"]["runner_id"],
        "0192f3a0-0000-7000-8000-000000000001"
    );
}

/// 保存的 Runner token 被拒絕、但有 Pairing token 時，改用 Pairing token 重新 Pairing。
#[tokio::test]
async fn falls_back_to_pairing_when_runner_token_is_rejected() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let mut runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    conn.handshake(Vec::new(), Some("rt_old")).await;
    conn.recv().await;
    runner.child.kill().await.unwrap();
    drop(conn);

    let _runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    let hello = conn.recv().await;
    assert_eq!(hello["pairing"]["kind"], "runner_token");
    conn.send(&reject(HelloRejectReason::InvalidRunnerToken))
        .await;
    conn.ws.close(None).await.ok();
    let mut conn = server.accept().await;
    let hello = conn.recv().await;
    assert_eq!(hello["pairing"]["kind"], "pairing_token", "{hello}");
    assert_eq!(hello["pairing"]["token"], "pt_test");
}

/// Server 關閉連線後以指數退避重新連線。
#[tokio::test]
async fn reconnects_after_the_server_closes_the_connection() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let _runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    conn.handshake(Vec::new(), Some("rt_1")).await;
    conn.ws.close(None).await.ok();
    drop(conn);
    let started = tokio::time::Instant::now();
    let mut conn = server.accept().await;
    assert!(
        started.elapsed() >= Duration::from_millis(700),
        "要等退避時間才重新連線"
    );
    let hello = conn.recv().await;
    assert_eq!(hello["type"], "hello");
}

/// Pairing token 被拒絕：印出原因並以「需要重新 Pairing」的結束碼結束。
#[tokio::test]
async fn exits_with_needs_pairing_code_when_pairing_is_rejected() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let mut runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    conn.recv().await;
    conn.send(&reject(HelloRejectReason::InvalidPairingToken))
        .await;
    conn.ws.close(None).await.ok();
    let status = runner.wait_exit().await;
    assert_eq!(
        status.code(),
        Some(SIDECAR_EXIT_NEEDS_PAIRING),
        "stderr：{}",
        runner.stderr()
    );
    assert!(
        runner.stderr().contains("invalid_pairing_token"),
        "{}",
        runner.stderr()
    );
}

/// 協定版本不相容：以「需要更新 Runner」的結束碼結束。
#[tokio::test]
async fn exits_with_version_mismatch_code_on_version_mismatch() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let mut runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    conn.recv().await;
    conn.send(&reject(HelloRejectReason::VersionMismatch)).await;
    let status = runner.wait_exit().await;
    assert_eq!(
        status.code(),
        Some(SIDECAR_EXIT_VERSION_MISMATCH),
        "stderr：{}",
        runner.stderr()
    );
}

/// 沒有保存的 Runner token、也沒有 Pairing token：需要重新 Pairing，訊息說明要設定的環境變數。
#[tokio::test]
async fn exits_with_needs_pairing_code_without_any_identity() {
    let server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let base = server.base_url();
    let mut opts = RunnerOptions::new(&base, home.path());
    opts.pairing_token = None;
    let mut runner = spawn_runner(opts);
    let status = runner.wait_exit().await;
    assert_eq!(status.code(), Some(SIDECAR_EXIT_NEEDS_PAIRING));
    assert!(
        runner
            .stderr()
            .contains(&names::ENV_PAIRING_TOKEN.to_owned()),
        "{}",
        runner.stderr()
    );
}

/// 缺少 Server 網址時，錯誤訊息說明要設定的環境變數。
#[tokio::test]
async fn missing_server_names_the_environment_variable() {
    let home = temp_dir("orbis home");
    let mut opts = RunnerOptions::new("", home.path());
    opts.server = None;
    let mut runner = spawn_runner(opts);
    let status = runner.wait_exit().await;
    assert!(!status.success());
    assert!(
        runner.stderr().contains(&names::ENV_SERVER_URL.to_owned()),
        "{}",
        runner.stderr()
    );
}

/// Pairing token 以 `-` 開頭時（base64url 可能如此），仍當成 `--pairing-token` 的值（issue #21）。
#[tokio::test]
async fn pairing_token_may_start_with_a_hyphen() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let base = server.base_url();
    let mut opts = RunnerOptions::new(&base, home.path());
    opts.pairing_token = Some("-uAbC_123");
    let _runner = spawn_runner(opts);
    let mut conn = server.accept().await;
    let hello = conn.recv().await;
    assert_eq!(hello["pairing"]["token"], "-uAbC_123");
}

/// 沒有參數時從環境變數讀取連線設定。
#[tokio::test]
async fn reads_connection_settings_from_environment() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let mut opts = RunnerOptions::new("", home.path());
    opts.server = None;
    opts.pairing_token = None;
    opts.env = vec![
        (names::ENV_SERVER_URL.to_owned(), server.base_url()),
        (names::ENV_PAIRING_TOKEN.to_owned(), "pt_env".into()),
    ];
    let _runner = spawn_runner(opts);
    let mut conn = server.accept().await;
    let hello = conn.recv().await;
    assert_eq!(hello["pairing"]["token"], "pt_env");
}

/// Dispatch 的驗證：過期、沒有這個 Agent、尚未支援的 Delegation、重複的 Run。
#[tokio::test]
async fn validates_dispatch_offers() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let remote = Remote::new(&[("README.md", "a\n")]);
    write_runner_toml(
        home.path(),
        &fake_agent_toml(&home.path().join("wt"), &script("cancel.yaml")),
    );
    let _runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    conn.handshake(Vec::new(), Some("rt_1")).await;

    let cases = [
        ("expired", {
            let mut o = offer("r1", "d1", remote.dispatch_repo("web"), "fake", "x");
            o.expires_at = "2000-01-01T00:00:00.000Z".into();
            o
        }),
        (
            "agent_unavailable",
            offer(
                "r2",
                "d2",
                remote.dispatch_repo("web"),
                "no-such-agent",
                "x",
            ),
        ),
        ("unsupported", {
            let mut o = offer("r3", "d3", remote.dispatch_repo("web"), "fake", "x");
            o.delegation = Some(DispatchDelegation {
                parent_run_id: "p".into(),
                mode: DelegationMode::Consult,
                depth: None,
                child_seq: None,
            });
            o
        }),
    ];
    for (reason, o) in cases {
        let id = o.dispatch_id.to_string();
        conn.send(&send_offer(o)).await;
        let reply = conn.recv_significant().await;
        assert_eq!(reply["type"], "dispatch_reject", "{reply}");
        assert_eq!(reply["dispatch_id"], id);
        assert_eq!(reply["reason"], reason, "{reply}");
    }

    // 正在執行的 Run 再派一次：duplicate。
    conn.send(&send_offer(offer(
        "r4",
        "d4",
        remote.dispatch_repo("web"),
        "fake",
        "x",
    )))
    .await;
    let reply = conn
        .wait_for("accept", |v| v["type"] == "dispatch_accept")
        .await;
    assert_eq!(reply["dispatch_id"], "d4");
    conn.wait_status("running").await;
    let hb = conn
        .wait_for("heartbeat", |v| v["type"] == "heartbeat")
        .await;
    assert_eq!(hb["active_run_ids"], serde_json::json!(["r4"]));
    conn.send(&send_offer(offer(
        "r4",
        "d5",
        remote.dispatch_repo("web"),
        "fake",
        "x",
    )))
    .await;
    let reply = conn
        .wait_for("reject", |v| v["type"] == "dispatch_reject")
        .await;
    assert_eq!(reply["reason"], "duplicate");

    // RunControl：Dispatch 不符 → stale_dispatch；沒有這個 Run → unknown_run；執行中送 prompt → invalid_state。
    let stale = conn
        .control("r4", "d-old", "c1", RunControlAction::Cancel)
        .await;
    assert_eq!(stale["reason"], "stale_dispatch");
    let unknown = conn
        .control("nope", "d4", "c2", RunControlAction::Cancel)
        .await;
    assert_eq!(unknown["reason"], "unknown_run");
    let busy = conn
        .control(
            "r4",
            "d4",
            "c3",
            RunControlAction::Prompt {
                prompt: Vec::new(),
                source: None,
            },
        )
        .await;
    assert_eq!(busy["reason"], "invalid_state");
    let cancel = conn
        .control("r4", "d4", "c4", RunControlAction::Cancel)
        .await;
    assert_eq!(cancel["outcome"], "applied");
    conn.wait_status("canceled").await;
}

/// sidecar：stdout 輸出 JSON 狀態、stdin 指令可以暫停領取，stdin 關閉時以 0 結束。
#[tokio::test]
async fn sidecar_reports_status_and_follows_commands() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let base = server.base_url();
    let mut opts = RunnerOptions::new(&base, home.path());
    // 和 Desktop 一樣：Server 網址與 Pairing token 以環境變數傳入，不放在命令列。
    opts.server = None;
    opts.pairing_token = None;
    opts.env = vec![
        (names::ENV_SERVER_URL.to_owned(), base.clone()),
        (names::ENV_PAIRING_TOKEN.to_owned(), "pt_sidecar".into()),
    ];
    opts.extra_args = vec![SIDECAR_FLAG.into()];
    opts.stdin_piped = true;
    opts.stdout_piped = true;
    let mut runner = spawn_runner(opts);
    let mut stdout = BufReader::new(runner.child.stdout.take().unwrap()).lines();
    let mut stdin = runner.child.stdin.take().unwrap();
    let mut next_status = async || -> serde_json::Value {
        let line = tokio::time::timeout(Duration::from_secs(30), stdout.next_line())
            .await
            .expect("等不到 sidecar 狀態")
            .unwrap()
            .expect("stdout 已關閉");
        serde_json::from_str(&line)
            .unwrap_or_else(|e| panic!("stdout 只能有 JSON 狀態：{e}：{line}"))
    };

    // 啟動後立刻送出一行 status，不等連線狀態改變。
    let first = next_status().await;
    assert_eq!(first["type"], "status", "{first}");
    assert_eq!(first["state"], "connecting", "{first}");
    assert_eq!(first["claiming_paused"], false, "{first}");

    // 一啟動就接受指令：Desktop 在 spawn 後馬上送 pause_claiming（恢復上次的暫停狀態），
    // 連上 Server 之前收到的指令也要生效。
    stdin
        .write_all(b"{\"type\":\"pause_claiming\"}\n")
        .await
        .unwrap();
    let paused = loop {
        let s = next_status().await;
        if s["claiming_paused"] == true {
            break s;
        }
    };
    assert_eq!(paused["state"], "connecting", "還沒連上 Server：{paused}");
    assert_eq!(paused["active_runs"], 0);

    let mut conn = server.accept().await;
    let hello = conn.handshake(Vec::new(), Some("rt_1")).await;
    assert_eq!(hello["pairing"]["token"], "pt_sidecar", "{hello}");
    let connected = loop {
        let s = next_status().await;
        if s["state"] == "connected" {
            break s;
        }
    };
    assert_eq!(
        connected["runner_id"],
        "0192f3a0-0000-7000-8000-000000000001"
    );
    assert_eq!(connected["claiming_paused"], true);
    let hb = conn
        .wait_for("heartbeat", |v| v["type"] == "heartbeat")
        .await;
    assert_eq!(
        hb["accepting_dispatches"], false,
        "連線前的暫停要生效：{hb}"
    );
    // 暫停時收到的 Dispatch 一律拒絕。
    let remote = Remote::new(&[("README.md", "a\n")]);
    conn.send(&send_offer(offer(
        "r1",
        "d1",
        remote.dispatch_repo("web"),
        "claude-code",
        "x",
    )))
    .await;
    let reply = conn
        .wait_for("reject", |v| v["type"] == "dispatch_reject")
        .await;
    assert_eq!(reply["reason"], "agent_unavailable");

    // 恢復領取。
    stdin
        .write_all(b"{\"type\":\"resume_claiming\"}\n")
        .await
        .unwrap();
    loop {
        let s = next_status().await;
        if s["claiming_paused"] == false {
            break;
        }
    }
    conn.wait_for("恢復後的 heartbeat", |v| {
        v["type"] == "heartbeat" && v["accepting_dispatches"] == true
    })
    .await;

    // stdin 關閉（Electron 當掉）：Runner 自己結束。
    drop(stdin);
    let status = runner.wait_exit().await;
    assert_eq!(status.code(), Some(0), "stderr：{}", runner.stderr());
}

/// sidecar：保存的 Runner token 被撤銷（invalid_runner_token）時不改用 Pairing token，
/// 直接以「需要重新 Pairing」的結束碼結束，由 Desktop 重新取得 Pairing token。
#[tokio::test]
async fn sidecar_exits_for_re_pairing_when_runner_token_is_revoked() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let mut runner = spawn_runner(RunnerOptions::new(&server.base_url(), home.path()));
    let mut conn = server.accept().await;
    conn.handshake(Vec::new(), Some("rt_old")).await;
    conn.recv().await;
    runner.child.kill().await.unwrap();
    drop(conn);

    let base = server.base_url();
    let mut opts = RunnerOptions::new(&base, home.path());
    opts.extra_args = vec![SIDECAR_FLAG.into()];
    opts.stdin_piped = true;
    let mut runner = spawn_runner(opts);
    let _stdin = runner.child.stdin.take();
    let mut conn = server.accept().await;
    let hello = conn.recv().await;
    assert_eq!(hello["pairing"]["kind"], "runner_token");
    conn.send(&reject(HelloRejectReason::InvalidRunnerToken))
        .await;
    conn.ws.close(None).await.ok();
    let status = runner.wait_exit().await;
    assert_eq!(
        status.code(),
        Some(SIDECAR_EXIT_NEEDS_PAIRING),
        "stderr：{}",
        runner.stderr()
    );
}

/// `<前綴>RUNNER_STATE_DIR` 只覆寫狀態目錄：Runner token 存到那裡，設定檔仍從本機目錄讀取。
#[tokio::test]
async fn state_dir_variable_moves_only_the_state() {
    let mut server = FakeServer::start().await;
    let home = temp_dir("orbis home");
    let state = temp_dir("desktop state");
    // 名稱只寫在本機目錄的設定檔中。
    write_runner_toml(home.path(), "name = \"從設定檔來的名稱\"\n");
    let base = server.base_url();
    let mut opts = RunnerOptions::new(&base, home.path());
    opts.env = vec![(
        names::ENV_RUNNER_STATE_DIR.to_owned(),
        state.path().to_string_lossy().into_owned(),
    )];
    let _runner = spawn_runner(opts);
    let mut conn = server.accept().await;
    let hello = conn.handshake(Vec::new(), Some("rt_1")).await;
    assert_eq!(hello["runner"]["name"], "從設定檔來的名稱", "{hello}");
    conn.recv().await;
    let saved = std::fs::read_to_string(state.path().join("credentials.json")).unwrap();
    assert!(saved.contains("rt_1"), "{saved}");
    assert!(
        !home
            .path()
            .join(names::RUNNER_STATE_DIR)
            .join("credentials.json")
            .exists(),
        "狀態不應寫到本機目錄"
    );
}
