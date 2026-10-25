//! Planning 與 Plan Gate（ARCHITECTURE §5、issue #30）：`plan_gate` 的 Run 先產出 plan，
//! 送出 `plan_proposed` 後等 Plan Gate；核准後才修改 Worktree，退回時在同一個 session 重新產出。

mod support;

use orbis_fake_agent::agent::SESSION_MODE_PREFIX;
use orbis_protocol::control::RunControlAction;
use orbis_protocol::enums::{GateDecision, GateKind, PromptSource};
use orbis_protocol::event::ContentBlock;
use orbis_runner::run::{PLAN_APPROVED_PROMPT, PLAN_ONLY_PROMPT};
use serde_json::Value;
use support::flow::{Env, control_r1};
use support::server::{RunnerSide, fake_agent_toml};
use support::{runner_script, toml_string};

fn prompt_text(event: &Value) -> String {
    event["prompt"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

async fn approve_plan(conn: &mut RunnerSide, control_id: &str) {
    control_r1(
        conn,
        control_id,
        RunControlAction::GateResult {
            gate: GateKind::Plan,
            decision: GateDecision::Approved,
        },
    )
    .await;
}

/// Agent 沒有可靠的 plan 模式：第一個 prompt 接上只產出 plan 的指示；Planning 中寫檔一律拒絕；
/// 回合結束送 `plan_proposed`（prompt_fallback）並等 Plan Gate，核准後才實作。
#[tokio::test(flavor = "multi_thread")]
async fn 沒有_plan_模式時以_prompt_產出_plan_核准後才實作() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("planning.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env
        .dispatch_with("r1", "fake", "請新增 impl.txt", |o| o.plan_gate = true)
        .await;
    let worktree = std::path::PathBuf::from(
        conn.wait_event("worktree_ready").await["worktree_path"]
            .as_str()
            .unwrap(),
    );
    let first = conn.wait_event("prompt_submitted").await;
    assert_eq!(first["source"], "user");
    let text = prompt_text(&first);
    assert!(
        text.contains("請新增 impl.txt") && text.contains(PLAN_ONLY_PROMPT),
        "{text}"
    );

    let plan = conn.wait_event("plan_proposed").await;
    assert_eq!(plan["source"], "prompt_fallback");
    assert!(
        plan["body"]["text"].as_str().unwrap().contains("# 計畫"),
        "{plan}"
    );
    let gate = conn.wait_status("awaiting_gate").await;
    assert_eq!(gate["gate"], "plan");
    assert!(
        !worktree.join("plan.txt").exists(),
        "Planning 中寫檔要被拒絕"
    );
    assert!(
        !conn
            .events
            .iter()
            .any(|e| e["kind"] == "permission_request"),
        "Planning 中的寫入直接拒絕，不問人"
    );
    assert!(
        !conn.events.iter().any(|e| e["kind"] == "run_diff"),
        "Plan Gate 之前不送 review diff"
    );

    approve_plan(&mut conn, "c1").await;
    let next = conn
        .wait_for("核准後的 prompt", |v| {
            v["kind"] == "prompt_submitted" && v["source"] == "plan_gate"
        })
        .await;
    assert!(prompt_text(&next).contains(PLAN_APPROVED_PROMPT));
    let diff = conn.wait_event("run_diff").await;
    let review = conn.wait_status("awaiting_gate").await;
    assert_eq!(review["gate"], "review");
    assert!(
        diff["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["path"] == "impl.txt"),
        "{diff}"
    );
    assert!(worktree.join("impl.txt").is_file());
}

/// Plan Gate 退回：意見以 prompt（plan_gate）送回同一個 session，重新產出 plan 再等 Plan Gate。
#[tokio::test(flavor = "multi_thread")]
async fn plan_gate_退回後在同一個_session_重新產出_plan() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("planning-revise.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env
        .dispatch_with("r1", "fake", "做事", |o| o.plan_gate = true)
        .await;
    let v1 = conn.wait_event("plan_proposed").await;
    assert!(v1["body"]["text"].as_str().unwrap().contains("v1"));
    conn.wait_status("awaiting_gate").await;
    control_r1(
        &mut conn,
        "c1",
        RunControlAction::GateResult {
            gate: GateKind::Plan,
            decision: GateDecision::Rejected,
        },
    )
    .await;
    control_r1(
        &mut conn,
        "c2",
        RunControlAction::Prompt {
            prompt: vec![ContentBlock::Text {
                text: "請補上測試".into(),
            }],
            source: Some(PromptSource::PlanGate),
            delivery: None,
        },
    )
    .await;
    let v2 = conn.wait_event("plan_proposed").await;
    assert!(v2["body"]["text"].as_str().unwrap().contains("v2"), "{v2}");
    let gate = conn.wait_status("awaiting_gate").await;
    assert_eq!(gate["gate"], "plan");
    approve_plan(&mut conn, "c3").await;
    let review = conn.wait_status("awaiting_gate").await;
    assert_eq!(review["gate"], "review");
}

/// Agent 有可靠的 plan 模式：Planning 時切到 plan 模式；Agent 以切換模式的權限請求交出 plan，
/// Runner 記下 plan（plan_mode）並拒絕切換、不轉給人；核准後切回原本的模式。
#[tokio::test(flavor = "multi_thread")]
async fn 有_plan_模式時切換模式並記下交出的_plan() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("planning-mode.yaml")).replace(
            "args = [\"--script\", ",
            &format!(
                "args = [{}, {}, \"--script\", ",
                toml_string("--modes"),
                toml_string("default,plan")
            ),
        ) + "plan_mode = \"plan\"\n"
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env
        .dispatch_with("r1", "fake", "做事", |o| o.plan_gate = true)
        .await;
    let first = conn.wait_event("prompt_submitted").await;
    assert!(
        !prompt_text(&first).contains(PLAN_ONLY_PROMPT),
        "有 plan 模式時不加 prompt 後備"
    );
    let mode = conn.wait_event("message_chunk").await;
    assert_eq!(
        mode["content"]["text"],
        format!("{SESSION_MODE_PREFIX}plan")
    );
    let plan = conn.wait_event("plan_proposed").await;
    assert_eq!(plan["source"], "plan_mode");
    assert_eq!(
        plan["body"]["text"],
        "# 計畫（plan 模式）\n\n1. 新增 impl.txt。"
    );
    assert!(
        !conn
            .events
            .iter()
            .any(|e| e["kind"] == "permission_request"),
        "交出 plan 的請求由 Runner 處理，不轉給人"
    );
    conn.wait_status("awaiting_gate").await;
    approve_plan(&mut conn, "c1").await;
    conn.wait_for("核准後的模式", |v| {
        v["kind"] == "message_chunk"
            && v["content"]["text"] == format!("{SESSION_MODE_PREFIX}default")
    })
    .await;
    let review = conn.wait_status("awaiting_gate").await;
    assert_eq!(review["gate"], "review");
}
