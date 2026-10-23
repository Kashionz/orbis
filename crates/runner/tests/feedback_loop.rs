//! Feedback Loop 的接續執行（ARCHITECTURE §5.2、issue #34）：PR 開出後的修正是新的 Run
//! （origin = feedback_loop），派回原 Runner，沿用前一個 Run 的 Worktree、分支與 session；
//! 修正完成後照常經過 Review Gate 的核准與 push。

mod support;

use std::path::{Path, PathBuf};

use orbis_protocol::control::{RunControlAction, RunControlOutcome};
use orbis_protocol::dispatch::DispatchContinuation;
use orbis_protocol::enums::{GateDecision, GateKind, PromptSource, RunOrigin};
use serde_json::Value;
use support::flow::Env;
use support::server::{RunnerSide, offer, parse_result, send_offer};
use support::{branch, runner_script, toml_string};

/// runner.toml：原 Run 用 `fake`（可以接續 session），修正用 `fake`，另有接不回 session 的 `fresh`。
fn agents(wt: &Path) -> String {
    let bin = toml_string(&support::fake_agent_bin().to_string_lossy());
    let script = |name: &str| toml_string(&runner_script(name).to_string_lossy());
    let state = toml_string(&wt.parent().unwrap().join("agent-state").to_string_lossy());
    format!(
        "worktree_root = {}\n[agents.fake]\ncommand = {bin}\nargs = [\"--state-dir\", {state}, \"--script\", {}]\n[agents.fresh]\ncommand = {bin}\nargs = [\"--script\", {}]\n",
        toml_string(&wt.to_string_lossy()),
        script("fl-first.yaml"),
        script("fl-fresh.yaml"),
    )
}

async fn wait_run(conn: &mut RunnerSide, run: &str, kind: &str) -> Value {
    let what = format!("{run} 的 {kind}");
    conn.wait_for(&what, |v| {
        v["type"] == "event" && v["run_id"] == run && v["kind"] == kind
    })
    .await
}

async fn wait_status(conn: &mut RunnerSide, run: &str, status: &str) -> Value {
    let what = format!("{run} 的狀態 {status}");
    conn.wait_for(&what, |v| {
        v["type"] == "event"
            && v["run_id"] == run
            && v["kind"] == "status_changed"
            && v["status"] == status
    })
    .await
}

/// Review Gate 核准並 push，回傳 push 出去的 commit。
async fn approve_and_push(conn: &mut RunnerSide, run: &str) -> String {
    let dispatch = format!("d-{run}");
    conn.control(
        run,
        &dispatch,
        &format!("{run}-approve"),
        RunControlAction::GateResult {
            gate: GateKind::Review,
            decision: GateDecision::Approved,
        },
    )
    .await;
    let result = conn
        .control(
            run,
            &dispatch,
            &format!("{run}-push"),
            RunControlAction::PushBranch,
        )
        .await;
    let RunControlOutcome::BranchPushed { commit_sha, .. } = parse_result(&result).outcome else {
        panic!("push 應該成功：{result}");
    };
    wait_status(conn, run, "completed").await;
    commit_sha
}

/// 原 Run：新增 fl.txt → 核准 → push。回傳（Worktree, base commit, session id）。
async fn first_run(conn: &mut RunnerSide) -> (PathBuf, String, String) {
    let ready = wait_run(conn, "r1", "worktree_ready").await;
    let session = wait_run(conn, "r1", "agent_session").await;
    wait_status(conn, "r1", "awaiting_gate").await;
    approve_and_push(conn, "r1").await;
    (
        PathBuf::from(ready["worktree_path"].as_str().unwrap()),
        ready["base_commit"].as_str().unwrap().to_owned(),
        session["session_id"].as_str().unwrap().to_owned(),
    )
}

/// 修正的 Run（Feedback Loop）。
async fn offer_fix(
    env: &Env,
    conn: &mut RunnerSide,
    agent: &str,
    base_commit: &str,
    session_id: Option<String>,
) {
    let mut o = offer(
        "r2",
        "d-r2",
        env.remote.dispatch_repo("web"),
        agent,
        "請修正 review 留言：fl.txt 改成 v2",
    );
    o.run_seq = 2;
    o.branch = Some(branch("ORB-1-r1"));
    o.origin = Some(RunOrigin::FeedbackLoop);
    o.prompt_source = Some(PromptSource::FeedbackReview);
    o.continuation = Some(DispatchContinuation {
        previous_run_id: "r1".into(),
        session_id,
        base_commit: base_commit.to_owned(),
    });
    conn.send(&send_offer(o)).await;
    let reply = conn
        .wait_for("修正 Run 的 dispatch 回覆", |v| {
            v["dispatch_id"] == "d-r2"
                && (v["type"] == "dispatch_accept" || v["type"] == "dispatch_reject")
        })
        .await;
    assert_eq!(reply["type"], "dispatch_accept", "{reply}");
}

/// session 還能接續：沿用原 Run 的 Worktree、分支、base commit 與 session，修正後核准並 push。
#[tokio::test(flavor = "multi_thread")]
async fn 沿用原_run_的_worktree_與_session_修正後_push() {
    let mut env = Env::new(&[("README.md", "a\n")], agents).await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "新增 fl.txt").await;
    let (worktree, base, session) = first_run(&mut conn).await;

    offer_fix(&env, &mut conn, "fake", &base, Some(session.clone())).await;
    let ready = wait_run(&mut conn, "r2", "worktree_ready").await;
    assert_eq!(
        PathBuf::from(ready["worktree_path"].as_str().unwrap()),
        worktree
    );
    assert_eq!(ready["base_commit"], base.as_str());
    assert_eq!(ready["branch"], branch("ORB-1-r1").as_str());
    let resumed = wait_run(&mut conn, "r2", "agent_session").await;
    assert_eq!(
        resumed["session_id"],
        session.as_str(),
        "接續同一個 session"
    );
    let prompt = wait_run(&mut conn, "r2", "prompt_submitted").await;
    assert_eq!(prompt["source"], "feedback_review");
    wait_status(&mut conn, "r2", "awaiting_gate").await;
    assert!(
        !conn
            .events
            .iter()
            .any(|e| e["run_id"] == "r2" && e["code"] == "session_resume_failed"),
        "接續成功時不送 session_resume_failed"
    );
    let pushed = approve_and_push(&mut conn, "r2").await;
    let content = support::git(&env.remote.bare, &["show", &format!("{pushed}:fl.txt")]);
    assert_eq!(content.trim(), "v2");
}

/// session 接不回來：送 session_resume_failed（非 fatal），開新 session，第一個 prompt 附上 Task 與
/// 目前的變更；原本的 Worktree 不見了也從分支重建。
#[tokio::test(flavor = "multi_thread")]
async fn 接不回原本的_session_時開新_session_並附上目前的變更() {
    let mut env = Env::new(&[("README.md", "a\n")], agents).await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "新增 fl.txt").await;
    let (worktree, base, session) = first_run(&mut conn).await;
    std::fs::remove_dir_all(&worktree).unwrap();

    offer_fix(&env, &mut conn, "fresh", &base, Some(session)).await;
    let ready = wait_run(&mut conn, "r2", "worktree_ready").await;
    let rebuilt = PathBuf::from(ready["worktree_path"].as_str().unwrap());
    assert_eq!(rebuilt, worktree, "在原本的位置重建");
    assert_eq!(
        std::fs::read_to_string(rebuilt.join("fl.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "v1\n",
        "重建的 Worktree 在原本的分支上"
    );
    let error = wait_run(&mut conn, "r2", "error").await;
    assert_eq!(error["code"], "session_resume_failed", "{error}");
    assert_eq!(error["fatal"], false);
    let prompt = wait_run(&mut conn, "r2", "prompt_submitted").await;
    let text = prompt.to_string();
    assert!(
        text.contains("原本的 session 無法恢復") && text.contains("fl.txt"),
        "{text}"
    );
    wait_status(&mut conn, "r2", "awaiting_gate").await;
}
