//! Run 流程測試共用的環境：bare remote、Runner 本機目錄、扮演 Server 的端點，以及常用的操作。
#![allow(dead_code)]

use std::path::Path;

use orbis_protocol::control::RunControlAction;
use serde_json::Value;

use super::server::{
    FakeServer, RunnerOptions, RunnerProcess, RunnerSide, offer, result_outcome, send_offer,
    spawn_runner, write_runner_toml,
};
use super::{Remote, temp_dir, toml_string};

/// 一次測試的環境：remote、Runner 本機目錄、Server。
pub struct Env {
    pub dir: tempfile::TempDir,
    pub remote: Remote,
    pub server: FakeServer,
}

impl Env {
    pub async fn new(files: &[(&str, &str)], runner_toml: impl Fn(&Path) -> String) -> Self {
        let dir = temp_dir("orbis run");
        let remote = Remote::new(files);
        write_runner_toml(
            &dir.path().join("home"),
            &runner_toml(&dir.path().join("wt")),
        );
        Self {
            dir,
            remote,
            server: FakeServer::start().await,
        }
    }

    pub fn home(&self) -> std::path::PathBuf {
        self.dir.path().join("home")
    }

    pub fn spawn(&self) -> RunnerProcess {
        spawn_runner(RunnerOptions::new(&self.server.base_url(), &self.home()))
    }

    /// 連上、完成交握並送出 Dispatch，等到 Runner 接受。
    pub async fn dispatch(&mut self, run_id: &str, agent: &str, prompt: &str) -> RunnerSide {
        let mut conn = self.server.accept().await;
        conn.handshake(Vec::new(), Some("rt_test")).await;
        self.offer(&mut conn, run_id, agent, prompt, 1).await;
        conn
    }

    pub async fn offer(
        &self,
        conn: &mut RunnerSide,
        run_id: &str,
        agent: &str,
        prompt: &str,
        run_seq: u32,
    ) {
        let mut o = offer(
            run_id,
            &format!("d-{run_id}"),
            self.remote.dispatch_repo("web"),
            agent,
            prompt,
        );
        o.run_seq = run_seq;
        conn.send(&send_offer(o)).await;
        let reply = conn
            .wait_for("dispatch 回覆", |v| {
                v["type"] == "dispatch_accept" || v["type"] == "dispatch_reject"
            })
            .await;
        assert_eq!(reply["type"], "dispatch_accept", "{reply}");
    }

    /// 連上、完成交握並送出調整過的 Dispatch（例如打開 Plan Gate），等到 Runner 接受。
    pub async fn dispatch_with(
        &mut self,
        run_id: &str,
        agent: &str,
        prompt: &str,
        adjust: impl FnOnce(&mut orbis_protocol::dispatch::DispatchOffer),
    ) -> RunnerSide {
        let mut conn = self.server.accept().await;
        conn.handshake(Vec::new(), Some("rt_test")).await;
        let mut o = offer(
            run_id,
            &format!("d-{run_id}"),
            self.remote.dispatch_repo("web"),
            agent,
            prompt,
        );
        adjust(&mut o);
        conn.send(&send_offer(o)).await;
        let reply = conn
            .wait_for("dispatch 回覆", |v| {
                v["type"] == "dispatch_accept" || v["type"] == "dispatch_reject"
            })
            .await;
        assert_eq!(reply["type"], "dispatch_accept", "{reply}");
        conn
    }
}

/// 送一個 RunControl 給 `r1`（Dispatch `d-r1`），確認被接受。
pub async fn control_r1(conn: &mut RunnerSide, control_id: &str, action: RunControlAction) {
    let result = conn.control("r1", "d-r1", control_id, action).await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
}

/// 回覆設定檔的信任核准（allow_once）。
pub async fn approve_config(conn: &mut RunnerSide, run_id: &str) {
    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "config_trust", "{request}");
    let result = conn
        .control(
            run_id,
            &format!("d-{run_id}"),
            "trust",
            RunControlAction::PermissionResponse {
                request_id: request["request_id"].as_str().unwrap().into(),
                option_id: "allow_once".into(),
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied");
}

/// runner.toml：用內建 claude-code profile 的修補與受保護路徑，但啟動指令換成 Fake Agent。
pub fn claude_code_as_fake(wt: &Path, script: &Path) -> String {
    claude_code_as_fake_with(wt, script, &[])
}

/// 同 [`claude_code_as_fake`]，另外加上 Fake Agent 的參數。
pub fn claude_code_as_fake_with(wt: &Path, script: &Path, extra: &[String]) -> String {
    let mut args = vec![
        toml_string("--script"),
        toml_string(&script.to_string_lossy()),
    ];
    args.extend(extra.iter().map(|a| toml_string(a)));
    format!(
        "worktree_root = {}\n[agents.claude-code]\ncommand = {}\nargs = [{}]\n",
        toml_string(&wt.to_string_lossy()),
        toml_string(&super::fake_agent_bin().to_string_lossy()),
        args.join(", "),
    )
}

/// Fake Agent 的 session 保存目錄參數（讓重新啟動的 Agent 能接續 session）。
pub fn agent_state_args(wt: &Path, load_only: bool) -> Vec<String> {
    let dir = wt.parent().unwrap().join("agent-state");
    let mut args = vec!["--state-dir".to_owned(), dir.to_string_lossy().into_owned()];
    if load_only {
        args.push("--no-resume".to_owned());
    }
    args
}

/// 回覆權限請求，確認被接受。
pub async fn answer(conn: &mut RunnerSide, control_id: &str, request: &Value, option_id: &str) {
    let result = conn
        .control(
            "r1",
            "d-r1",
            control_id,
            RunControlAction::PermissionResponse {
                request_id: request["request_id"].as_str().unwrap().into(),
                option_id: option_id.into(),
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
}
