//! Delegation（ARCHITECTURE §9、issue #39）：Child Run 一律在父 Run 的 Runner 上執行。
//! `consult` 在父 Worktree 中唯讀；`branch` 從父 Run 當下的 HEAD 開出子 Worktree，以 `merge_child`
//! 合併回來。防護規則：深度、Child Run 數量；父 Run 結束時連同 Child Run 一起中止。

mod support;

use std::path::{Path, PathBuf};

use orbis_protocol::control::RunControlAction;
use orbis_protocol::dispatch::DispatchDelegation;
use orbis_protocol::enums::{DelegationMode, PromptSource, RunOrigin};
use orbis_protocol::event::ContentBlock;
use orbis_protocol::frame::ServerToRunner;
use orbis_protocol::tool::{OrbisToolOutput, OrbisToolResult, ToolResultFrame};
use serde_json::Value;
use support::flow::{Env, control_r1};
use support::server::{RunnerSide, offer, send_offer};
use support::{branch, git, runner_script, toml_string};

/// runner.toml：父 Run 用 `fake`（`parent` 劇本），Child Run 用 `child`（`child` 劇本）。
fn agents(wt: &Path, parent: &str, child: &str) -> String {
    let bin = toml_string(&support::fake_agent_bin().to_string_lossy());
    let script = |name: &str| toml_string(&runner_script(name).to_string_lossy());
    format!(
        "worktree_root = {}\n[agents.fake]\ncommand = {bin}\nargs = [\"--script\", {}]\n[agents.child]\ncommand = {bin}\nargs = [\"--script\", {}]\n",
        toml_string(&wt.to_string_lossy()),
        script(parent),
        script(child),
    )
}

/// 送出 Child Run 的 Dispatch，回傳 Runner 的回覆（accept 或 reject）。
async fn offer_child(
    env: &Env,
    conn: &mut RunnerSide,
    run_id: &str,
    mode: DelegationMode,
    depth: u32,
    parent: &str,
) -> Value {
    let mut o = offer(
        run_id,
        &format!("d-{run_id}"),
        env.remote.dispatch_repo("web"),
        "child",
        "子任務",
    );
    o.run_seq = 10 + depth;
    o.origin = Some(RunOrigin::Delegation);
    o.branch = match mode {
        DelegationMode::Consult => None,
        DelegationMode::Branch => Some(branch(&format!("ORB-1-x--{run_id}"))),
    };
    o.delegation = Some(DispatchDelegation {
        parent_run_id: parent.into(),
        mode,
        depth: Some(depth),
        child_seq: Some(1),
    });
    let dispatch = format!("d-{run_id}");
    conn.send(&send_offer(o)).await;
    conn.wait_for("Child Run 的 dispatch 回覆", |v| {
        v["dispatch_id"] == dispatch.as_str()
            && (v["type"] == "dispatch_accept" || v["type"] == "dispatch_reject")
    })
    .await
}

/// 等某個 Run 的 Event。
async fn wait_run_event(conn: &mut RunnerSide, run: &str, kind: &str) -> Value {
    let what = format!("{run} 的 {kind}");
    conn.wait_for(&what, |v| {
        v["type"] == "event" && v["run_id"] == run && v["kind"] == kind
    })
    .await
}

async fn wait_run_status(conn: &mut RunnerSide, run: &str, status: &str) -> Value {
    let what = format!("{run} 的狀態 {status}");
    conn.wait_for(&what, |v| {
        v["type"] == "event"
            && v["run_id"] == run
            && v["kind"] == "status_changed"
            && v["status"] == status
    })
    .await
}

fn worktree_of(ready: &Value) -> PathBuf {
    PathBuf::from(ready["worktree_path"].as_str().unwrap())
}

async fn reply_tool(conn: &mut RunnerSide, call: &Value, output: OrbisToolOutput) {
    conn.send(&ServerToRunner::ToolResult(ToolResultFrame {
        call_id: call["call_id"].as_str().unwrap().into(),
        run_id: call["run_id"].as_str().unwrap().into(),
        result: OrbisToolResult::Ok {
            output: Box::new(output),
        },
    }))
    .await;
}

/// consult 模式：在父 Run 的 Worktree 中執行，寫入一律拒絕。
#[tokio::test(flavor = "multi_thread")]
async fn consult_在父_worktree_中唯讀() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        agents(wt, "deleg-wait.yaml", "deleg-consult-write.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "父 Run").await;
    let parent_wt = worktree_of(&wait_run_event(&mut conn, "r1", "worktree_ready").await);
    wait_run_status(&mut conn, "r1", "running").await;

    let reply = offer_child(&env, &mut conn, "c1", DelegationMode::Consult, 1, "r1").await;
    assert_eq!(reply["type"], "dispatch_accept", "{reply}");
    let ready = wait_run_event(&mut conn, "c1", "worktree_ready").await;
    assert_eq!(
        worktree_of(&ready),
        parent_wt,
        "consult 用父 Run 的 Worktree"
    );
    assert_eq!(ready["branch"], Value::Null);
    wait_run_status(&mut conn, "c1", "completed").await;
    assert!(!parent_wt.join("consult.txt").exists(), "consult 是唯讀的");
    assert!(
        !conn
            .events
            .iter()
            .any(|e| e["run_id"] == "c1" && e["kind"] == "permission_request"),
        "唯讀的寫入直接拒絕，不問人"
    );
}

/// 深度超過上限的 Child Run 被拒絕；已在上限的 Child Run 呼叫 delegate 時在本機就被擋下。
#[tokio::test(flavor = "multi_thread")]
async fn 深度超過上限被拒絕() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        agents(wt, "deleg-wait.yaml", "deleg-delegate.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "父 Run").await;
    wait_run_status(&mut conn, "r1", "running").await;

    let too_deep = offer_child(&env, &mut conn, "c3", DelegationMode::Consult, 3, "r1").await;
    assert_eq!(too_deep["type"], "dispatch_reject", "{too_deep}");
    assert_eq!(too_deep["reason"], "unsupported");

    // 深度 2 的 Child Run 再呼叫 delegate：Runner 回 depth_exceeded，不送到 Server。
    let reply = offer_child(&env, &mut conn, "c2", DelegationMode::Consult, 2, "r1").await;
    assert_eq!(reply["type"], "dispatch_accept", "{reply}");
    let failed = conn
        .wait_for("被擋下的 delegate", |v| {
            v["run_id"] == "c2"
                && v["kind"] == "tool_call"
                && v["tool_call_id"] == "delegate"
                && v["status"] == "failed"
        })
        .await;
    assert!(failed.to_string().contains("depth_exceeded"), "{failed}");
    wait_run_status(&mut conn, "c2", "completed").await;
    assert!(
        !conn.frames().iter().any(|f| f["type"] == "tool_call"),
        "本機擋下的呼叫不送到 Server"
    );
}

/// 每個 Run 同時最多 5 個 Child Run；父 Run 不在這台 Runner 時也拒絕。
#[tokio::test(flavor = "multi_thread")]
async fn child_run_數量超過上限被拒絕() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        agents(wt, "deleg-wait.yaml", "deleg-wait.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "父 Run").await;
    wait_run_status(&mut conn, "r1", "running").await;
    for n in 1..=5 {
        let id = format!("c{n}");
        let reply = offer_child(&env, &mut conn, &id, DelegationMode::Consult, 1, "r1").await;
        assert_eq!(reply["type"], "dispatch_accept", "{reply}");
        wait_run_status(&mut conn, &id, "running").await;
    }
    let sixth = offer_child(&env, &mut conn, "c6", DelegationMode::Consult, 1, "r1").await;
    assert_eq!(sixth["type"], "dispatch_reject", "{sixth}");
    assert!(sixth["message"].as_str().unwrap().contains('5'), "{sixth}");

    let orphan = offer_child(&env, &mut conn, "c7", DelegationMode::Consult, 1, "nope").await;
    assert_eq!(orphan["type"], "dispatch_reject", "{orphan}");
}

/// 父 Run 被中止時，Child Run 一併中止。
#[tokio::test(flavor = "multi_thread")]
async fn 父_run_中止時_child_run_一併中止() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        agents(wt, "deleg-wait.yaml", "deleg-wait.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "父 Run").await;
    wait_run_status(&mut conn, "r1", "running").await;
    let reply = offer_child(&env, &mut conn, "c1", DelegationMode::Consult, 1, "r1").await;
    assert_eq!(reply["type"], "dispatch_accept", "{reply}");
    wait_run_status(&mut conn, "c1", "running").await;

    control_r1(&mut conn, "cancel", RunControlAction::Cancel).await;
    wait_run_status(&mut conn, "r1", "canceled").await;
    wait_run_status(&mut conn, "c1", "canceled").await;
    assert!(
        !conn
            .frames()
            .iter()
            .any(|f| f["type"] == "run_control_result" && f["run_id"] == "c1"),
        "Runner 內部的中止不回 run_control_result"
    );
}

/// ask_parent：Child Run 阻塞到 Server 回覆（父 Agent 以 answer_child 或人在 Needs You 回答）。
#[tokio::test(flavor = "multi_thread")]
async fn ask_parent_阻塞到收到回答() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        agents(wt, "deleg-wait.yaml", "deleg-ask.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "父 Run").await;
    wait_run_status(&mut conn, "r1", "running").await;
    let reply = offer_child(&env, &mut conn, "c1", DelegationMode::Consult, 1, "r1").await;
    assert_eq!(reply["type"], "dispatch_accept", "{reply}");

    let call = conn
        .wait_for("ask_parent", |v| {
            v["type"] == "tool_call" && v["run_id"] == "c1"
        })
        .await;
    assert_eq!(call["call"]["tool"], "ask_parent");
    assert_eq!(call["call"]["question"], "要用哪個方案？");
    // 還沒有回答之前 Child Run 停在這個工具呼叫上。
    conn.drain(std::time::Duration::from_millis(800)).await;
    assert!(
        !conn
            .events
            .iter()
            .any(|e| e["run_id"] == "c1" && e["kind"] == "final_message"),
        "回答之前 Child Run 的回合不會結束"
    );
    reply_tool(
        &mut conn,
        &call,
        OrbisToolOutput::AskParent {
            answer: "用 A 方案".into(),
        },
    )
    .await;
    let answered = conn
        .wait_for("ask_parent 的結果", |v| {
            v["run_id"] == "c1"
                && v["kind"] == "tool_call"
                && v["tool_call_id"] == "ask"
                && v["status"] == "completed"
        })
        .await;
    assert!(answered.to_string().contains("用 A 方案"), "{answered}");
    wait_run_status(&mut conn, "c1", "completed").await;
}

/// branch 模式：從父 Run 當下的 HEAD 開出子 Worktree；merge_child 有衝突時保留衝突狀態交給父 Agent，
/// 父 Agent 結束回合時還沒解決 → error(merge_child_conflict)，停在 Review Gate 等人處理。
#[tokio::test(flavor = "multi_thread")]
async fn branch_的_merge_child_發生衝突() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        agents(wt, "deleg-parent-merge.yaml", "deleg-child-edit.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "父 Run").await;
    let parent_wt = worktree_of(&wait_run_event(&mut conn, "r1", "worktree_ready").await);
    wait_run_status(&mut conn, "r1", "awaiting_gate").await;
    git(&parent_wt, &["add", "shared.txt"]);
    git(&parent_wt, &["commit", "-qm", "base"]);
    let parent_head = git(&parent_wt, &["rev-parse", "HEAD"]);

    let reply = offer_child(&env, &mut conn, "c1", DelegationMode::Branch, 1, "r1").await;
    assert_eq!(reply["type"], "dispatch_accept", "{reply}");
    let ready = wait_run_event(&mut conn, "c1", "worktree_ready").await;
    assert_eq!(
        ready["base_commit"],
        parent_head.as_str(),
        "從父 Run 當下的 HEAD 開出"
    );
    assert_eq!(ready["branch"], branch("ORB-1-x--c1").as_str());
    let child_wt = worktree_of(&ready);
    assert_ne!(child_wt, parent_wt);
    wait_run_status(&mut conn, "c1", "completed").await;
    git(&child_wt, &["commit", "-qam", "child"]);

    // 父 Run 也改了同一行 → merge 會衝突。
    std::fs::write(parent_wt.join("shared.txt"), "parent\n").unwrap();
    git(&parent_wt, &["commit", "-qam", "parent"]);

    control_r1(
        &mut conn,
        "prompt",
        RunControlAction::Prompt {
            prompt: vec![ContentBlock::Text {
                text: "請 merge c1".into(),
            }],
            source: Some(PromptSource::ReviewGate),
        },
    )
    .await;
    let call = conn
        .wait_for("merge_child", |v| {
            v["type"] == "tool_call" && v["run_id"] == "r1"
        })
        .await;
    assert_eq!(call["call"]["tool"], "merge_child");
    assert_eq!(call["call"]["run_id"], "c1");
    reply_tool(
        &mut conn,
        &call,
        OrbisToolOutput::MergeChild {
            branch: branch("ORB-1-x--c1"),
            head_commit: None,
        },
    )
    .await;
    let merged = wait_run_event(&mut conn, "r1", "child_merged").await;
    assert_eq!(merged["outcome"], "conflict", "{merged}");
    assert_eq!(
        merged["conflicted_paths"],
        serde_json::json!(["shared.txt"])
    );
    let result = conn
        .wait_for("merge_child 的結果", |v| {
            v["run_id"] == "r1"
                && v["kind"] == "tool_call"
                && v["tool_call_id"] == "merge"
                && v["status"] == "completed"
        })
        .await;
    assert!(result.to_string().contains("conflict"), "{result}");
    let error = wait_run_event(&mut conn, "r1", "error").await;
    assert_eq!(error["code"], "merge_child_conflict", "{error}");
    assert_eq!(error["fatal"], false);
    let gate = wait_run_status(&mut conn, "r1", "awaiting_gate").await;
    assert!(
        gate["message"].as_str().unwrap().contains("merge_child"),
        "{gate}"
    );
}
