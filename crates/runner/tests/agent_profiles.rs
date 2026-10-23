//! 內建的 Agent Profile（ARCHITECTURE §7、issue #31、#18）：把每個內建 profile 的啟動指令換成
//! Fake Agent 跑一個 Task，確認 profile 的修補（session mode、session 的 `_meta`）仍會套用，
//! 以及 AgentAvailability 回報從 `initialize` 得到的能力旗標。真實 Agent 的確認在 Windows 實機上手動進行。

mod support;

use std::path::Path;

use orbis_fake_agent::agent::SESSION_MODE_PREFIX;
use orbis_runner::agent::{CLAUDE_CODE, CODEX, GEMINI, GROK};
use serde_json::Value;
use support::flow::Env;
use support::server::fake_agent_toml;
use support::{runner_script, toml_string};

/// runner.toml：內建 profile `id` 的啟動指令換成 Fake Agent（加上 `extra` 參數）。
fn builtin_as_fake(id: &str, wt: &Path, extra: &[&str]) -> String {
    let mut args = vec![
        toml_string("--script"),
        toml_string(&runner_script("profile-check.yaml").to_string_lossy()),
    ];
    args.extend(extra.iter().map(|a| toml_string(a)));
    format!(
        "worktree_root = {}\n[agents.{id}]\ncommand = {}\nargs = [{}]\n",
        toml_string(&wt.to_string_lossy()),
        toml_string(&support::fake_agent_bin().to_string_lossy()),
        args.join(", "),
    )
}

/// 跑一個 Task，回傳 Agent 回報的 session mode 與 `_meta`。
async fn run_profile(id: &str, extra: &[&str]) -> (String, Value) {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| builtin_as_fake(id, wt, extra)).await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", id, "做事").await;
    let mode = conn
        .wait_for("session mode", |v| {
            v["kind"] == "message_chunk"
                && v["content"]["text"]
                    .as_str()
                    .is_some_and(|t| t.starts_with(SESSION_MODE_PREFIX))
        })
        .await["content"]["text"]
        .as_str()
        .unwrap()
        .trim_start_matches(SESSION_MODE_PREFIX)
        .to_owned();
    let meta = conn
        .wait_for("session meta", |v| {
            v["kind"] == "message_chunk"
                && v["content"]["text"]
                    .as_str()
                    .is_some_and(|t| !t.starts_with(SESSION_MODE_PREFIX))
        })
        .await["content"]["text"]
        .as_str()
        .map(|t| serde_json::from_str(t).unwrap())
        .unwrap();
    conn.wait_status("awaiting_gate").await;
    (mode, meta)
}

/// Claude Code：使用者把預設模式設成 bypassPermissions 時切回 default；不載入使用者全域設定。
#[tokio::test(flavor = "multi_thread")]
async fn claude_code_切回會詢問的模式並隔離使用者設定() {
    let (mode, meta) = run_profile(
        CLAUDE_CODE,
        &[
            "--modes",
            "default,acceptEdits,plan,bypassPermissions",
            "--initial-mode",
            "bypassPermissions",
        ],
    )
    .await;
    assert_eq!(mode, "default");
    assert_eq!(
        meta["claudeCode"]["options"]["settingSources"],
        serde_json::json!(["project", "local"])
    );
}

/// Codex：預設的 agent 模式會自動核准，切到 read-only 讓修改都先問 Runner。
#[tokio::test(flavor = "multi_thread")]
async fn codex_切到_read_only_模式() {
    let (mode, meta) = run_profile(
        CODEX,
        &[
            "--modes",
            "read-only,workspace-write,agent,agent-full-access",
            "--initial-mode",
            "agent",
        ],
    )
    .await;
    assert_eq!(mode, "read-only");
    assert_eq!(meta, Value::Null);
}

/// Gemini CLI 與 Grok Build：沒有 session mode 的修補，照樣能完成一個 Task。
#[tokio::test(flavor = "multi_thread")]
async fn gemini_與_grok_可以完成一個_task() {
    for id in [GEMINI, GROK] {
        let (mode, meta) = run_profile(id, &[]).await;
        assert_eq!(mode, "none", "{id}");
        assert_eq!(meta, Value::Null, "{id}");
    }
}

/// issue #18：AgentAvailability 回報從 `initialize` 得到的實際能力旗標（啟動時在背景探測）。
#[tokio::test(flavor = "multi_thread")]
async fn agent_availability_回報_initialize_的能力旗標() {
    let state = support::temp_dir("agent state");
    let state_dir = state.path().to_string_lossy().into_owned();
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("simple.yaml")).replace(
            "args = [\"--script\", ",
            &format!(
                "args = [\"--state-dir\", {}, \"--script\", ",
                toml_string(&state_dir)
            ),
        )
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    let availability = conn
        .wait_for("含能力旗標的 agent_availability", |v| {
            v["type"] == "agent_availability"
                && v["agents"].as_array().is_some_and(|agents| {
                    agents.iter().any(|a| {
                        a["id"] == "fake"
                            && a["capabilities"]
                                .as_array()
                                .is_some_and(|c| c.iter().any(|c| c == "load_session"))
                    })
                })
        })
        .await;
    let fake = availability["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == "fake")
        .unwrap();
    assert_eq!(fake["available"], true, "{fake}");
    assert_eq!(
        fake["version"],
        env!("CARGO_PKG_VERSION"),
        "版本來自 initialize：{fake}"
    );
    for id in [CLAUDE_CODE, CODEX, GEMINI, GROK] {
        assert!(
            availability["agents"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["id"] == id),
            "內建 profile {id} 要出現在清單中：{availability}"
        );
    }
}
