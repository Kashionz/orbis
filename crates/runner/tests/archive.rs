//! 封存 Run（ARCHITECTURE §6.2、RunControl `archive`）：Run 結束後依本機紀錄刪除 Worktree；
//! archive hook 只在設定檔已「永遠允許」時執行；還在執行的 Run 不能封存。

mod support;

use std::path::PathBuf;

use orbis_protocol::control::{RunControlAction, RunControlOutcome, RunControlRejectReason};
use orbis_protocol::enums::{GateDecision, GateKind};
use serde_json::Value;
use support::flow::{Env, answer, control_r1};
use support::server::{RunnerSide, fake_agent_toml, parse_result};
use support::{cfg, runner_script};

async fn archive(conn: &mut RunnerSide, control_id: &str) -> RunControlOutcome {
    let result = conn
        .control("r1", "d-r1", control_id, RunControlAction::Archive)
        .await;
    parse_result(&result).outcome
}

/// （在 Review Gate 時）核准並 push，Run 結束。
async fn finish(conn: &mut RunnerSide) {
    control_r1(
        conn,
        "approve",
        RunControlAction::GateResult {
            gate: GateKind::Review,
            decision: GateDecision::Approved,
        },
    )
    .await;
    let pushed = conn
        .control("r1", "d-r1", "push", RunControlAction::PushBranch)
        .await;
    assert!(
        matches!(
            parse_result(&pushed).outcome,
            RunControlOutcome::BranchPushed { .. }
        ),
        "{pushed}"
    );
    conn.wait_status("completed").await;
}

fn worktree_of(ready: &Value) -> PathBuf {
    PathBuf::from(ready["worktree_path"].as_str().unwrap())
}

/// 結束的 Run：刪除 Worktree，重送的 archive 也回 applied；還在執行時拒絕。
#[tokio::test(flavor = "multi_thread")]
async fn 結束後刪除_worktree_執行中拒絕() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("verify-pass.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "新增 verify.txt").await;
    let worktree = worktree_of(&conn.wait_event("worktree_ready").await);
    conn.wait_status("awaiting_gate").await;
    let RunControlOutcome::Rejected { reason, .. } = archive(&mut conn, "a1").await else {
        panic!("執行中的 Run 不能封存");
    };
    assert_eq!(reason, RunControlRejectReason::InvalidState);
    assert!(worktree.exists());

    finish(&mut conn).await;
    assert_eq!(archive(&mut conn, "a2").await, RunControlOutcome::Applied);
    assert!(!worktree.exists(), "Worktree 已刪除");
    assert_eq!(
        archive(&mut conn, "a3").await,
        RunControlOutcome::Applied,
        "重送的 archive 也成功"
    );
}

/// archive hook：設定檔只有「允許這次」時 Run 結束後無法執行，拒絕且不刪 Worktree；
/// 「永遠允許」時執行 hook 後刪除。
#[tokio::test(flavor = "multi_thread")]
async fn archive_hook_只在永遠允許時執行() {
    for (option, archived) in [("allow_once", false), ("allow_always", true)] {
        let config = "[worktree]\narchive = \"git --version\"\n";
        let mut env = Env::new(&[("README.md", "a\n"), (cfg().as_str(), config)], |wt| {
            fake_agent_toml(wt, &runner_script("verify-pass.yaml"))
        })
        .await;
        let _runner = env.spawn();
        let mut conn = env.dispatch("r1", "fake", "新增 verify.txt").await;
        let worktree = worktree_of(&conn.wait_event("worktree_ready").await);
        let trust = conn.wait_event("permission_request").await;
        assert_eq!(trust["purpose"], "config_trust", "{trust}");
        answer(&mut conn, "trust", &trust, option).await;
        conn.wait_status("awaiting_gate").await;
        finish(&mut conn).await;
        let outcome = archive(&mut conn, "a1").await;
        if archived {
            assert_eq!(outcome, RunControlOutcome::Applied, "{option}");
            assert!(!worktree.exists());
        } else {
            let RunControlOutcome::Rejected { reason, message } = outcome else {
                panic!("只有允許這次時不執行 archive hook：{outcome:?}");
            };
            assert_eq!(reason, RunControlRejectReason::Failed);
            assert!(message.contains("永遠允許"), "{message}");
            assert!(worktree.exists(), "hook 沒有執行時不刪 Worktree");
        }
    }
}
