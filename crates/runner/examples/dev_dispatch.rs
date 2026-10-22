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
//! `--followup` → 第二次核准 → push_branch → completed。Event 摘要寫到 `--summary`。

use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use orbis_protocol::PROTOCOL_VERSION;
use orbis_protocol::connection::HelloAck;
use orbis_protocol::control::{RunControl, RunControlAction};
use orbis_protocol::dispatch::{DispatchOffer, DispatchRepo, DispatchTask};
use orbis_protocol::enums::{GateDecision, GateKind, PermissionPolicy};
use orbis_protocol::event::{ContentBlock, EventAck};
use orbis_protocol::frame::ServerToRunner;
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
    }));
    let run_id = format!("dev-{}", std::process::id());
    let dispatch_id = format!("{run_id}-d1");
    let default_branch = "main".to_owned();
    send!(ServerToRunner::DispatchOffer(Box::new(DispatchOffer {
        dispatch_id: dispatch_id.as_str().into(),
        run_id: run_id.as_str().into(),
        expires_at: "2999-01-01T00:00:00.000Z".into(),
        task: DispatchTask {
            task_id: "dev-task".into(),
            task_key: args.task_key.clone(),
            title: args.title.clone(),
        },
        run_seq: 1,
        repo: DispatchRepo {
            name: "dev-repo".into(),
            clone_url: args.repo.clone(),
            default_branch: default_branch.clone(),
            base_ref: format!("origin/{default_branch}"),
        },
        branch: Some(format!(
            "{}{}-hello",
            orbis_protocol::names::BRANCH_PREFIX,
            args.task_key
        )),
        agent: args.agent.clone(),
        model: None,
        permission_policy: PermissionPolicy::Auto,
        prompt: vec![ContentBlock::Text {
            text: args.prompt.clone(),
        }],
        plan_gate: false,
        delegation: None,
        last_event_seq: 0,
    })));

    let mut reviews = 0;
    let mut controls = 0;
    let mut next_control = |action: RunControlAction| {
        controls += 1;
        ServerToRunner::RunControl(RunControl {
            control_id: format!("c{controls}").into(),
            run_id: run_id.as_str().into(),
            dispatch_id: dispatch_id.as_str().into(),
            action,
        })
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
    loop {
        let frame = tokio::time::timeout_at(deadline, recv(&mut ws)).await??;
        let ty = frame["type"].as_str().unwrap_or_default().to_owned();
        match ty.as_str() {
            "heartbeat" => continue,
            "event" => {
                let line = describe(&frame);
                eprintln!("{line}");
                summary.push(line);
                send!(ServerToRunner::EventAck(EventAck {
                    run_id: run_id.as_str().into(),
                    seq: frame["seq"].as_u64().unwrap_or(0),
                }));
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
                        send!(next_control(RunControlAction::PermissionResponse {
                            request_id: request_id.into(),
                            option_id: option,
                        }));
                    }
                    Some("status_changed") if frame["status"] == "awaiting_gate" => {
                        reviews += 1;
                        if reviews == 1 {
                            summary.push(format!("  → Review Gate 退回：{}", args.followup));
                            send!(next_control(RunControlAction::GateResult {
                                gate: GateKind::Review,
                                decision: GateDecision::Rejected,
                            }));
                            send!(next_control(RunControlAction::Prompt {
                                prompt: vec![ContentBlock::Text {
                                    text: args.followup.clone(),
                                }],
                            }));
                        } else {
                            summary.push("  → Review Gate 核准、push_branch".into());
                            send!(next_control(RunControlAction::GateResult {
                                gate: GateKind::Review,
                                decision: GateDecision::Approved,
                            }));
                            send!(next_control(RunControlAction::PushBranch));
                        }
                    }
                    Some("status_changed")
                        if matches!(
                            frame["status"].as_str(),
                            Some("completed" | "failed" | "canceled")
                        ) =>
                    {
                        break;
                    }
                    _ => {}
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
            }
            other => {
                let line = format!("{other}：{}", short(&frame.to_string(), 300));
                eprintln!("{line}");
                summary.push(line);
            }
        }
    }
    std::fs::write(&args.summary, summary.join("\n") + "\n")?;
    eprintln!("Event 摘要寫到 {}", args.summary.display());
    Ok(())
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
        _ => short(&e.to_string(), 160),
    };
    format!("{seq:>4} {kind} {detail}")
}
