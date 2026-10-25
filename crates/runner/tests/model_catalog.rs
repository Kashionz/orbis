//! 模型目錄（model-catalog）與重新登入（agent-relogin）的 Runner 端（ARCHITECTURE §7）：
//! AgentAvailability 的模型清單、顯示資訊、登入狀態與登入方式。

mod support;

use std::path::Path;
use std::time::Duration;

use orbis_runner::agent::{ANTIGRAVITY, CLAUDE_CODE};
use orbis_runner::home::RunnerHome;
use serde_json::Value;
use support::flow::Env;
use support::server::RunnerSide;
use support::{fake_agent_bin, runner_script, toml_string};

/// runner.toml：內建 profile `id` 的啟動指令換成以 `script` 執行的 Fake Agent。
fn builtin_with_script(id: &str, wt: &Path, script: &str) -> String {
    builtin_with_script_path(id, wt, &runner_script(script))
}

fn builtin_with_script_path(id: &str, wt: &Path, script: &Path) -> String {
    format!(
        "worktree_root = {}\n[agents.{id}]\ncommand = {}\nargs = [{}, {}]\n",
        toml_string(&wt.to_string_lossy()),
        toml_string(&fake_agent_bin().to_string_lossy()),
        toml_string("--script"),
        toml_string(&script.to_string_lossy()),
    )
}

/// 下一個符合條件的 agent_availability 中 `id` 的 AgentInfo。
async fn agent_info(
    conn: &mut RunnerSide,
    id: &str,
    what: &str,
    pred: impl Fn(&Value) -> bool,
) -> Value {
    let find = |v: &Value| {
        v["agents"]
            .as_array()
            .and_then(|agents| agents.iter().find(|a| a["id"] == id).cloned())
    };
    let frame = conn
        .wait_for(what, |v| {
            v["type"] == "agent_availability" && find(v).is_some_and(|a| pred(&a))
        })
        .await;
    find(&frame).unwrap()
}

fn sources(info: &Value) -> Vec<String> {
    info["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["source"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn 沒有_session_時回報_profile_清單_跑過之後改用_session_版本() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        builtin_with_script(CLAUDE_CODE, wt, "settings.yaml")
    })
    .await;
    let mut runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    let info = agent_info(&mut conn, CLAUDE_CODE, "第一次的清單", |_| true).await;
    assert_eq!(info["display_name"], "Claude Code");
    assert_eq!(info["vendor"], "Anthropic");
    assert_eq!(info["cli"], "claude");
    assert_eq!(info["login_hint"]["kind"], "cli");
    assert_eq!(info["signed_in"], Value::Null, "還沒有跑過 session");
    assert!(!info["models"].as_array().unwrap().is_empty());
    assert!(sources(&info).iter().all(|s| s == "profile"), "{info}");
    let opus = info["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "claude-opus-5-5")
        .unwrap();
    assert_eq!(opus["tag"], "best");
    assert_eq!(opus["effort"]["kind"], "adjustable");

    env.offer(&mut conn, "r1", CLAUDE_CODE, "做事", 1).await;
    let info = agent_info(&mut conn, CLAUDE_CODE, "session 版本的清單", |a| {
        a["models"][0]["source"] == "session"
    })
    .await;
    let ids: Vec<&str> = info["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["sonnet", "opus"]);
    assert_eq!(info["models"][1]["name"], "Opus 5.5");
    assert_eq!(
        info["models"][1]["effort"]["kind"], "adjustable",
        "有 thought level 選項"
    );
    assert_eq!(info["signed_in"], true, "session 建立成功");
    drop(conn);
    let _ = runner.child.kill().await;

    // Runner 重新啟動後仍然回報 session 版本（存在狀態目錄）。
    let _runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    let info = agent_info(&mut conn, CLAUDE_CODE, "重新啟動後的清單", |_| true).await;
    assert!(sources(&info).iter().all(|s| s == "session"), "{info}");
    assert_eq!(info["signed_in"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn 另一個程序登入後_下一次_heartbeat_重送可用性() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        builtin_with_script(ANTIGRAVITY, wt, "simple.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    let info = agent_info(&mut conn, ANTIGRAVITY, "登入前", |_| true).await;
    assert_eq!(info["signed_in"], false);
    assert_eq!(info["available"], false);
    assert_eq!(info["login_hint"]["kind"], "runner");
    assert!(
        info["login_hint"]["command"]
            .as_str()
            .unwrap()
            .ends_with("-runner login antigravity"),
        "{info}"
    );
    // 例如 Desktop 執行的 `<Runner> login antigravity` 寫下登入標記。
    let home = RunnerHome::open_with(Some(env.home()), None).unwrap();
    orbis_runner::login::record(&home, ANTIGRAVITY).unwrap();
    let info = agent_info(&mut conn, ANTIGRAVITY, "登入後重送", |a| {
        a["signed_in"] == true
    })
    .await;
    assert_eq!(info["available"], true, "{info}");
}

/// runner.toml 把 antigravity 換成以 `script` 執行的 Fake Agent，回傳 Runner home。
fn login_home(script: &Path) -> (tempfile::TempDir, RunnerHome) {
    let dir = support::temp_dir("login home");
    let toml = builtin_with_script_path(ANTIGRAVITY, &dir.path().join("wt"), script);
    support::server::write_runner_toml(&dir.path().join("home"), &toml);
    let home = RunnerHome::open_with(Some(dir.path().join("home")), None).unwrap();
    (dir, home)
}

#[tokio::test(flavor = "multi_thread")]
async fn login_成功時記下登入標記() {
    let (_dir, home) = login_home(&support::script("login.yaml"));
    orbis_runner::login::login(&home, ANTIGRAVITY, None, Duration::from_secs(30))
        .await
        .unwrap();
    assert!(orbis_runner::login::logged_in(&home, ANTIGRAVITY));
}

#[tokio::test(flavor = "multi_thread")]
async fn login_逾時或失敗時不記下登入標記() {
    let (_dir, home) = login_home(&runner_script("login-slow.yaml"));
    let error = orbis_runner::login::login(&home, ANTIGRAVITY, None, Duration::from_secs(1))
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("還沒有完成登入"), "{error:#}");
    assert!(!orbis_runner::login::logged_in(&home, ANTIGRAVITY));

    let (_dir, home) = login_home(&runner_script("login-error.yaml"));
    let error = orbis_runner::login::login(&home, ANTIGRAVITY, None, Duration::from_secs(30))
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("使用者取消了登入"),
        "{error:#}"
    );
    assert!(!orbis_runner::login::logged_in(&home, ANTIGRAVITY));
}
