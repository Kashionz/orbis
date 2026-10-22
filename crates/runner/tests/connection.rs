//! 用 in-process 的 WebSocket server 扮演 Server，啟動真正的 `orbis-runner` 執行檔，
//! 驗證連線流程：Hello → HelloAck → AgentAvailability 與 Heartbeat；HelloRejected 時以非 0 結束。

use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use orbis_protocol::connection::{HelloAck, HelloRejectReason, HelloRejected, Pairing};
use orbis_protocol::control::{
    RunControl, RunControlAction, RunControlOutcome, RunControlRejectReason,
};
use orbis_protocol::dispatch::{DispatchOffer, DispatchRejectReason, DispatchRepo, DispatchTask};
use orbis_protocol::enums::PermissionPolicy;
use orbis_protocol::frame::{RunnerToServer, ServerToRunner};
use orbis_protocol::{PROTOCOL_VERSION, RUNNER_WS_PATH, names};
use orbis_runner::config::{ENV_PAIRING_TOKEN, ENV_SERVER_URL};
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

const WAIT: Duration = Duration::from_secs(30);

/// 扮演 Server 的 WebSocket 端點。
struct FakeServer {
    listener: TcpListener,
}

impl FakeServer {
    async fn start() -> Self {
        Self {
            listener: TcpListener::bind("127.0.0.1:0").await.unwrap(),
        }
    }

    fn base_url(&self) -> String {
        format!("http://{}", self.listener.local_addr().unwrap())
    }

    /// 接受 Runner 的連線，並確認它連的是 Runner 的 WebSocket 路徑。
    // callback 的回傳型別由 tungstenite 決定，無法縮小 Err 的大小。
    #[allow(clippy::result_large_err)]
    async fn accept(&self) -> RunnerSide {
        let (stream, _) = timeout(WAIT, self.listener.accept())
            .await
            .expect("Runner 沒有連上來")
            .unwrap();
        let ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, resp: Response| {
            assert_eq!(req.uri().path(), RUNNER_WS_PATH, "Runner 連到錯誤的路徑");
            Ok(resp)
        })
        .await
        .unwrap();
        RunnerSide { ws }
    }
}

/// Server 端看到的 Runner 連線。
struct RunnerSide {
    ws: WebSocketStream<TcpStream>,
}

impl RunnerSide {
    async fn recv(&mut self) -> RunnerToServer {
        loop {
            let message = timeout(WAIT, self.ws.next())
                .await
                .expect("等不到 Runner 的 frame")
                .expect("Runner 關閉了連線")
                .unwrap();
            if let Message::Text(text) = message {
                return serde_json::from_str(&text)
                    .unwrap_or_else(|e| panic!("Runner 送出不合法的 frame：{e}\n{text}"));
            }
        }
    }

    /// 略過 Heartbeat，取得下一個其他種類的 frame。
    async fn recv_non_heartbeat(&mut self) -> RunnerToServer {
        loop {
            match self.recv().await {
                RunnerToServer::Heartbeat(_) => continue,
                frame => return frame,
            }
        }
    }

    async fn send(&mut self, frame: &ServerToRunner) {
        let text = serde_json::to_string(frame).unwrap();
        self.ws.send(Message::text(text)).await.unwrap();
    }
}

/// 啟動 Runner 執行檔。不繼承測試環境中的連線設定，避免影響結果。
fn runner(args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_orbis-runner"));
    cmd.args(args)
        .env_remove(names::env_var(ENV_SERVER_URL))
        .env_remove(names::env_var(ENV_PAIRING_TOKEN))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

async fn wait_exit(child: &mut Child) -> (ExitStatus, String) {
    let status = timeout(WAIT, child.wait())
        .await
        .expect("Runner 沒有結束")
        .unwrap();
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .await
        .unwrap();
    (status, stderr)
}

fn hello_ack(heartbeat_interval_ms: u32) -> ServerToRunner {
    ServerToRunner::HelloAck(HelloAck {
        protocol_version: PROTOCOL_VERSION,
        runner_id: "0192f3a0-0000-7000-8000-000000000001".into(),
        runner_token: Some("rt_test".into()),
        heartbeat_interval_ms,
        resume: Vec::new(),
    })
}

/// 第一個 frame 是合法的 Hello。
#[tokio::test]
async fn first_frame_is_a_valid_hello() {
    let server = FakeServer::start().await;
    let _child = runner(&[
        "--server",
        &server.base_url(),
        "--pairing-token",
        "pt_test",
        "--name",
        "測試 Runner",
    ])
    .spawn()
    .unwrap();

    let mut conn = server.accept().await;
    let RunnerToServer::Hello(hello) = conn.recv().await else {
        panic!("第一個 frame 不是 hello");
    };
    assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
    assert_eq!(
        hello.pairing,
        Pairing::PairingToken {
            token: "pt_test".into()
        }
    );
    assert_eq!(hello.runner.name, "測試 Runner");
    assert_eq!(hello.runner.os, std::env::consts::OS);
    assert_eq!(hello.runner.arch, std::env::consts::ARCH);
    assert_eq!(hello.runner.runner_version, env!("CARGO_PKG_VERSION"));
}

/// HelloAck 之後回報 AgentAvailability，並持續送 Heartbeat。
#[tokio::test]
async fn reports_availability_and_heartbeats_after_hello_ack() {
    let server = FakeServer::start().await;
    let _child = runner(&["--server", &server.base_url(), "--pairing-token", "pt_test"])
        .spawn()
        .unwrap();

    let mut conn = server.accept().await;
    assert!(matches!(conn.recv().await, RunnerToServer::Hello(_)));
    conn.send(&hello_ack(20)).await;

    let mut availability = None;
    let mut heartbeats = 0;
    while availability.is_none() || heartbeats < 2 {
        match conn.recv().await {
            RunnerToServer::AgentAvailability(a) => {
                assert!(availability.is_none(), "AgentAvailability 只應送一次");
                availability = Some(a);
            }
            RunnerToServer::Heartbeat(h) => {
                assert!(h.ts.0.ends_with('Z'), "ts 必須是 UTC：{}", h.ts.0);
                assert!(h.active_run_ids.is_empty());
                heartbeats += 1;
            }
            other => panic!(
                "預期 agent_availability 或 heartbeat，收到 {}",
                other.type_name()
            ),
        }
    }
    let availability = availability.unwrap();
    assert!(availability.agents.is_empty(), "骨架階段還沒有 Agent");
    assert!(availability.credentials.is_empty());
}

/// 沒有 Agent 時拒絕 Dispatch 與 RunControl，讓 Server 不必等到逾時。
#[tokio::test]
async fn rejects_dispatch_and_run_control_without_agents() {
    let server = FakeServer::start().await;
    let _child = runner(&["--server", &server.base_url(), "--pairing-token", "pt_test"])
        .spawn()
        .unwrap();

    let mut conn = server.accept().await;
    assert!(matches!(conn.recv().await, RunnerToServer::Hello(_)));
    conn.send(&hello_ack(60_000)).await;
    assert!(matches!(
        conn.recv_non_heartbeat().await,
        RunnerToServer::AgentAvailability(_)
    ));

    conn.send(&ServerToRunner::DispatchOffer(Box::new(DispatchOffer {
        dispatch_id: "d1".into(),
        run_id: "r1".into(),
        expires_at: "2999-01-01T00:00:00.000Z".into(),
        task: DispatchTask {
            task_id: "t1".into(),
            task_key: "ORB-1".into(),
            title: "測試".into(),
        },
        run_seq: 1,
        repo: DispatchRepo {
            name: "web".into(),
            clone_url: "https://github.com/acme/web.git".into(),
            default_branch: "main".into(),
            base_ref: "origin/main".into(),
        },
        branch: None,
        agent: "claude-code".into(),
        model: None,
        permission_policy: PermissionPolicy::Auto,
        prompt: Vec::new(),
        plan_gate: false,
        delegation: None,
        last_event_seq: 0,
    })))
    .await;
    let RunnerToServer::DispatchReject(reject) = conn.recv_non_heartbeat().await else {
        panic!("預期 dispatch_reject");
    };
    assert_eq!(reject.dispatch_id.as_str(), "d1");
    assert_eq!(reject.reason, DispatchRejectReason::AgentUnavailable);

    conn.send(&ServerToRunner::RunControl(RunControl {
        control_id: "c1".into(),
        run_id: "r1".into(),
        dispatch_id: "d1".into(),
        action: RunControlAction::Cancel,
    }))
    .await;
    let RunnerToServer::RunControlResult(result) = conn.recv_non_heartbeat().await else {
        panic!("預期 run_control_result");
    };
    assert_eq!(result.control_id.as_str(), "c1");
    assert!(matches!(
        result.outcome,
        RunControlOutcome::Rejected {
            reason: RunControlRejectReason::UnknownRun,
            ..
        }
    ));
}

/// HelloRejected 時印出原因並以非 0 結束。
#[tokio::test]
async fn exits_non_zero_with_reason_when_rejected() {
    let server = FakeServer::start().await;
    let mut child = runner(&["--server", &server.base_url(), "--pairing-token", "pt_bad"])
        .spawn()
        .unwrap();

    let mut conn = server.accept().await;
    assert!(matches!(conn.recv().await, RunnerToServer::Hello(_)));
    conn.send(&ServerToRunner::HelloRejected(HelloRejected {
        reason: HelloRejectReason::InvalidPairingToken,
        server_protocol_version: PROTOCOL_VERSION,
        message: "Pairing token 無效或已過期".into(),
    }))
    .await;
    conn.ws.close(None).await.ok();

    let (status, stderr) = wait_exit(&mut child).await;
    assert!(!status.success(), "被拒絕時必須以非 0 結束");
    assert!(stderr.contains("invalid_pairing_token"), "stderr：{stderr}");
    assert!(
        stderr.contains("Pairing token 無效或已過期"),
        "stderr：{stderr}"
    );
}

/// 沒有參數時從環境變數讀取連線設定。
#[tokio::test]
async fn reads_connection_settings_from_environment() {
    let server = FakeServer::start().await;
    let _child = runner(&[])
        .env(names::env_var(ENV_SERVER_URL), server.base_url())
        .env(names::env_var(ENV_PAIRING_TOKEN), "pt_env")
        .spawn()
        .unwrap();

    let mut conn = server.accept().await;
    let RunnerToServer::Hello(hello) = conn.recv().await else {
        panic!("第一個 frame 不是 hello");
    };
    assert_eq!(
        hello.pairing,
        Pairing::PairingToken {
            token: "pt_env".into()
        }
    );
}

/// 缺少連線設定時，錯誤訊息說明要設定的環境變數。
#[tokio::test]
async fn missing_settings_name_the_environment_variable() {
    let mut child = runner(&[]).spawn().unwrap();
    let (status, stderr) = wait_exit(&mut child).await;
    assert!(!status.success());
    assert!(
        stderr.contains(&names::env_var(ENV_SERVER_URL)),
        "stderr：{stderr}"
    );
}
