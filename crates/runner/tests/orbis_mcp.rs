//! Orbis MCP server（ARCHITECTURE §9、issue #39）：每個 session 注入 Orbis MCP server，Agent 的
//! 工具呼叫經由 Runner 以 `tool_call` 轉給 Server，`tool_result` 再交回 Agent；斷線重連後以同一個
//! `call_id` 重送還沒有結果的呼叫。

mod support;

use orbis_protocol::connection::RunResume;
use orbis_protocol::frame::ServerToRunner;
use orbis_protocol::tool::{OrbisToolErrorCode, OrbisToolOutput, OrbisToolResult, ToolResultFrame};
use serde_json::Value;
use support::flow::Env;
use support::runner_script;
use support::server::{RunnerSide, fake_agent_toml};

async fn wait_tool_call(conn: &mut RunnerSide) -> Value {
    conn.wait_for("tool_call", |v| v["type"] == "tool_call")
        .await
}

async fn reply(conn: &mut RunnerSide, call: &Value, result: OrbisToolResult) {
    conn.send(&ServerToRunner::ToolResult(ToolResultFrame {
        call_id: call["call_id"].as_str().unwrap().into(),
        run_id: call["run_id"].as_str().unwrap().into(),
        result,
    }))
    .await;
}

/// Agent 呼叫 `update_task_note` → `tool_call` 送到 Server → `tool_result` 交回 Agent。
#[tokio::test(flavor = "multi_thread")]
async fn 工具呼叫經由_runner_轉給_server_結果交回_agent() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("mcp-note.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    let call = wait_tool_call(&mut conn).await;
    assert_eq!(call["run_id"], "r1");
    assert_eq!(call["dispatch_id"], "d-r1");
    assert_eq!(call["call"]["tool"], "update_task_note");
    assert_eq!(call["call"]["note"], "完成第一步");
    reply(
        &mut conn,
        &call,
        OrbisToolResult::Ok {
            output: Box::new(OrbisToolOutput::UpdateTaskNote {
                note_id: "note-1".into(),
            }),
        },
    )
    .await;
    let done = conn
        .wait_for("工具呼叫的結果", |v| {
            v["kind"] == "tool_call" && v["tool_call_id"] == "note" && v["status"] == "completed"
        })
        .await;
    assert!(done.to_string().contains("note-1"), "{done}");
    conn.wait_status("awaiting_gate").await;
}

/// Server 回錯誤：Agent 收到失敗的工具呼叫（含錯誤代碼）。
#[tokio::test(flavor = "multi_thread")]
async fn server_回錯誤時_agent_收到失敗() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("mcp-note.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    let call = wait_tool_call(&mut conn).await;
    reply(
        &mut conn,
        &call,
        OrbisToolResult::Error {
            code: OrbisToolErrorCode::NotFound,
            message: "找不到 Task".into(),
        },
    )
    .await;
    let failed = conn
        .wait_for("失敗的工具呼叫", |v| {
            v["kind"] == "tool_call" && v["tool_call_id"] == "note" && v["status"] == "failed"
        })
        .await;
    assert!(failed.to_string().contains("not_found"), "{failed}");
}

/// 斷線重連：還沒有結果的呼叫以同一個 `call_id` 重送。
#[tokio::test(flavor = "multi_thread")]
async fn 斷線重連後以同一個_call_id_重送() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("mcp-note.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    let first = wait_tool_call(&mut conn).await;
    let last_seq = conn
        .events
        .iter()
        .filter_map(|e| e["seq"].as_u64())
        .max()
        .unwrap_or(0);
    conn.ws.close(None).await.ok();
    drop(conn);

    let mut conn = env.server.accept().await;
    conn.handshake(
        vec![RunResume {
            run_id: "r1".into(),
            last_seq,
        }],
        None,
    )
    .await;
    let again = wait_tool_call(&mut conn).await;
    assert_eq!(again["call_id"], first["call_id"]);
    reply(
        &mut conn,
        &again,
        OrbisToolResult::Ok {
            output: Box::new(OrbisToolOutput::UpdateTaskNote {
                note_id: "note-1".into(),
            }),
        },
    )
    .await;
    conn.wait_status("awaiting_gate").await;
}
