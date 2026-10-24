//! 內建的 Agent Profile（ARCHITECTURE §7、issue #31、#18）：把每個內建 profile 的啟動指令換成
//! Fake Agent 跑一個 Task，確認 profile 的修補（session mode、session 的 `_meta`）仍會套用，
//! 以及 AgentAvailability 回報從 `initialize` 得到的能力旗標。真實 Agent 的確認在 Windows 實機上手動進行。

mod support;

use std::path::Path;

use orbis_fake_agent::agent::{AUTHENTICATED_FILE, SESSION_MODE_PREFIX};
use orbis_runner::agent::{ANTIGRAVITY, CLAUDE_CODE, CODEX, GROK};
use orbis_runner::home::RunnerHome;
use serde_json::Value;
use support::flow::Env;
use support::server::{fake_agent_toml, offer, send_offer};
use support::{runner_script, toml_string};

/// runner.toml：內建 profile `id` 的啟動指令換成 Fake Agent（加上 `extra` 參數）。
fn builtin_as_fake(id: &str, wt: &Path, extra: &[&str]) -> String {
    builtin_with_script(id, wt, "profile-check.yaml", extra)
}

/// 同 [`builtin_as_fake`]，指定 Runner 測試的劇本。
fn builtin_with_script(id: &str, wt: &Path, script: &str, extra: &[&str]) -> String {
    let mut args = vec![
        toml_string("--script"),
        toml_string(&runner_script(script).to_string_lossy()),
    ];
    args.extend(extra.iter().map(|a| toml_string(a)));
    format!(
        "worktree_root = {}\n[agents.{id}]\ncommand = {}\nargs = [{}]\n",
        toml_string(&wt.to_string_lossy()),
        toml_string(&support::fake_agent_bin().to_string_lossy()),
        args.join(", "),
    )
}

/// 記下 `id` 已由 Runner 代為登入（等同 `orbis-runner login` 成功）。
fn mark_logged_in(env: &Env, id: &str) {
    let home = RunnerHome::open_with(Some(env.home()), None).unwrap();
    orbis_runner::login::record(&home, id).unwrap();
}

/// 跑一個 Task，回傳 Agent 回報的 session mode 與 `_meta`。
async fn run_profile(id: &str, extra: &[&str]) -> (String, Value) {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| builtin_as_fake(id, wt, extra)).await;
    if id == ANTIGRAVITY {
        mark_logged_in(&env, id);
    }
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

/// Antigravity：使用者設定可能預設 yolo（全部自動核准），切回逐項詢問的 default 模式。
#[tokio::test(flavor = "multi_thread")]
async fn antigravity_切回會詢問的模式() {
    let (mode, meta) = run_profile(
        ANTIGRAVITY,
        &[
            "--modes",
            "default,auto_edit,yolo",
            "--initial-mode",
            "yolo",
        ],
    )
    .await;
    assert_eq!(mode, "default");
    assert_eq!(meta, Value::Null);
}

/// Grok Build：沒有 session mode 的修補，照樣能完成一個 Task。
#[tokio::test(flavor = "multi_thread")]
async fn grok_可以完成一個_task() {
    let (mode, meta) = run_profile(GROK, &[]).await;
    assert_eq!(mode, "none");
    assert_eq!(meta, Value::Null);
}

/// AgentAvailability 中 `id` 的項目。
fn agent_entry(availability: &Value, id: &str) -> Value {
    availability["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == id)
        .cloned()
        .unwrap()
}

/// Antigravity 還沒有由 Runner 代為登入：回報無法使用（原因是登入指令），也不接受派工。
/// 否則它會被當成可用的 Agent，Web 的派工對話框可能預設選到它（CI 的完整系統 e2e 發現）。
#[tokio::test(flavor = "multi_thread")]
async fn antigravity_登入前回報無法使用且不接受派工() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        builtin_as_fake(ANTIGRAVITY, wt, &[])
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    let availability = conn
        .wait_for("agent_availability", |v| v["type"] == "agent_availability")
        .await;
    let entry = agent_entry(&availability, ANTIGRAVITY);
    assert_eq!(entry["available"], false, "{entry}");
    assert!(
        entry["unavailable_reason"]
            .as_str()
            .unwrap()
            .contains("-runner login antigravity"),
        "{entry}"
    );
    assert_eq!(agent_entry(&availability, CLAUDE_CODE)["id"], CLAUDE_CODE);
    conn.send(&send_offer(offer(
        "r1",
        "d-r1",
        env.remote.dispatch_repo("web"),
        ANTIGRAVITY,
        "做事",
    )))
    .await;
    let reply = conn
        .wait_for("dispatch 回覆", |v| {
            v["type"] == "dispatch_accept" || v["type"] == "dispatch_reject"
        })
        .await;
    assert_eq!(reply["type"], "dispatch_reject", "{reply}");
    assert_eq!(reply["reason"], "agent_unavailable", "{reply}");
}

/// 登入過、之後 Agent 回報需要登入（session/new 回 auth_required，例如認證過期）：Run 以
/// agent_start_failed 結束並提示登入指令，清掉登入標記，重送的 AgentAvailability 改成無法使用。
#[tokio::test(flavor = "multi_thread")]
async fn antigravity_登入失效時清掉標記並提示登入指令() {
    let extra = ["--auth-methods", "oauth-personal,gemini-api-key"];
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        builtin_as_fake(ANTIGRAVITY, wt, &extra)
    })
    .await;
    mark_logged_in(&env, ANTIGRAVITY);
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", ANTIGRAVITY, "做事").await;
    let error = conn.wait_event("error").await;
    assert_eq!(error["code"], "agent_start_failed", "{error}");
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("-runner login antigravity"),
        "{error}"
    );
    conn.wait_status("failed").await;
    let home = RunnerHome::open_with(Some(env.home()), None).unwrap();
    assert!(!orbis_runner::login::logged_in(&home, ANTIGRAVITY));
    conn.wait_for("登入失效後的 agent_availability", |v| {
        v["type"] == "agent_availability" && agent_entry(v, ANTIGRAVITY)["available"] == false
    })
    .await;
}

/// 執行 `orbis-runner --home <env 的 home> <args>`。
fn run_cli(env: &Env, args: &[&str]) -> std::process::Output {
    std::process::Command::new(env!("CARGO_BIN_EXE_orbis-runner"))
        .arg("--home")
        .arg(env.home())
        .args(args)
        .output()
        .unwrap()
}

/// `login` 子指令：啟動 Agent 並以預設的認證方式呼叫 `authenticate`；Agent 自己保存登入狀態，
/// 之後的 Run 不再要求登入。
#[tokio::test(flavor = "multi_thread")]
async fn login_子指令以預設的認證方式登入後可以派工() {
    let state = support::temp_dir("agy state");
    let state_dir = state.path().to_string_lossy().into_owned();
    let extra = [
        "--auth-methods",
        "oauth-personal,gemini-api-key",
        "--state-dir",
        state_dir.as_str(),
    ];
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        builtin_as_fake(ANTIGRAVITY, wt, &extra)
    })
    .await;
    let output = run_cli(&env, &["login", ANTIGRAVITY]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(state.path().join(AUTHENTICATED_FILE)).unwrap(),
        "oauth-personal"
    );
    let home = RunnerHome::open_with(Some(env.home()), None).unwrap();
    assert!(orbis_runner::login::logged_in(&home, ANTIGRAVITY));
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", ANTIGRAVITY, "做事").await;
    conn.wait_status("awaiting_gate").await;
}

/// `login` 子指令：Agent 不支援指定的認證方式時失敗；登入由自己的 CLI 處理的 Agent 不接受。
#[tokio::test(flavor = "multi_thread")]
async fn login_子指令拒絕不支援的認證方式與自己處理登入的_agent() {
    let extra = ["--auth-methods", "oauth-personal"];
    let env = Env::new(&[("README.md", "a\n")], |wt| {
        builtin_as_fake(ANTIGRAVITY, wt, &extra)
    })
    .await;
    let unsupported = run_cli(&env, &["login", ANTIGRAVITY, "--method", "gemini-api-key"]);
    assert!(!unsupported.status.success());
    let stderr = String::from_utf8_lossy(&unsupported.stderr);
    assert!(stderr.contains("oauth-personal"), "{stderr}");
    let codex = run_cli(&env, &["login", CODEX]);
    assert!(!codex.status.success());
    let stderr = String::from_utf8_lossy(&codex.stderr);
    assert!(stderr.contains("自己的 CLI"), "{stderr}");
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
    for id in [ANTIGRAVITY, CLAUDE_CODE, CODEX, GROK] {
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

/// Agent 有模式清單、卻沒有 profile 需要的模式（例如 Codex 沒有 read-only）時不啟動：
/// 可能停在會自動核准的模式（fail closed）。
#[tokio::test(flavor = "multi_thread")]
async fn 沒有需要的_session_mode_時拒絕啟動() {
    let extra = [
        "--modes",
        "agent,agent-full-access",
        "--initial-mode",
        "agent",
    ];
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        builtin_as_fake(CODEX, wt, &extra)
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", CODEX, "做事").await;
    let error = conn.wait_event("error").await;
    assert_eq!(error["code"], "agent_start_failed", "{error}");
    assert!(
        error["message"].as_str().unwrap().contains("read-only"),
        "{error}"
    );
    conn.wait_status("failed").await;
}

/// Antigravity 在受保護的 `.agents/` 目錄中新增 skill（不經過權限請求）：session 中途中止並問人。
#[tokio::test(flavor = "multi_thread")]
async fn antigravity_在受保護的目錄新增_skill_時中途問人() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        builtin_with_script(ANTIGRAVITY, wt, "antigravity-settings.yaml", &[])
    })
    .await;
    mark_logged_in(&env, ANTIGRAVITY);
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", ANTIGRAVITY, "做事").await;
    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "agent_settings_changed", "{request}");
    assert!(
        request["title"]
            .as_str()
            .unwrap()
            .contains(".agents/skills/deploy/SKILL.md"),
        "{request}"
    );
    support::flow::answer(&mut conn, "c1", &request, "allow_once").await;
    conn.wait_for("第二回合", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "第二回合完成。"
    })
    .await;
    conn.wait_status("awaiting_gate").await;
}
