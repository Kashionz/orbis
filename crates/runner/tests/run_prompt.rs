//! 執行中傳訊息給 Agent（run-prompt，ARCHITECTURE §7）與事件的作者（event-actor）：
//! 真實 git 的 remote、真正的 Runner 執行檔、Fake Agent。

mod support;

use std::path::PathBuf;

use orbis_protocol::control::RunControlAction;
use orbis_protocol::enums::{PermissionPolicy, PromptDelivery};
use orbis_protocol::event::ContentBlock;
use serde_json::Value;
use support::flow::{Env, answer};
use support::runner_script;
use support::server::{RunnerSide, fake_agent_toml, result_outcome};

fn prompt(text: &str, delivery: Option<PromptDelivery>) -> RunControlAction {
    RunControlAction::Prompt {
        prompt: vec![ContentBlock::Text { text: text.into() }],
        source: None,
        delivery,
    }
}

/// 送一個 RunControl 給 `r1`，回傳 outcome。
async fn control(conn: &mut RunnerSide, id: &str, action: RunControlAction) -> Value {
    conn.control("r1", "d-r1", id, action).await
}

/// 等 Agent 開始第一個回合，回傳 Worktree 的路徑。
async fn first_turn_started(conn: &mut RunnerSide) -> PathBuf {
    let ready = conn.wait_event("worktree_ready").await;
    conn.wait_for("第一個回合開始", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "第一個回合開始"
    })
    .await;
    PathBuf::from(ready["worktree_path"].as_str().unwrap())
}

/// 這條連線上 `kind` 的所有 event。
fn events<'a>(conn: &'a RunnerSide, kind: &str) -> Vec<&'a Value> {
    conn.frames()
        .iter()
        .filter(|v| v["type"] == "event" && v["kind"] == kind)
        .collect()
}

fn reply(final_message: &Value) -> String {
    final_message["text"]["text"]
        .as_str()
        .unwrap_or_default()
        .replace("\r\n", "\n")
}

#[tokio::test(flavor = "multi_thread")]
async fn 回合中排兩則_回合結束後合併成一則送出且不進_gate() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("queue.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "開始").await;
    let worktree = first_turn_started(&mut conn).await;

    for (id, text) in [("q1", "第一則"), ("q2", "第二則")] {
        let result = control(&mut conn, id, prompt(text, None)).await;
        assert_eq!(result_outcome(&result), "applied", "{result}");
        let queued = conn.wait_event("prompt_queued").await;
        assert_eq!(queued["control_id"], id);
        assert_eq!(queued["prompt"][0]["text"], text);
    }
    std::fs::write(worktree.join("turn1.done"), "").unwrap();
    // 第一個回合的最後回覆，接著是兩筆 prompt_submitted（各自的 control_id），中間沒有進 Gate。
    conn.wait_event("final_message").await;
    let first = conn.wait_event("prompt_submitted").await;
    let second = conn.wait_event("prompt_submitted").await;
    assert_eq!(first["control_id"], "q1");
    assert_eq!(first["source"], "user");
    assert_eq!(second["control_id"], "q2");
    let echoed = reply(&conn.wait_event("final_message").await);
    let (a, b) = (
        echoed.find("text:第一則").expect(&echoed),
        echoed.find("text:第二則").expect(&echoed),
    );
    assert!(a < b, "依序合併：{echoed}");
    conn.wait_status("awaiting_gate").await;
    let gates: Vec<_> = events(&conn, "status_changed")
        .into_iter()
        .filter(|v| v["status"] == "awaiting_gate")
        .collect();
    assert_eq!(gates.len(), 1, "排隊的訊息送出前不進 Gate");
    assert!(
        events(&conn, "run_diff").len() == 1,
        "只有最後進 Review Gate 時送一次 diff"
    );
    // 第一個 prompt 是派工的人送的，沒有 control id。
    let all = events(&conn, "prompt_submitted");
    assert!(
        all[0].get("control_id").is_none_or(Value::is_null),
        "{}",
        all[0]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn 排隊後收回_不會送出() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("queue.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "開始").await;
    let worktree = first_turn_started(&mut conn).await;

    let queued = control(&mut conn, "q1", prompt("不要送出", None)).await;
    assert_eq!(result_outcome(&queued), "applied");
    let withdraw = RunControlAction::WithdrawPrompt {
        prompt_control_id: "q1".into(),
    };
    let result = control(&mut conn, "w1", withdraw.clone()).await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
    let withdrawn = conn.wait_event("prompt_withdrawn").await;
    assert_eq!(withdrawn["control_id"], "q1");
    let again = control(&mut conn, "w2", withdraw).await;
    assert_eq!(again["reason"], "invalid_state", "已經不在佇列中");

    std::fs::write(worktree.join("turn1.done"), "").unwrap();
    conn.wait_status("awaiting_gate").await;
    assert_eq!(
        events(&conn, "prompt_submitted").len(),
        1,
        "只有第一個 prompt：{:#?}",
        conn.event_summary()
    );
    // Gate 等待中佇列一定是空的。
    let late = control(
        &mut conn,
        "w3",
        RunControlAction::WithdrawPrompt {
            prompt_control_id: "q1".into(),
        },
    )
    .await;
    assert_eq!(late["reason"], "invalid_state");
}

#[tokio::test(flavor = "multi_thread")]
async fn 中斷並傳送_回合停下後立即送出() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("queue.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "開始").await;
    first_turn_started(&mut conn).await;

    let queued = control(&mut conn, "q1", prompt("先排隊", None)).await;
    assert_eq!(result_outcome(&queued), "applied");
    let interrupt = control(
        &mut conn,
        "i1",
        prompt("停下來改做這個", Some(PromptDelivery::Interrupt)),
    )
    .await;
    assert_eq!(result_outcome(&interrupt), "applied", "{interrupt}");
    // 不必建立 turn1.done：回合被中斷，接著送出佇列（已排隊的在前）。
    let first = conn.wait_event("prompt_submitted").await;
    let second = conn.wait_event("prompt_submitted").await;
    assert_eq!(first["control_id"], "q1");
    assert_eq!(second["control_id"], "i1");
    let echoed = reply(&conn.wait_event("final_message").await);
    assert!(echoed.contains("text:停下來改做這個"), "{echoed}");
    conn.wait_status("awaiting_gate").await;
    assert!(
        !events(&conn, "status_changed")
            .iter()
            .any(|v| v["status"] == "canceled"),
        "中斷不是中止：{:#?}",
        conn.event_summary()
    );
    assert_eq!(
        events(&conn, "prompt_queued").len(),
        1,
        "中斷的訊息馬上送出，不送 prompt_queued"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn 等待權限回覆時排隊_權限回覆帶_control_id() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("queue-permission.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env
        .dispatch_with("r1", "fake", "開始", |o| {
            o.permission_policy = PermissionPolicy::Manual;
        })
        .await;
    let request = conn.wait_event("permission_request").await;
    conn.wait_status("awaiting_permission").await;
    let queued = control(&mut conn, "q1", prompt("寫完之後看一下", None)).await;
    assert_eq!(result_outcome(&queued), "applied", "{queued}");
    conn.wait_event("prompt_queued").await;
    answer(&mut conn, "allow", &request, "allow_once").await;
    let resolved = conn.wait_event("permission_resolved").await;
    assert_eq!(
        resolved["control_id"], "allow",
        "回覆的人由這個 control id 對應"
    );

    let submitted = conn.wait_event("prompt_submitted").await;
    assert_eq!(submitted["control_id"], "q1");
    let echoed = reply(&conn.wait_event("final_message").await);
    assert!(echoed.contains("text:寫完之後看一下"), "{echoed}");
    conn.wait_status("awaiting_gate").await;
}
