//! 手動測試用：扮演最小的 Server，派一個小 Task 給連上來的 Runner，印出 Event 摘要。
//!
//! ```sh
//! # 終端機 1：Server（預設 port 4101，A 軌的範圍）
//! cargo run -p orbis-runner --example dev_dispatch -- --repo <本機 git repo 路徑> --agent claude-code
//! # 終端機 2：Runner
//! cargo run -p orbis-runner -- --server http://127.0.0.1:4101 --pairing-token dev --home <暫存目錄>
//! ```
//!
//! 流程：Dispatch → 自動以 allow_once 回覆權限請求（扮演測試者）→ 第一次 Review Gate 退回並送出
//! `--followup` → 第二次核准 → push_branch → completed。Event 摘要寫到 `--summary`；`--summary-json`
//! 另外寫一份結構化的結果（煙霧測試腳本 `scripts/smoke-agents.ps1` 用），Run 沒有 completed 時以非 0 結束。
//!
//! Agent 呼叫 Orbis MCP 的 `delegate` 時，也扮演 Server 建立 Child Run 派回同一台 Runner；
//! `wait_run`、`get_run`、`list_runs`、`merge_child` 依 Child Run 的 Event 回覆，其他工具回錯誤。

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use orbis_protocol::PROTOCOL_VERSION;
use orbis_protocol::connection::HelloAck;
use orbis_protocol::control::{RunControl, RunControlAction};
use orbis_protocol::dispatch::{DispatchDelegation, DispatchOffer, DispatchRepo, DispatchTask};
use orbis_protocol::enums::{
    DelegationMode, GateDecision, GateKind, PermissionPolicy, RunOrigin, RunStatus,
};
use orbis_protocol::event::{ContentBlock, EventAck};
use orbis_protocol::frame::ServerToRunner;
use orbis_protocol::tool::{
    ChildRunSummary, OrbisToolErrorCode, OrbisToolOutput, OrbisToolResult, ToolResultFrame,
};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Parser)]
struct Args {
    /// 監聽的 port。
    #[arg(long, default_value_t = 4101)]
    port: u16,
    /// Repo 的 clone URL 或本機路徑（Runner 會從這裡 clone）。
    #[arg(long)]
    repo: String,
    #[arg(long, default_value = "claude-code")]
    agent: String,
    #[arg(long, default_value = "ORB-1")]
    task_key: String,
    #[arg(long, default_value = "新增 hello.txt")]
    title: String,
    #[arg(
        long,
        default_value = "請在 Repo 根目錄新增 hello.txt，內容是一行 `hello from orbis`。完成後執行 `git status` 確認變更，然後簡短回報。"
    )]
    prompt: String,
    #[arg(
        long,
        default_value = "請把 hello.txt 的內容改成 `hello again from orbis`，其他不要動。"
    )]
    followup: String,
    /// Event 摘要的輸出檔。
    #[arg(long, default_value = "dev-dispatch-summary.md")]
    summary: PathBuf,
    /// 結構化結果（JSON）的輸出檔：outcome、push 的 commit、最後的錯誤、耗時。
    #[arg(long)]
    summary_json: Option<PathBuf>,
    /// 整個流程的時間上限（秒），超過就結束並記為 timeout。
    #[arg(long, default_value_t = 1800)]
    timeout_secs: u64,
}

/// `--summary-json` 的內容。
#[derive(Debug, serde::Serialize)]
struct Outcome {
    agent: String,
    run_id: String,
    /// completed、failed、canceled、push_failed、timeout、disconnected。
    outcome: String,
    pushed_branch: Option<String>,
    pushed_commit: Option<String>,
    last_error: Option<String>,
    duration_secs: u64,
    events: usize,
}

/// 一個 Child Run 的狀態（扮演 Server 回覆 `wait_run` 等工具）。
struct Child {
    dispatch_id: String,
    agent: String,
    model: Option<String>,
    mode: DelegationMode,
    branch: Option<String>,
    status: RunStatus,
    final_message: Option<String>,
    /// 等它終止的 `wait_run`：(call_id, 呼叫的 Run)。
    waiting: Vec<(String, String)>,
}

impl Child {
    fn summary(&self, run_id: &str) -> ChildRunSummary {
        ChildRunSummary {
            run_id: run_id.into(),
            agent: self.agent.clone(),
            model: self.model.clone(),
            mode: self.mode,
            status: self.status,
            branch: self.branch.clone(),
            final_message: self.final_message.clone(),
            pending_question: None,
            usage: None,
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let listener = TcpListener::bind(("127.0.0.1", args.port)).await?;
    eprintln!("等 Runner 連到 http://127.0.0.1:{} …", args.port);
    let (stream, _) = listener.accept().await?;
    let mut ws = tokio_tungstenite::accept_async(stream).await?;
    let mut summary: Vec<String> = Vec::new();

    macro_rules! send {
        ($frame:expr) => {
            ws.send(Message::text(serde_json::to_string(&$frame)?))
                .await?
        };
    }

    let hello = recv(&mut ws).await?;
    eprintln!("hello：{}", hello["runner"]);
    send!(ServerToRunner::HelloAck(HelloAck {
        protocol_version: PROTOCOL_VERSION,
        runner_id: "dev-runner".into(),
        runner_token: Some("dev-runner-token".into()),
        heartbeat_interval_ms: 15_000,
        resume: Vec::new(),
        // dev_dispatch 扮演的是派給自己電腦的 Server，Runner 是 Local Runner。
        runner_kind: Some(orbis_protocol::enums::RunnerKind::Local),
    }));
    let run_id = format!("dev-{}", std::process::id());
    let dispatch_id = format!("{run_id}-d1");
    let default_branch = "main".to_owned();
    let branch = format!(
        "{}{}-hello",
        orbis_protocol::names::BRANCH_PREFIX,
        args.task_key
    );
    let offer = |run_id: &str, dispatch_id: &str, agent: &str, prompt: &str| DispatchOffer {
        dispatch_id: dispatch_id.into(),
        run_id: run_id.into(),
        expires_at: "2999-01-01T00:00:00.000Z".into(),
        task: DispatchTask {
            task_id: "dev-task".into(),
            task_key: args.task_key.clone(),
            title: args.title.clone(),
        },
        run_seq: 1,
        repo: DispatchRepo::Github {
            name: "dev-repo".into(),
            clone_url: args.repo.clone(),
            default_branch: default_branch.clone(),
            base_ref: format!("origin/{default_branch}"),
        },
        branch: Some(branch.clone()),
        agent: agent.to_owned(),
        model: None,
        permission_policy: PermissionPolicy::Auto,
        prompt: vec![ContentBlock::Text {
            text: prompt.to_owned(),
        }],
        plan_gate: false,
        delegation: None,
        last_event_seq: 0,
        acceptance_criteria: None,
        credential: None,
        origin: None,
        consult_of_run_id: None,
        continuation: None,
        prompt_source: None,
        effort: None,
    };
    send!(ServerToRunner::DispatchOffer(Box::new(offer(
        &run_id,
        &dispatch_id,
        &args.agent,
        &args.prompt
    ))));

    let mut children: HashMap<String, Child> = HashMap::new();
    let mut reviews = 0;
    let mut controls = 0;
    let mut next_control = |run: &str, dispatch: &str, action: RunControlAction| {
        controls += 1;
        ServerToRunner::RunControl(RunControl {
            control_id: format!("c{controls}").into(),
            run_id: run.into(),
            dispatch_id: dispatch.into(),
            action,
        })
    };
    let started = std::time::Instant::now();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(args.timeout_secs);
    let mut outcome = Outcome {
        agent: args.agent.clone(),
        run_id: run_id.clone(),
        outcome: "disconnected".into(),
        pushed_branch: None,
        pushed_commit: None,
        last_error: None,
        duration_secs: 0,
        events: 0,
    };
    loop {
        let frame = match tokio::time::timeout_at(deadline, recv(&mut ws)).await {
            Ok(Ok(frame)) => frame,
            Ok(Err(e)) => {
                outcome.last_error = Some(format!("{e:#}"));
                summary.push(format!("  → 連線中斷：{e:#}"));
                break;
            }
            Err(_) => {
                outcome.outcome = "timeout".into();
                summary.push(format!("  → 超過 {} 秒沒有結束，逾時", args.timeout_secs));
                break;
            }
        };
        let ty = frame["type"].as_str().unwrap_or_default().to_owned();
        match ty.as_str() {
            "heartbeat" => continue,
            "event" => {
                let from = frame["run_id"].as_str().unwrap_or_default().to_owned();
                let primary = from == run_id;
                if primary {
                    outcome.events += 1;
                    if frame["kind"] == "error" {
                        outcome.last_error = frame["message"].as_str().map(|m| short(m, 500));
                    }
                }
                let line = format!(
                    "{}{}",
                    if primary { "" } else { "  [child] " },
                    describe(&frame)
                );
                eprintln!("{line}");
                summary.push(line);
                send!(ServerToRunner::EventAck(EventAck {
                    run_id: from.as_str().into(),
                    seq: frame["seq"].as_u64().unwrap_or(0),
                }));
                let from_dispatch = if primary {
                    dispatch_id.clone()
                } else {
                    children
                        .get(&from)
                        .map(|c| c.dispatch_id.clone())
                        .unwrap_or_default()
                };
                match frame["kind"].as_str() {
                    Some("permission_request") => {
                        let request_id = frame["request_id"].as_str().unwrap_or_default();
                        let option = frame["options"]
                            .as_array()
                            .and_then(|o| o.iter().find(|o| o["kind"] == "allow_once"))
                            .and_then(|o| o["option_id"].as_str())
                            .unwrap_or("allow_once")
                            .to_owned();
                        summary.push(format!("  → 測試者回覆 {option}"));
                        send!(next_control(
                            &from,
                            &from_dispatch,
                            RunControlAction::PermissionResponse {
                                request_id: request_id.into(),
                                option_id: option,
                            }
                        ));
                    }
                    Some("final_message") if !primary => {
                        if let Some(child) = children.get_mut(&from) {
                            child.final_message = frame["text"]["text"].as_str().map(str::to_owned);
                        }
                    }
                    Some("status_changed") if !primary => {
                        let status: Option<RunStatus> =
                            serde_json::from_value(frame["status"].clone()).ok();
                        if let (Some(child), Some(status)) = (children.get_mut(&from), status) {
                            child.status = status;
                            if status.is_terminal() {
                                let output = OrbisToolOutput::WaitRun(child.summary(&from));
                                for (call_id, caller) in std::mem::take(&mut child.waiting) {
                                    send!(tool_result(&call_id, &caller, ok(output.clone())));
                                }
                            }
                        }
                    }
                    Some("status_changed") if frame["status"] == "awaiting_gate" => {
                        reviews += 1;
                        if reviews == 1 {
                            summary.push(format!("  → Review Gate 退回：{}", args.followup));
                            send!(next_control(
                                &run_id,
                                &dispatch_id,
                                RunControlAction::GateResult {
                                    gate: GateKind::Review,
                                    decision: GateDecision::Rejected,
                                }
                            ));
                            send!(next_control(
                                &run_id,
                                &dispatch_id,
                                RunControlAction::Prompt {
                                    prompt: vec![ContentBlock::Text {
                                        text: args.followup.clone(),
                                    }],
                                    source: None,
                                    delivery: None,
                                }
                            ));
                        } else {
                            summary.push("  → Review Gate 核准、push_branch".into());
                            send!(next_control(
                                &run_id,
                                &dispatch_id,
                                RunControlAction::GateResult {
                                    gate: GateKind::Review,
                                    decision: GateDecision::Approved,
                                }
                            ));
                            send!(next_control(
                                &run_id,
                                &dispatch_id,
                                RunControlAction::PushBranch
                            ));
                        }
                    }
                    Some("status_changed")
                        if matches!(
                            frame["status"].as_str(),
                            Some("completed" | "failed" | "canceled")
                        ) =>
                    {
                        outcome.outcome = frame["status"].as_str().unwrap_or_default().into();
                        if let Some(message) = frame["message"].as_str()
                            && frame["status"] != "completed"
                        {
                            outcome.last_error = Some(short(message, 500));
                        }
                        break;
                    }
                    _ => {}
                }
            }
            "tool_call" => {
                let call_id = frame["call_id"].as_str().unwrap_or_default().to_owned();
                let caller = frame["run_id"].as_str().unwrap_or_default().to_owned();
                let call = &frame["call"];
                let tool = call["tool"].as_str().unwrap_or_default();
                let line = format!("tool_call {tool}：{}", short(&call.to_string(), 300));
                eprintln!("{line}");
                summary.push(line);
                match tool {
                    "delegate" => {
                        let mode: DelegationMode = serde_json::from_value(call["mode"].clone())
                            .unwrap_or(DelegationMode::Consult);
                        let child_id = format!("{caller}-c{}", children.len() + 1);
                        let child_dispatch = format!("{child_id}-d1");
                        let agent = call["agent"].as_str().unwrap_or_default().to_owned();
                        let mut o = offer(
                            &child_id,
                            &child_dispatch,
                            &agent,
                            call["prompt"].as_str().unwrap_or_default(),
                        );
                        o.run_seq = 10 + children.len() as u32;
                        o.model = call["model"].as_str().map(str::to_owned);
                        o.origin = Some(RunOrigin::Delegation);
                        o.branch = match mode {
                            DelegationMode::Consult => None,
                            DelegationMode::Branch => {
                                Some(format!("{branch}--c{}", children.len() + 1))
                            }
                        };
                        o.delegation = Some(DispatchDelegation {
                            parent_run_id: caller.as_str().into(),
                            mode,
                            depth: Some(1),
                            child_seq: Some(children.len() as u32 + 1),
                        });
                        let child_branch = o.branch.clone();
                        children.insert(
                            child_id.clone(),
                            Child {
                                dispatch_id: child_dispatch,
                                agent,
                                model: o.model.clone(),
                                mode,
                                branch: child_branch.clone(),
                                status: RunStatus::Queued,
                                final_message: None,
                                waiting: Vec::new(),
                            },
                        );
                        summary.push(format!("  → 建立 Child Run {child_id}（{mode:?}）"));
                        send!(tool_result(
                            &call_id,
                            &caller,
                            ok(OrbisToolOutput::Delegate {
                                child_run_id: child_id.as_str().into(),
                                branch: child_branch,
                            })
                        ));
                        send!(ServerToRunner::DispatchOffer(Box::new(o)));
                    }
                    "wait_run" | "get_run" | "merge_child" => {
                        let target = call["run_id"].as_str().unwrap_or_default();
                        match children.get_mut(target) {
                            None => send!(tool_result(
                                &call_id,
                                &caller,
                                error(OrbisToolErrorCode::NotFound, "沒有這個 Child Run")
                            )),
                            Some(child) => match tool {
                                "wait_run" if !child.status.is_terminal() => {
                                    child.waiting.push((call_id, caller));
                                }
                                "merge_child" => send!(tool_result(
                                    &call_id,
                                    &caller,
                                    match &child.branch {
                                        Some(branch) => ok(OrbisToolOutput::MergeChild {
                                            branch: branch.clone(),
                                            head_commit: None,
                                        }),
                                        None => error(
                                            OrbisToolErrorCode::InvalidState,
                                            "consult 模式沒有分支"
                                        ),
                                    }
                                )),
                                "wait_run" => send!(tool_result(
                                    &call_id,
                                    &caller,
                                    ok(OrbisToolOutput::WaitRun(child.summary(target)))
                                )),
                                _ => send!(tool_result(
                                    &call_id,
                                    &caller,
                                    ok(OrbisToolOutput::GetRun(child.summary(target)))
                                )),
                            },
                        }
                    }
                    "list_runs" => {
                        let runs = children
                            .iter()
                            .map(|(id, child)| child.summary(id))
                            .collect();
                        send!(tool_result(
                            &call_id,
                            &caller,
                            ok(OrbisToolOutput::ListRuns { runs })
                        ));
                    }
                    _ => send!(tool_result(
                        &call_id,
                        &caller,
                        error(
                            OrbisToolErrorCode::InvalidState,
                            "dev_dispatch 不支援這個工具"
                        )
                    )),
                }
            }
            "run_control_result" => {
                let line = format!(
                    "run_control_result {} {} {}",
                    frame["control_id"].as_str().unwrap_or_default(),
                    frame["outcome"].as_str().unwrap_or_default(),
                    [
                        &frame["branch"],
                        &frame["commit_sha"],
                        &frame["reason"],
                        &frame["message"]
                    ]
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
                );
                eprintln!("{line}");
                summary.push(line);
                if let Some(sha) = frame["commit_sha"].as_str() {
                    outcome.pushed_commit = Some(sha.to_owned());
                    outcome.pushed_branch = frame["branch"].as_str().map(str::to_owned);
                }
                // push 失敗時 Run 會一直等下一個 push_branch：結束，讓測試者看摘要。
                if reviews >= 2 && frame["outcome"] == "rejected" {
                    outcome.outcome = "push_failed".into();
                    outcome.last_error = frame["message"].as_str().map(|m| short(m, 500));
                    summary.push("  → push_branch 失敗，結束".into());
                    break;
                }
            }
            other => {
                let line = format!("{other}：{}", short(&frame.to_string(), 300));
                eprintln!("{line}");
                summary.push(line);
            }
        }
    }
    outcome.duration_secs = started.elapsed().as_secs();
    std::fs::write(&args.summary, summary.join("\n") + "\n")?;
    eprintln!("Event 摘要寫到 {}", args.summary.display());
    if let Some(path) = &args.summary_json {
        std::fs::write(path, serde_json::to_string_pretty(&outcome)?)?;
        eprintln!("結構化結果寫到 {}", path.display());
    }
    if outcome.outcome != "completed" {
        anyhow::bail!(
            "Run 以 {} 結束{}",
            outcome.outcome,
            outcome
                .last_error
                .as_deref()
                .map(|e| format!("：{e}"))
                .unwrap_or_default()
        );
    }
    Ok(())
}

fn ok(output: OrbisToolOutput) -> OrbisToolResult {
    OrbisToolResult::Ok {
        output: Box::new(output),
    }
}

fn error(code: OrbisToolErrorCode, message: &str) -> OrbisToolResult {
    OrbisToolResult::Error {
        code,
        message: message.to_owned(),
    }
}

fn tool_result(call_id: &str, run_id: &str, result: OrbisToolResult) -> ServerToRunner {
    ServerToRunner::ToolResult(ToolResultFrame {
        call_id: call_id.into(),
        run_id: run_id.into(),
        result,
    })
}

async fn recv(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) -> anyhow::Result<Value> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(text))) => return Ok(serde_json::from_str(&text)?),
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(e.into()),
            None => anyhow::bail!("Runner 關閉了連線"),
        }
    }
}

fn short(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out.replace('\n', "⏎")
}

/// 一筆 Event 的一行摘要。
fn describe(e: &Value) -> String {
    let seq = e["seq"].as_u64().unwrap_or(0);
    let kind = e["kind"].as_str().unwrap_or("?");
    let detail = match kind {
        "status_changed" => format!(
            "{} {}{}",
            e["status"].as_str().unwrap_or_default(),
            e["gate"].as_str().unwrap_or_default(),
            e["message"]
                .as_str()
                .map(|m| format!("（{}）", short(m, 120)))
                .unwrap_or_default()
        ),
        "message_chunk" => short(e["content"]["text"].as_str().unwrap_or_default(), 120),
        "thought_chunk" => short(e["text"].as_str().unwrap_or_default(), 80),
        "tool_call" => format!(
            "{} {} {} {}",
            e["tool_call_id"].as_str().unwrap_or_default(),
            e["tool_kind"].as_str().unwrap_or("-"),
            e["status"].as_str().unwrap_or("-"),
            short(e["title"].as_str().unwrap_or_default(), 100)
        ),
        "permission_request" => format!(
            "{} {}",
            e["purpose"].as_str().unwrap_or_default(),
            short(e["title"].as_str().unwrap_or_default(), 160)
        ),
        "permission_resolved" => e["selected_option_id"].to_string(),
        "worktree_ready" => format!(
            "{} {} {}",
            e["worktree_path"].as_str().unwrap_or_default(),
            e["branch"].as_str().unwrap_or_default(),
            e["base_commit"].as_str().unwrap_or_default()
        ),
        "run_diff" => e["files"]
            .as_array()
            .map(|f| {
                f.iter()
                    .map(|f| {
                        format!(
                            "{} {}",
                            f["change"].as_str().unwrap_or_default(),
                            f["path"].as_str().unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("、")
            })
            .unwrap_or_default(),
        "usage" => format!(
            "context {}/{} cost {}",
            e["context_used_tokens"], e["context_window_tokens"], e["cost"]
        ),
        "error" => format!(
            "{} {}",
            e["code"],
            short(e["message"].as_str().unwrap_or_default(), 300)
        ),
        "final_message" => short(e["text"]["text"].as_str().unwrap_or_default(), 200),
        _ => short(&e.to_string(), 160),
    };
    format!("{seq:>4} {kind} {detail}")
}
