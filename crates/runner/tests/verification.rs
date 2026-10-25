//! Verification 的 Runner 端（ARCHITECTURE §5.1、issue #32）：Server 送 `verify`，Runner 逐條判定，
//! 每條送 `verification_result`，最後送 `verification_completed` 並回到 Review Gate。
//! 失敗後 Server 以 `verification_retry` 的 prompt 送回同一個 session 重試。

mod support;

use orbis_protocol::control::RunControlAction;
use orbis_protocol::enums::{GateDecision, GateKind, PromptSource};
use orbis_protocol::event::ContentBlock;
use orbis_protocol::verification::{VerificationCriterion, VerificationKind, VerificationRequest};
use serde_json::Value;
use support::flow::{Env, answer, approve_config, control_r1};
use support::server::{RunnerSide, fake_agent_toml};
use support::{cfg, runner_script, script};

/// C2 的完成條件 e2e 也用這條指令（crates/fake-agent/scripts/plan-verify.yaml）。
const VERIFY_COMMAND: &str = "git grep --no-index -q pass verify.txt";

fn request(attempt: u32, command: Option<&str>) -> RunControlAction {
    RunControlAction::Verify(VerificationRequest {
        verification_id: format!("v{attempt}").into(),
        attempt,
        criteria: vec![VerificationCriterion {
            criterion_id: "ac-1".into(),
            kind: VerificationKind::Command,
            description: "verify.txt 的內容是 pass".into(),
            command: command.map(str::to_owned),
        }],
        judge: None,
        context: Vec::new(),
    })
}

/// 等一輪 Verification 結束，回傳（`verification_result`, `verification_completed`）。
async fn wait_verification(conn: &mut RunnerSide) -> (Value, Value) {
    conn.wait_status("verifying").await;
    let result = conn.wait_event("verification_result").await;
    let completed = conn.wait_event("verification_completed").await;
    let back = conn.wait_status("awaiting_gate").await;
    assert_eq!(back["gate"], "review");
    (result, completed)
}

/// Plan Gate → 第一次 Verification 失敗 → verification_retry 的 prompt → 第二次通過（C2 的劇本）。
/// Task 指定的指令不在 Repo 設定檔中，第一次執行前問人，同一個 Run 中不再重複問。
#[tokio::test(flavor = "multi_thread")]
async fn plan_gate_後_verification_失敗重試再通過() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &script("plan-verify.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env
        .dispatch_with("r1", "fake", "新增 verify.txt", |o| o.plan_gate = true)
        .await;
    conn.wait_event("plan_proposed").await;
    conn.wait_status("awaiting_gate").await;
    control_r1(
        &mut conn,
        "c1",
        RunControlAction::GateResult {
            gate: GateKind::Plan,
            decision: GateDecision::Approved,
        },
    )
    .await;
    conn.wait_event("run_diff").await;
    conn.wait_status("awaiting_gate").await;

    control_r1(&mut conn, "c2", request(1, Some(VERIFY_COMMAND))).await;
    let ask = conn.wait_event("permission_request").await;
    assert_eq!(ask["purpose"], "tool", "{ask}");
    assert!(
        ask["title"].as_str().unwrap().contains(VERIFY_COMMAND),
        "{ask}"
    );
    answer(&mut conn, "c3", &ask, "allow_once").await;
    let (result, completed) = wait_verification(&mut conn).await;
    assert_eq!(result["outcome"], "failed", "{result}");
    assert_eq!(result["criterion_id"], "ac-1");
    assert_eq!(result["evidence"][0]["type"], "command_output");
    assert_eq!(result["evidence"][0]["exit_code"], 1);
    assert_eq!(completed["outcome"], "failed");

    control_r1(
        &mut conn,
        "c4",
        RunControlAction::Prompt {
            prompt: vec![ContentBlock::Text {
                text: result["summary"].as_str().unwrap().to_owned(),
            }],
            source: Some(PromptSource::VerificationRetry),
            delivery: None,
        },
    )
    .await;
    let retry = conn
        .wait_for("重試的 prompt", |v| {
            v["kind"] == "prompt_submitted" && v["source"] == "verification_retry"
        })
        .await;
    assert!(retry["prompt"][0]["text"].is_string());
    conn.wait_event("run_diff").await;
    conn.wait_status("awaiting_gate").await;

    control_r1(&mut conn, "c5", request(2, Some(VERIFY_COMMAND))).await;
    let (result, completed) = wait_verification(&mut conn).await;
    assert_eq!(result["outcome"], "passed", "{result}");
    assert_eq!(result["attempt"], 2);
    assert_eq!(completed["outcome"], "passed");
    let asks = conn
        .events
        .iter()
        .filter(|e| e["kind"] == "permission_request")
        .count();
    assert_eq!(asks, 1, "同一個指令在同一個 Run 中只問一次");
    let finals = conn
        .events
        .iter()
        .filter(|e| e["kind"] == "final_message")
        .count();
    assert_eq!(finals, 3, "每個回合結束都送 final_message");
}

/// 條件沒有指定指令時用 Repo 設定檔的 `[verify].commands`（已經過信任核准，不再問人）。
#[tokio::test(flavor = "multi_thread")]
async fn 沒有指定指令時用_repo_設定檔的_verify_commands() {
    let config = format!("[verify]\ncommands = [\"{VERIFY_COMMAND}\"]\n");
    let mut env = Env::new(&[("README.md", "a\n"), (cfg().as_str(), &config)], |wt| {
        fake_agent_toml(wt, &runner_script("verify-pass.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    approve_config(&mut conn, "r1").await;
    conn.wait_status("awaiting_gate").await;
    control_r1(&mut conn, "c1", request(1, None)).await;
    let (result, completed) = wait_verification(&mut conn).await;
    assert_eq!(result["outcome"], "passed", "{result}");
    assert_eq!(result["evidence"][0]["command"], VERIFY_COMMAND);
    assert_eq!(completed["outcome"], "passed");
    let asks = conn
        .events
        .iter()
        .filter(|e| e["kind"] == "permission_request" && e["purpose"] == "tool")
        .count();
    assert_eq!(asks, 0, "設定檔中的指令已經過信任核准");
}

/// 拒絕執行 Task 指定的指令：這條條件無法判定（error），不執行。
#[tokio::test(flavor = "multi_thread")]
async fn 拒絕執行_task_指定的指令時判定為_error() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("verify-pass.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    conn.wait_status("awaiting_gate").await;
    control_r1(&mut conn, "c1", request(1, Some(VERIFY_COMMAND))).await;
    let ask = conn.wait_event("permission_request").await;
    answer(&mut conn, "c2", &ask, "reject_once").await;
    let (result, completed) = wait_verification(&mut conn).await;
    assert_eq!(result["outcome"], "error", "{result}");
    assert_eq!(completed["outcome"], "error");
}
