//! 執行中換 Agent 並接續作業（agent-switch，ARCHITECTURE §7、ADR-0016）：兩個 Fake Agent 設定檔、
//! 真實 git 的 Worktree，交接 prompt 以 snapshot 鎖定格式。

mod support;

use std::path::Path;

use orbis_protocol::control::{HandoffContext, HandoffReviewComment, RunControlAction};
use orbis_protocol::dispatch::DispatchCriterion;
use orbis_protocol::enums::{AcceptanceCriterionKind, GateDecision, GateKind};
use orbis_protocol::event::{ContentBlock, TextBody};
use serde_json::Value;
use support::flow::Env;
use support::server::{RunnerSide, result_outcome};
use support::{fake_agent_bin, runner_script, toml_string};

/// runner.toml：`fake-a` 與 `fake-b` 兩個 Agent，各自執行指定的劇本；`fake-broken` 建立 session 時失敗。
fn two_agents(wt: &Path, a: &str, b: &str) -> String {
    let agent = |id: &str, args: Vec<String>| {
        format!(
            "[agents.{id}]\ncommand = {}\nargs = [{}]\n",
            toml_string(&fake_agent_bin().to_string_lossy()),
            args.iter()
                .map(|a| toml_string(a))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let script = |name: &str| {
        vec![
            "--script".to_owned(),
            runner_script(name).to_string_lossy().into_owned(),
        ]
    };
    format!(
        "worktree_root = {}\n{}{}{}",
        toml_string(&wt.to_string_lossy()),
        agent("fake-a", script(a)),
        agent("fake-b", script(b)),
        // initialize 成功（探測時可用），建立 session 時要求登入：啟動失敗。
        agent("fake-broken", {
            let mut args = script(b);
            args.extend(["--auth-methods".to_owned(), "oauth-personal".to_owned()]);
            args
        }),
    )
}

fn handoff() -> HandoffContext {
    HandoffContext {
        task_spec: TextBody::Inline {
            text: "新增 src.txt，內容是問候語。".into(),
        },
        acceptance_criteria: vec![
            DispatchCriterion {
                criterion_id: "ac1".into(),
                kind: AcceptanceCriterionKind::Command,
                description: "測試通過".into(),
                command: Some("pnpm test".into()),
            },
            DispatchCriterion {
                criterion_id: "ac2".into(),
                kind: AcceptanceCriterionKind::Manual,
                description: "內容讀起來自然".into(),
                command: None,
            },
        ],
        review_comments: vec![
            HandoffReviewComment {
                path: Some("src.txt".into()),
                line: Some(1),
                url: None,
                body: "第一行改成大寫".into(),
            },
            HandoffReviewComment {
                path: None,
                line: None,
                url: Some("http://localhost:41000/".into()),
                body: "首頁的標題太小".into(),
            },
        ],
    }
}

fn switch(agent: &str) -> RunControlAction {
    RunControlAction::SwitchAgent {
        agent: agent.into(),
        model: None,
        effort: None,
        credential: None,
        handoff: Box::new(handoff()),
    }
}

async fn control(conn: &mut RunnerSide, id: &str, action: RunControlAction) -> Value {
    conn.control("r1", "d-r1", id, action).await
}

async fn reject_with(conn: &mut RunnerSide, id: &str, text: &str) {
    let gate = control(
        conn,
        &format!("{id}-gate"),
        RunControlAction::GateResult {
            gate: GateKind::Review,
            decision: GateDecision::Rejected,
        },
    )
    .await;
    assert_eq!(result_outcome(&gate), "applied");
    let prompt = control(
        conn,
        id,
        RunControlAction::Prompt {
            prompt: vec![ContentBlock::Text { text: text.into() }],
            source: None,
            delivery: None,
        },
    )
    .await;
    assert_eq!(result_outcome(&prompt), "applied");
}

/// `echo_prompt` 的回報去掉每個區塊的 `text:` 前綴（交接 prompt 只有一個文字區塊）。
fn echoed(final_message: &Value) -> String {
    final_message["text"]["text"]
        .as_str()
        .unwrap()
        .replace("\r\n", "\n")
        .strip_prefix("text:")
        .unwrap_or_default()
        .to_owned()
}

/// 和 `tests/snapshots/<name>` 比對；檔案不存在時寫入並失敗（確認內容後再跑一次）。
fn assert_snapshot(name: &str, actual: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("snapshots")
        .join(name);
    match std::fs::read_to_string(&path) {
        Ok(expected) => assert_eq!(
            actual,
            expected.replace("\r\n", "\n"),
            "交接 prompt 和 snapshot 不同"
        ),
        Err(_) => {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, actual).unwrap();
            panic!("已建立 snapshot {}，確認內容後再跑一次", path.display());
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn review_gate_時換_agent_交接_prompt_固定格式且用量重新累計() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        two_agents(wt, "switch-a.yaml", "switch-b.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake-a", "請建立 src.txt").await;
    conn.wait_status("awaiting_gate").await;
    reject_with(&mut conn, "back1", "內容改成 hello world").await;
    conn.wait_status("awaiting_gate").await;

    let result = control(&mut conn, "sw1", switch("fake-b")).await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
    let switched = conn.wait_event("agent_switched").await;
    assert_eq!(switched["from"], "fake-a");
    assert_eq!(switched["to"], "fake-b");
    assert_eq!(switched["control_id"], "sw1");
    let session = conn.wait_event("agent_session").await;
    assert!(session["seq"].as_u64() > switched["seq"].as_u64());
    let submitted = conn.wait_event("prompt_submitted").await;
    assert_eq!(submitted["source"], "handoff");
    assert!(submitted.get("control_id").is_none_or(Value::is_null));
    let prompt = echoed(&conn.wait_event("final_message").await);
    assert_snapshot("handoff.txt", &prompt);

    // 換 Agent 之後的 usage 是新的一段（從 0 開始的累計值）。
    let usage: Vec<u64> = conn
        .frames()
        .iter()
        .filter(|v| v["kind"] == "usage" && v["seq"].as_u64() > switched["seq"].as_u64())
        .map(|v| v["context_used_tokens"].as_u64().unwrap())
        .collect();
    assert_eq!(usage, [100], "{:#?}", conn.event_summary());
    conn.wait_status("awaiting_gate").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn 回合中換_agent_等回合結束才切換() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        two_agents(wt, "switch-a-long.yaml", "switch-b.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake-a", "開始").await;
    let ready = conn.wait_event("worktree_ready").await;
    let wt = std::path::PathBuf::from(ready["worktree_path"].as_str().unwrap());
    conn.wait_for("第一個回合開始", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "第一個回合開始"
    })
    .await;
    let result = control(&mut conn, "sw1", switch("fake-b")).await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
    conn.drain(std::time::Duration::from_millis(500)).await;
    assert!(
        !conn.frames().iter().any(|v| v["kind"] == "agent_switched"),
        "回合中不切換"
    );
    std::fs::write(wt.join("turn1.done"), "").unwrap();
    conn.wait_for("第一個回合完成", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "第一個回合完成"
    })
    .await;
    conn.wait_event("agent_switched").await;
    let submitted = conn.wait_event("prompt_submitted").await;
    assert_eq!(submitted["source"], "handoff");
    let prompt = echoed(&conn.wait_event("final_message").await);
    assert!(
        prompt.contains("第一個回合完成"),
        "交接 prompt 包含上一個回合的回覆：{prompt}"
    );
    conn.wait_status("awaiting_gate").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn 不能用的_agent_拒絕_新的啟動失敗時保留原本的() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        two_agents(wt, "switch-a.yaml", "switch-b.yaml")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake-a", "請建立 src.txt").await;
    conn.wait_status("awaiting_gate").await;

    let missing = control(&mut conn, "sw0", switch("no-such-agent")).await;
    assert_eq!(missing["reason"], "failed", "{missing}");

    let broken = control(&mut conn, "sw1", switch("fake-broken")).await;
    assert_eq!(result_outcome(&broken), "applied");
    let error = conn.wait_event("error").await;
    assert_eq!(error["code"], "agent_start_failed");
    assert_eq!(error["fatal"], false);
    assert!(!conn.frames().iter().any(|v| v["kind"] == "agent_switched"));
    // 原本的 Agent 還在：退回後照常繼續。
    reject_with(&mut conn, "back1", "內容改成 hello world").await;
    conn.wait_for("原本的 Agent 的第二個回合", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "已改成 hello。"
    })
    .await;
    conn.wait_status("awaiting_gate").await;
}
