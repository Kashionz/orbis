//! 並行上限與 rate limit（ARCHITECTURE §7、issue #33）：各 Agent 的 rate limit 格式都能辨識，
//! Run 暫停到額度恢復後在同一個 session 繼續；暫停期間同一組 Credential 不接受新的 Dispatch。

mod support;

use std::time::{Duration, SystemTime};

use orbis_protocol::control::RunControlAction;
use serde_json::Value;
use support::flow::Env;
use support::runner_script;
use support::server::{RunnerSide, fake_agent_toml, offer, result_outcome, send_offer};

/// 跑劇本到 rate limit，回傳 `rate_limited` Event；之後確認在同一個 session 繼續並完成。
async fn rate_limited_then_resumed(script: &str) -> Value {
    rate_limited_then_resumed_as("fake", script).await
}

/// 同上，指定 Agent（`claude-code` 時把內建的 Claude Code 換成 Fake Agent）。
async fn rate_limited_then_resumed_as(agent: &str, script: &str) -> Value {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        if agent == "fake" {
            fake_agent_toml(wt, &runner_script(script))
        } else {
            support::flow::claude_code_as_fake(wt, &runner_script(script))
        }
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", agent, "做事").await;
    let limited = conn.wait_event("rate_limited").await;
    conn.wait_status("rate_limited").await;
    // 第二個回合要求 prompt 含「額度已恢復」：確認是同一個 session 的接續，而不是重來。
    conn.wait_for("額度恢復後的回合", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "額度恢復後繼續完成。"
    })
    .await;
    conn.wait_status("awaiting_gate").await;
    limited
}

fn resets_in_secs(limited: &Value) -> f64 {
    let at = humantime::parse_rfc3339(limited["resets_at"].as_str().unwrap()).unwrap();
    match at.duration_since(SystemTime::now()) {
        Ok(d) => d.as_secs_f64(),
        Err(e) => -e.duration().as_secs_f64(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_格式的_rate_limit_暫停後在同一個_session_繼續() {
    let limited = rate_limited_then_resumed("rate-limit-codex.yaml").await;
    assert!(
        limited["message"]
            .as_str()
            .unwrap()
            .contains("Internal error"),
        "{limited}"
    );
    assert!(
        resets_in_secs(&limited) < 5.0,
        "恢復時間來自「try again in 1s」：{limited}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_code_的_rate_limit_事件_暫停後在同一個_session_繼續() {
    let limited = rate_limited_then_resumed_as("claude-code", "rate-limit-claude.yaml").await;
    assert_eq!(
        limited["resets_at"], "2023-11-14T22:13:20.000Z",
        "恢復時間來自 _claude/rateLimit 的 resetsAt"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn gemini_格式的_rate_limit_暫停後在同一個_session_繼續() {
    let limited = rate_limited_then_resumed("rate-limit-gemini.yaml").await;
    assert!(
        limited["message"]
            .as_str()
            .unwrap()
            .contains("RESOURCE_EXHAUSTED"),
        "{limited}"
    );
    let secs = resets_in_secs(&limited);
    assert!(
        (-5.0..5.0).contains(&secs),
        "恢復時間來自「retry in 1.2s」：{limited}"
    );
}

/// 某個 Run 撞到 rate limit：到恢復時間之前，同一組 Credential 的新 Dispatch 以
/// `concurrency_limit` 拒絕，AgentAvailability 也回報無法使用。
#[tokio::test(flavor = "multi_thread")]
async fn rate_limit_期間同一組_credential_不接受新的_dispatch() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("rate-limit-long.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    conn.wait_status("rate_limited").await;

    let availability = conn
        .wait_for("rate limit 後的 agent_availability", |v| {
            v["type"] == "agent_availability"
                && v["agents"].as_array().is_some_and(|agents| {
                    agents
                        .iter()
                        .any(|a| a["id"] == "fake" && a["available"] == false)
                })
        })
        .await;
    let fake = availability["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == "fake")
        .unwrap();
    assert!(
        fake["unavailable_reason"]
            .as_str()
            .unwrap()
            .contains("額度"),
        "{fake}"
    );

    conn.send(&send_offer(offer(
        "r2",
        "d-r2",
        env.remote.dispatch_repo("web"),
        "fake",
        "另一個 Task",
    )))
    .await;
    let reply = conn
        .wait_for("r2 的 dispatch 回覆", |v| {
            v["dispatch_id"] == "d-r2"
                && (v["type"] == "dispatch_accept" || v["type"] == "dispatch_reject")
        })
        .await;
    assert_eq!(reply["type"], "dispatch_reject", "{reply}");
    assert_eq!(reply["reason"], "concurrency_limit", "{reply}");
    assert!(
        reply["message"].as_str().unwrap().contains("額度"),
        "{reply}"
    );

    // 中止設下暫停的 Run：Credential 的暫停解除（人可以用這個方式解鎖）。
    cancel(&mut conn, "r1").await;
    conn.wait_for("解除後的 agent_availability", |v| {
        v["type"] == "agent_availability"
            && v["agents"].as_array().is_some_and(|agents| {
                agents
                    .iter()
                    .any(|a| a["id"] == "fake" && a["available"] == true)
            })
    })
    .await;
}

async fn cancel(conn: &mut RunnerSide, run: &str) {
    let result = conn
        .control(run, &format!("d-{run}"), "cancel", RunControlAction::Cancel)
        .await;
    assert_eq!(result_outcome(&result), "applied");
    conn.wait_status("canceled").await;
}

/// 並行上限：同一組 Credential 的進行中 Run 達到 max_concurrent_runs 時，新的 Dispatch 被拒絕。
#[tokio::test(flavor = "multi_thread")]
async fn credential_達到並行上限時拒絕新的_dispatch() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        format!(
            "{}max_concurrent_runs = 1\n",
            fake_agent_toml(wt, &runner_script("slow.yaml"))
        )
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    conn.wait_status("running").await;
    conn.send(&send_offer(offer(
        "r2",
        "d-r2",
        env.remote.dispatch_repo("web"),
        "fake",
        "另一個 Task",
    )))
    .await;
    let reply = conn
        .wait_for("r2 的 dispatch 回覆", |v| {
            v["dispatch_id"] == "d-r2"
                && (v["type"] == "dispatch_accept" || v["type"] == "dispatch_reject")
        })
        .await;
    assert_eq!(reply["reason"], "concurrency_limit", "{reply}");
    tokio::time::timeout(Duration::from_secs(60), cancel(&mut conn, "r1"))
        .await
        .unwrap();
}
