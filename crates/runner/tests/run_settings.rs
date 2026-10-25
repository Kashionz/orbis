//! 執行中切換模型、推理強度與 Permission Policy（run-settings）、派工時的推理強度（dispatch-effort），
//! ARCHITECTURE §7、§8。

mod support;

use orbis_protocol::control::RunControlAction;
use orbis_protocol::enums::{Effort, PermissionPolicy};
use orbis_protocol::event::ContentBlock;
use serde_json::{Value, json};
use support::flow::Env;
use support::server::{RunnerSide, fake_agent_toml, result_outcome};
use support::{fake_agent_bin, runner_script, toml_string};

async fn control(conn: &mut RunnerSide, id: &str, action: RunControlAction) -> Value {
    let result = conn.control("r1", "d-r1", id, action).await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
    result
}

fn config(model: Option<&str>, effort: Option<Effort>) -> RunControlAction {
    RunControlAction::SetSessionConfig {
        model: model.map(str::to_owned),
        effort,
    }
}

fn prompt(text: &str) -> RunControlAction {
    RunControlAction::Prompt {
        prompt: vec![ContentBlock::Text { text: text.into() }],
        source: None,
        delivery: None,
    }
}

/// 下一個 `echo_config` 的回報（`config: model=…, thought=…`）。
async fn echoed_config(conn: &mut RunnerSide) -> String {
    conn.wait_for("echo_config", |v| {
        v["kind"] == "message_chunk"
            && v["content"]["text"]
                .as_str()
                .is_some_and(|t| t.starts_with("config: "))
    })
    .await["content"]["text"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn worktree(conn: &mut RunnerSide) -> std::path::PathBuf {
    let ready = conn.wait_event("worktree_ready").await;
    std::path::PathBuf::from(ready["worktree_path"].as_str().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn 回合中切換模型與推理強度_下一個回合生效() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("settings.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "開始").await;
    let wt = worktree(&mut conn).await;
    assert_eq!(
        echoed_config(&mut conn).await,
        "config: model=sonnet, thought=medium"
    );

    control(&mut conn, "s1", config(Some("opus"), Some(Effort::Deep))).await;
    control(&mut conn, "q1", prompt("繼續")).await;
    std::fs::write(wt.join("turn1.done"), "").unwrap();
    let changed = conn.wait_event("run_settings_changed").await;
    assert_eq!(changed["control_id"], "s1");
    assert_eq!(changed["model"], "opus");
    assert_eq!(changed["effort"], "deep");
    assert_eq!(changed["permission_policy"], Value::Null);
    assert_eq!(changed["not_applied"], json!([]));
    // 回合開始前套用：run_settings_changed 在下一個 prompt_submitted 之前。
    let submitted = conn.wait_event("prompt_submitted").await;
    assert_eq!(submitted["control_id"], "q1");
    assert!(changed["seq"].as_u64() < submitted["seq"].as_u64());
    assert_eq!(
        echoed_config(&mut conn).await,
        "config: model=opus, thought=high"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn gate_等待中立即生效_不支援的項目列在_not_applied() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("settings.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "開始").await;
    let wt = worktree(&mut conn).await;
    std::fs::write(wt.join("turn1.done"), "").unwrap();
    conn.wait_status("awaiting_gate").await;

    control(&mut conn, "s1", config(Some("haiku"), Some(Effort::Fast))).await;
    let changed = conn.wait_event("run_settings_changed").await;
    assert_eq!(changed["control_id"], "s1");
    assert_eq!(changed["model"], Value::Null, "沒有這個模型");
    assert_eq!(changed["effort"], "fast", "推理強度照常套用");
    assert_eq!(changed["not_applied"], json!(["model"]));
    assert!(
        changed["message"].as_str().unwrap().contains("haiku"),
        "{changed}"
    );

    // Review Gate 退回後的回合用新的推理強度。
    control(
        &mut conn,
        "back",
        RunControlAction::GateResult {
            gate: orbis_protocol::enums::GateKind::Review,
            decision: orbis_protocol::enums::GateDecision::Rejected,
        },
    )
    .await;
    control(&mut conn, "q1", prompt("再看一次")).await;
    assert_eq!(
        echoed_config(&mut conn).await,
        "config: model=sonnet, thought=low"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_沒有_config_option_時全部未套用() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("simple.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "開始").await;
    conn.wait_status("awaiting_gate").await;
    control(&mut conn, "s1", config(Some("opus"), Some(Effort::Std))).await;
    let changed = conn.wait_event("run_settings_changed").await;
    assert_eq!(changed["not_applied"], json!(["model", "effort"]));
    assert_eq!(changed["model"], Value::Null);
    assert_eq!(changed["effort"], Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn 切換_permission_policy_後下一個權限請求依新的策略() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("policy-switch.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env
        .dispatch_with("r1", "fake", "開始", |o| {
            o.permission_policy = PermissionPolicy::Manual;
        })
        .await;
    let wt = worktree(&mut conn).await;
    conn.wait_for("第一個回合開始", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "第一個回合開始"
    })
    .await;
    control(
        &mut conn,
        "p1",
        RunControlAction::SetPermissionPolicy {
            policy: PermissionPolicy::Yolo,
        },
    )
    .await;
    let changed = conn.wait_event("run_settings_changed").await;
    assert_eq!(changed["permission_policy"], "yolo");
    assert_eq!(changed["control_id"], "p1");
    control(&mut conn, "q1", prompt("寫入 note.txt")).await;
    std::fs::write(wt.join("turn1.done"), "").unwrap();
    conn.wait_for("第二個回合寫入完成", |v| {
        v["kind"] == "final_message"
            && v["text"]["text"]
                .as_str()
                .is_some_and(|t| t.contains("已寫入"))
    })
    .await;
    assert!(
        !conn
            .frames()
            .iter()
            .any(|v| v["kind"] == "permission_request"),
        "換成 yolo 之後的權限請求不問人：{:#?}",
        conn.event_summary()
    );
    assert!(wt.join("note.txt").is_file());
}

#[tokio::test(flavor = "multi_thread")]
async fn 派工時的模型與推理強度在_session_建立後套用() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("settings.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env
        .dispatch_with("r1", "fake", "開始", |o| {
            o.model = Some("opus".into());
            o.effort = Some(Effort::Fast);
        })
        .await;
    let changed = conn.wait_event("run_settings_changed").await;
    assert_eq!(
        changed["control_id"],
        Value::Null,
        "派工時的設定沒有 control id"
    );
    assert_eq!(changed["model"], "opus");
    assert_eq!(changed["effort"], "fast");
    let submitted = conn.wait_event("prompt_submitted").await;
    assert!(changed["seq"].as_u64() < submitted["seq"].as_u64());
    assert_eq!(
        echoed_config(&mut conn).await,
        "config: model=opus, thought=low"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn 推理強度以_effort_args_在啟動時套用() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        let args = |mode: &str| {
            format!(
                "[{}, {}, {}, {}]",
                toml_string("--modes"),
                toml_string(mode),
                toml_string("--initial-mode"),
                toml_string(mode)
            )
        };
        format!(
            "worktree_root = {}\n[agents.fake]\ncommand = {}\nargs = [{}, {}]\neffort_args = {{ fast = {}, std = {}, deep = {} }}\n",
            toml_string(&wt.to_string_lossy()),
            toml_string(&fake_agent_bin().to_string_lossy()),
            toml_string("--script"),
            toml_string(&runner_script("effort-args.yaml").to_string_lossy()),
            args("fast-mode"),
            args("std-mode"),
            args("deep-mode"),
        )
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env
        .dispatch_with("r1", "fake", "開始", |o| o.effort = Some(Effort::Deep))
        .await;
    let changed = conn.wait_event("run_settings_changed").await;
    assert_eq!(changed["effort"], "deep", "啟動參數已套用：{changed}");
    assert_eq!(changed["not_applied"], json!([]));
    let mode = conn
        .wait_for("echo_session_mode", |v| {
            v["kind"] == "message_chunk"
                && v["content"]["text"]
                    .as_str()
                    .is_some_and(|t| t.starts_with("mode: "))
        })
        .await;
    assert_eq!(mode["content"]["text"], "mode: deep-mode");
}
