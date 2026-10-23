//! Verification 的 `agent`／`browser` 判定（ARCHITECTURE §5.1、issue #32）：被驗證的 Run 以
//! `delegate`（`purpose = verification`、`consult`）請 Server 建立判定用的 Child Run，取出它以
//! `report_verdict` 回報的判定；`browser` 類型另外注入瀏覽器 MCP server，截圖成為證據。

mod support;

use std::path::Path;

use orbis_protocol::control::RunControlAction;
use orbis_protocol::dispatch::DispatchDelegation;
use orbis_protocol::enums::{DelegationMode, RunOrigin, RunStatus};
use orbis_protocol::frame::ServerToRunner;
use orbis_protocol::tool::{ChildRunSummary, OrbisToolOutput, OrbisToolResult, ToolResultFrame};
use orbis_protocol::verification::{
    VerificationCriterion, VerificationJudge, VerificationKind, VerificationRequest,
};
use serde_json::Value;
use support::flow::{Env, approve_config, control_r1};
use support::server::{RunnerSide, offer, send_offer};
use support::{cfg, runner_script, toml_string};

/// runner.toml：被驗證的 Run 用 `fake`（新增 verify.txt），判定用 `judge`。`top` 是放在最前面的
/// 頂層設定，`tables` 放在 Agent 設定之後。
fn agents(wt: &Path, judge_script: &str, top: &str, tables: &str) -> String {
    let bin = toml_string(&support::fake_agent_bin().to_string_lossy());
    let script = |name: &str| toml_string(&runner_script(name).to_string_lossy());
    format!(
        "{top}worktree_root = {}\n[agents.fake]\ncommand = {bin}\nargs = [\"--script\", {}]\n[agents.judge]\ncommand = {bin}\nargs = [\"--script\", {}]\n{tables}",
        toml_string(&wt.to_string_lossy()),
        script("verify-pass.yaml"),
        script(judge_script),
    )
}

fn fake_mcp_server_bin() -> std::path::PathBuf {
    support::fake_agent_bin().with_file_name(format!(
        "orbis-fake-mcp-server{}",
        std::env::consts::EXE_SUFFIX
    ))
}

fn criterion(id: &str, kind: VerificationKind, description: &str) -> VerificationCriterion {
    VerificationCriterion {
        criterion_id: id.into(),
        kind,
        description: description.into(),
        command: None,
    }
}

fn verify(criteria: Vec<VerificationCriterion>) -> RunControlAction {
    RunControlAction::Verify(VerificationRequest {
        verification_id: "v1".into(),
        attempt: 1,
        criteria,
        judge: Some(VerificationJudge {
            agent: "judge".into(),
            model: None,
        }),
        context: Vec::new(),
    })
}

/// 等某個 Orbis 工具呼叫（`tool_call` frame）。Child Run 的 Dispatch 回覆與工具呼叫的先後不固定，
/// 先從已經收到的 frame 中找。
async fn tool_call(conn: &mut RunnerSide, tool: &str) -> Value {
    let matches = |v: &Value| v["type"] == "tool_call" && v["call"]["tool"] == tool;
    if let Some(found) = conn.frames().iter().find(|v| matches(v)) {
        return found.clone();
    }
    conn.wait_for(&format!("{tool} 的 tool_call"), matches)
        .await
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

/// Server 依 `delegate` 建立判定用的 Child Run，派回同一台 Runner。
async fn offer_judge(env: &Env, conn: &mut RunnerSide, delegate: &Value) {
    let mut o = offer(
        "j1",
        "d-j1",
        env.remote.dispatch_repo("web"),
        "judge",
        delegate["call"]["prompt"].as_str().unwrap(),
    );
    o.run_seq = 11;
    o.origin = Some(RunOrigin::Verification);
    o.delegation = Some(DispatchDelegation {
        parent_run_id: "r1".into(),
        mode: DelegationMode::Consult,
        depth: Some(1),
        child_seq: Some(1),
    });
    conn.send(&send_offer(o)).await;
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

/// 判定用的 Child Run 結束後回覆父 Run 的 `wait_run`。
async fn finish_judge(conn: &mut RunnerSide) {
    wait_run_status(conn, "j1", "completed").await;
    let wait = tool_call(conn, "wait_run").await;
    assert_eq!(wait["run_id"], "r1", "{wait}");
    assert_eq!(wait["call"]["run_id"], "j1", "{wait}");
    reply_tool(
        conn,
        &wait,
        OrbisToolOutput::WaitRun(ChildRunSummary {
            run_id: "j1".into(),
            agent: "judge".into(),
            model: None,
            mode: DelegationMode::Consult,
            status: RunStatus::Completed,
            branch: None,
            final_message: None,
            pending_question: None,
            usage: None,
        }),
    )
    .await;
}

async fn result_of(conn: &mut RunnerSide, criterion: &str) -> Value {
    let what = format!("{criterion} 的 verification_result");
    conn.wait_for(&what, |v| {
        v["kind"] == "verification_result" && v["criterion_id"] == criterion
    })
    .await
}

/// agent 類型：同一個判定用的 Child Run 一起判定兩條條件；只接受指派給它的條件。
#[tokio::test(flavor = "multi_thread")]
async fn agent_類型由判定用的_child_run_回報判定() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        agents(wt, "judge-agent.yaml", "", "")
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "新增 verify.txt").await;
    conn.wait_status("awaiting_gate").await;
    control_r1(
        &mut conn,
        "c1",
        verify(vec![
            criterion("ac-1", VerificationKind::Agent, "要有 verify.txt"),
            criterion("ac-2", VerificationKind::Agent, "README 要說明用法"),
        ]),
    )
    .await;
    conn.wait_status("verifying").await;

    let delegate = tool_call(&mut conn, "delegate").await;
    let call = &delegate["call"];
    assert_eq!(call["purpose"], "verification", "{delegate}");
    assert_eq!(call["mode"], "consult");
    assert_eq!(call["verification_id"], "v1");
    assert_eq!(call["agent"], "judge");
    let prompt = call["prompt"].as_str().unwrap();
    assert!(
        prompt.contains("ac-1") && prompt.contains("README 要說明用法"),
        "{prompt}"
    );
    reply_tool(
        &mut conn,
        &delegate,
        OrbisToolOutput::Delegate {
            child_run_id: "j1".into(),
            branch: None,
        },
    )
    .await;
    offer_judge(&env, &mut conn, &delegate).await;
    finish_judge(&mut conn).await;

    let first = result_of(&mut conn, "ac-1").await;
    assert_eq!(first["outcome"], "passed", "{first}");
    assert_eq!(first["judged_by_run_id"], "j1");
    assert_eq!(first["summary"], "verify.txt 存在");
    let second = result_of(&mut conn, "ac-2").await;
    assert_eq!(second["outcome"], "failed", "{second}");
    let completed = conn.wait_event("verification_completed").await;
    assert_eq!(completed["outcome"], "failed");
    let back = conn.wait_status("awaiting_gate").await;
    assert_eq!(back["gate"], "review");
    assert!(
        conn.events.iter().any(|e| e["run_id"] == "j1"
            && e["tool_call_id"] == "verdict-other"
            && e["status"] == "failed"),
        "沒有指派的條件不接受判定"
    );
}

/// browser 類型：判定用的 Child Run 注入只能連 Preview 的瀏覽器 MCP server，瀏覽器工具不問人，
/// 截圖成為證據（blob）。
#[tokio::test(flavor = "multi_thread")]
async fn browser_類型注入瀏覽器_mcp_server_並附上截圖() {
    let free = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let server_js = "require(\"http\").createServer((q, s) => s.end(\"hello preview\")).listen(Number(process.env.PORT));\n";
    let config = format!("[preview]\ncommand = {}\n", toml_string("node server.js"));
    let server_js = server_js.replace("PORT", orbis_protocol::names::ENV_PORT);
    let mut env = Env::new(
        &[
            ("README.md", "a\n"),
            ("server.js", &server_js),
            (cfg().as_str(), &config),
        ],
        |wt| {
            agents(
                wt,
                "judge-browser.yaml",
                &format!("port_range = [{free}, {}]\n", free.saturating_add(10)),
                &format!(
                    "[browser_judge]\ncommand = {}\n",
                    toml_string(&fake_mcp_server_bin().to_string_lossy())
                ),
            )
        },
    )
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "新增 verify.txt").await;
    approve_config(&mut conn, "r1").await;
    conn.wait_status("awaiting_gate").await;
    // preview_ready 與 awaiting_gate 的先後不固定。
    let ready = match conn.events.iter().find(|e| e["kind"] == "preview_ready") {
        Some(ready) => ready.clone(),
        None => conn.wait_event("preview_ready").await,
    };
    let port = ready["port"].as_u64().unwrap();
    control_r1(
        &mut conn,
        "c1",
        verify(vec![criterion(
            "ac-3",
            VerificationKind::Browser,
            "首頁顯示 hello preview",
        )]),
    )
    .await;

    let delegate = tool_call(&mut conn, "delegate").await;
    assert!(
        delegate["call"]["prompt"]
            .as_str()
            .unwrap()
            .contains(&format!("http://localhost:{port}/")),
        "{delegate}"
    );
    reply_tool(
        &mut conn,
        &delegate,
        OrbisToolOutput::Delegate {
            child_run_id: "j1".into(),
            branch: None,
        },
    )
    .await;
    offer_judge(&env, &mut conn, &delegate).await;
    finish_judge(&mut conn).await;

    let result = result_of(&mut conn, "ac-3").await;
    assert_eq!(result["outcome"], "passed", "{result}");
    assert_eq!(result["evidence"][0]["type"], "screenshot", "{result}");
    assert_eq!(result["evidence"][0]["image"]["media_type"], "image/png");
    assert_eq!(result["evidence"][0]["caption"], "home.png");
    assert!(
        !conn
            .events
            .iter()
            .any(|e| e["run_id"] == "j1" && e["kind"] == "permission_request"),
        "判定 browser 條件時瀏覽器工具不問人"
    );
    let args = conn
        .events
        .iter()
        .find(|e| {
            e["run_id"] == "j1" && e["tool_call_id"] == "browser-args" && e["status"] == "completed"
        })
        .map(Value::to_string)
        .unwrap_or_default();
    assert!(
        args.contains("--allowed-origins") && args.contains(&format!("http://localhost:{port}")),
        "只允許連到 Preview：{args}"
    );
}
