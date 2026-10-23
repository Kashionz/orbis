//! 端到端：真正的 `orbis-runner` 執行檔 ↔ 扮演 Server 的 WebSocket，Agent 是 Fake Agent，
//! Repo 是真實 git 的 bare remote。

mod support;

use std::path::Path;
use std::time::Duration;

use orbis_fake_agent::agent::CHILD_PID_PREFIX;
use orbis_protocol::connection::RunResume;
use orbis_protocol::control::RunControlAction;
use orbis_protocol::enums::{GateDecision, GateKind, PermissionPolicy};
use orbis_protocol::event::ContentBlock;
use serde_json::Value;
use support::server::{
    FakeServer, RunnerOptions, RunnerSide, fake_agent_toml, offer, parse_result, process_alive,
    result_outcome, send_offer, spawn_runner, write_runner_toml,
};
use support::{Remote, branch, cfg, git, runner_script, script, temp_dir, toml_string};

/// 一次測試的環境：remote、Runner 本機目錄、Server。
struct Env {
    dir: tempfile::TempDir,
    remote: Remote,
    server: FakeServer,
}

impl Env {
    async fn new(files: &[(&str, &str)], runner_toml: impl Fn(&Path) -> String) -> Self {
        let dir = temp_dir("orbis run");
        let remote = Remote::new(files);
        write_runner_toml(
            &dir.path().join("home"),
            &runner_toml(&dir.path().join("wt")),
        );
        Self {
            dir,
            remote,
            server: FakeServer::start().await,
        }
    }

    fn home(&self) -> std::path::PathBuf {
        self.dir.path().join("home")
    }

    fn spawn(&self) -> support::server::RunnerProcess {
        spawn_runner(RunnerOptions::new(&self.server.base_url(), &self.home()))
    }

    /// 連上、完成交握並送出 Dispatch，等到 Runner 接受。
    async fn dispatch(&mut self, run_id: &str, agent: &str, prompt: &str) -> RunnerSide {
        let mut conn = self.server.accept().await;
        conn.handshake(Vec::new(), Some("rt_test")).await;
        self.offer(&mut conn, run_id, agent, prompt, 1).await;
        conn
    }

    async fn offer(
        &self,
        conn: &mut RunnerSide,
        run_id: &str,
        agent: &str,
        prompt: &str,
        run_seq: u32,
    ) {
        let mut o = offer(
            run_id,
            &format!("d-{run_id}"),
            self.remote.dispatch_repo("web"),
            agent,
            prompt,
        );
        o.run_seq = run_seq;
        conn.send(&send_offer(o)).await;
        let reply = conn
            .wait_for("dispatch 回覆", |v| {
                v["type"] == "dispatch_accept" || v["type"] == "dispatch_reject"
            })
            .await;
        assert_eq!(reply["type"], "dispatch_accept", "{reply}");
    }
}

/// 回覆設定檔的信任核准（allow_once）。
async fn approve_config(conn: &mut RunnerSide, run_id: &str) {
    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "config_trust", "{request}");
    let result = conn
        .control(
            run_id,
            &format!("d-{run_id}"),
            "trust",
            RunControlAction::PermissionResponse {
                request_id: request["request_id"].as_str().unwrap().into(),
                option_id: "allow_once".into(),
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied");
}

fn text(body: &Value) -> String {
    body["text"]
        .as_str()
        .unwrap_or_default()
        .replace("\r\n", "\n")
}

fn diff_file<'a>(diff: &'a Value, path: &str) -> &'a Value {
    diff["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == path)
        .unwrap_or_else(|| panic!("diff 中沒有 {path}：{diff}"))
}

/// 完成條件：領取 Dispatch → 建立 Worktree → 權限請求 → 收到回覆 → 產生 diff → 完成
/// → 收到退回的 prompt → 再次完成（同一個 session）→ 核准 → push → completed。
#[tokio::test(flavor = "multi_thread")]
async fn 領取到完成_退回後再次完成並_push() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("review-loop.yaml"))
    })
    .await;
    let mut runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "請新增 feature.txt").await;
    let (run, dispatch) = ("r1", "d-r1");

    conn.wait_status("starting").await;
    let ready = conn.wait_event("worktree_ready").await;
    assert_eq!(ready["branch"], branch("ORB-1-r1"));
    assert_eq!(
        ready["base_commit"],
        git(&env.remote.work, &["rev-parse", "HEAD"])
    );
    let worktree = std::path::PathBuf::from(ready["worktree_path"].as_str().unwrap());
    assert!(worktree.join("README.md").is_file());

    // `make build` 不在 allow_commands 中：問人，Run 暫停。
    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "tool");
    assert_eq!(request["tool_call_id"], "run-build");
    assert!(
        request["title"].as_str().unwrap().contains("make build"),
        "{request}"
    );
    let tool_call_created = conn
        .events
        .iter()
        .any(|e| e["kind"] == "tool_call" && e["tool_call_id"] == "run-build");
    assert!(tool_call_created, "權限請求之前要先送出 tool_call");
    conn.wait_status("awaiting_permission").await;
    let request_id = request["request_id"].as_str().unwrap().to_owned();
    let result = conn
        .control(
            run,
            dispatch,
            "c1",
            RunControlAction::PermissionResponse {
                request_id: request_id.clone().into(),
                option_id: "allow_once".into(),
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
    let resolved = conn.wait_event("permission_resolved").await;
    assert_eq!(resolved["selected_option_id"], "allow_once");

    // 第一回合完成：整份 diff → awaiting_gate(review)。
    let diff = conn.wait_event("run_diff").await;
    let feature = diff_file(&diff, "feature.txt");
    assert_eq!(feature["change"], "added");
    assert_eq!(text(&feature["new"]), "version 1\n");
    let waiting = conn.wait_status("awaiting_gate").await;
    assert_eq!(waiting["gate"], "review");

    // 在 Review Gate 退回，意見以 prompt 送回同一個 session。
    let push_too_early = conn
        .control(run, dispatch, "c0", RunControlAction::PushBranch)
        .await;
    assert_eq!(
        push_too_early["reason"], "invalid_state",
        "核准前不能 push：{push_too_early}"
    );
    let result = conn
        .control(
            run,
            dispatch,
            "c2",
            RunControlAction::GateResult {
                gate: GateKind::Review,
                decision: GateDecision::Rejected,
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied");
    let result = conn
        .control(
            run,
            dispatch,
            "c3",
            RunControlAction::Prompt {
                prompt: vec![ContentBlock::Text {
                    text: "請改成第二版".into(),
                }],
                source: None,
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied");
    conn.wait_status("running").await;
    let diff = conn.wait_event("run_diff").await;
    assert_eq!(text(&diff_file(&diff, "feature.txt")["new"]), "version 2\n");
    conn.wait_status("awaiting_gate").await;

    // 核准 → push → completed。
    let result = conn
        .control(
            run,
            dispatch,
            "c4",
            RunControlAction::GateResult {
                gate: GateKind::Review,
                decision: GateDecision::Approved,
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied");
    let result = conn
        .control(run, dispatch, "c5", RunControlAction::PushBranch)
        .await;
    let parsed = parse_result(&result);
    let orbis_protocol::control::RunControlOutcome::BranchPushed { branch, commit_sha } =
        parsed.outcome
    else {
        panic!(
            "push 應該成功：{result}\nRunner stderr：\n{}",
            runner.stderr()
        );
    };
    assert_eq!(branch, support::branch("ORB-1-r1"));
    assert_eq!(
        env.remote.branch_head(&branch).as_deref(),
        Some(commit_sha.as_str())
    );
    let subject = git(&env.remote.bare, &["log", "-1", "--format=%s", &commit_sha]);
    assert_eq!(subject, "ORB-1: 測試 Task", "預設的自動 commit 訊息");
    conn.wait_status("completed").await;
    conn.assert_contiguous(run, 1);

    // 全部 ack 之後清除本機暫存。
    let last = conn.events.last().unwrap()["seq"].as_u64().unwrap();
    conn.ack(run, last).await;
    let spool = env.home().join("runner").join("spool");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !orbis_runner::outbox::spool_files(&spool).is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "ack 後暫存應該被清除"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(conn);
    let _ = runner.child.kill().await;
}

/// C1 的 M1 完整系統 e2e 使用的劇本 `m1.yaml`：manual 政策下寫檔問人 → 允許 → diff
/// → 退回的 prompt 改成第二版 → 核准 → push 回本機 bare repo（不需要網路）。
/// 和 C1 的設定一樣，以 `[agents.claude-code]` 把內建的 Claude Code 換成 Fake Agent。
#[tokio::test(flavor = "multi_thread")]
async fn m1_劇本在_manual_政策下走完並_push_回本機_bare_repo() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &script("m1.yaml")).replace(
            "[agents.fake]",
            &format!("[agents.{}]", orbis_runner::agent::CLAUDE_CODE),
        )
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    let mut o = offer(
        "r1",
        "d-r1",
        env.remote.dispatch_repo("web"),
        orbis_runner::agent::CLAUDE_CODE,
        "請新增 m1.txt",
    );
    o.permission_policy = PermissionPolicy::Manual;
    conn.send(&send_offer(o)).await;
    let (run, dispatch) = ("r1", "d-r1");

    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "tool");
    assert_eq!(request["tool_call_id"], "write-m1");
    let result = conn
        .control(
            run,
            dispatch,
            "c1",
            RunControlAction::PermissionResponse {
                request_id: request["request_id"].as_str().unwrap().into(),
                option_id: "allow_once".into(),
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
    let diff = conn.wait_event("run_diff").await;
    let file = diff_file(&diff, "m1.txt");
    assert_eq!(file["change"], "added");
    assert_eq!(file["binary"], false);
    assert_eq!(text(&file["new"]), "version 1\n");
    conn.wait_status("awaiting_gate").await;

    for (id, action) in [
        (
            "c2",
            RunControlAction::GateResult {
                gate: GateKind::Review,
                decision: GateDecision::Rejected,
            },
        ),
        (
            "c3",
            RunControlAction::Prompt {
                prompt: vec![ContentBlock::Text {
                    text: "m1.txt 第 1 行：請改成第二版".into(),
                }],
                source: None,
            },
        ),
    ] {
        let result = conn.control(run, dispatch, id, action).await;
        assert_eq!(result_outcome(&result), "applied", "{result}");
    }
    let diff = conn.wait_event("run_diff").await;
    assert_eq!(text(&diff_file(&diff, "m1.txt")["new"]), "version 2\n");
    conn.wait_status("awaiting_gate").await;

    let result = conn
        .control(
            run,
            dispatch,
            "c4",
            RunControlAction::GateResult {
                gate: GateKind::Review,
                decision: GateDecision::Approved,
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied");
    let result = conn
        .control(run, dispatch, "c5", RunControlAction::PushBranch)
        .await;
    let orbis_protocol::control::RunControlOutcome::BranchPushed { branch, commit_sha } =
        parse_result(&result).outcome
    else {
        panic!("push 應該成功：{result}");
    };
    assert_eq!(
        env.remote.branch_head(&branch).as_deref(),
        Some(commit_sha.as_str())
    );
    let pushed = git(&env.remote.bare, &["show", &format!("{commit_sha}:m1.txt")]);
    assert_eq!(pushed.replace("\r\n", "\n").trim_end(), "version 2");
    conn.wait_status("completed").await;
}

/// 完成條件：取消時整個程序樹（含 Agent 開的子程序）都被結束。
#[tokio::test(flavor = "multi_thread")]
async fn 取消時整個程序樹都被結束() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &script("spawn-child.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "開背景程序").await;
    let message = conn
        .wait_for("child pid", |v| {
            v["kind"] == "message_chunk"
                && v["content"]["text"]
                    .as_str()
                    .is_some_and(|t| t.starts_with(CHILD_PID_PREFIX))
        })
        .await;
    let pid: u32 = message["content"]["text"].as_str().unwrap()[CHILD_PID_PREFIX.len()..]
        .parse()
        .unwrap();
    assert!(process_alive(pid), "子程序 {pid} 應該在執行");
    let result = conn
        .control("r1", "d-r1", "c1", RunControlAction::Cancel)
        .await;
    assert_eq!(result_outcome(&result), "applied");
    conn.wait_status("canceled").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while process_alive(pid) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "取消後子程序 {pid} 仍在執行"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // 結束後的 RunControl 一律回覆。
    let late = conn
        .control("r1", "d-r1", "c2", RunControlAction::Cancel)
        .await;
    assert_eq!(late["reason"], "invalid_state");
}

/// 斷線期間 Event 暫存在本機；重新連上後依 `resume` 從 `last_seq + 1` 補送，並改用保存的 Runner token。
#[tokio::test(flavor = "multi_thread")]
async fn 斷線後重新連線並依_seq_補送() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &runner_script("slow.yaml"))
    })
    .await;
    let mut runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "慢慢來").await;
    conn.wait_for("第一段", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "第一段"
    })
    .await;
    // 斷線：Server 只保存到 seq 2。
    conn.ws.close(None).await.ok();
    drop(conn);

    let mut conn = env.server.accept().await;
    let hello = conn
        .handshake(
            vec![RunResume {
                run_id: "r1".into(),
                last_seq: 2,
            }],
            None,
        )
        .await;
    assert_eq!(
        hello["pairing"]["kind"], "runner_token",
        "重新連線要用保存的 Runner token：{hello}"
    );
    assert_eq!(hello["pairing"]["token"], "rt_test");
    conn.wait_status("awaiting_gate").await;
    conn.assert_contiguous("r1", 3);
    let summary = conn.event_summary();
    assert!(
        summary.iter().any(|s| s.contains("message 第二段")),
        "{summary:#?}"
    );
    let _ = runner.child.kill().await;
}

/// 第一次執行設定檔中的腳本要人核准；選「永遠允許」後，同一份內容不必再核准。
#[tokio::test(flavor = "multi_thread")]
async fn 設定檔腳本的信任核准() {
    let config = "[worktree]\nsetup = \"echo setup > setup-ran.txt\"\n";
    let mut env = Env::new(&[(cfg().as_str(), config)], |wt| {
        fake_agent_toml(wt, &runner_script("simple.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "config_trust", "{request}");
    assert!(
        request["title"].as_str().unwrap().contains("setup-ran.txt"),
        "{request}"
    );
    let worktree = conn
        .events
        .iter()
        .find(|e| e["kind"] == "worktree_ready")
        .map(|e| std::path::PathBuf::from(e["worktree_path"].as_str().unwrap()))
        .unwrap();
    assert!(!worktree.join("setup-ran.txt").exists(), "核准前不可以執行");
    let result = conn
        .control(
            "r1",
            "d-r1",
            "c1",
            RunControlAction::PermissionResponse {
                request_id: request["request_id"].as_str().unwrap().into(),
                option_id: "allow_always".into(),
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied");
    let setup = conn
        .wait_for("setup 完成", |v| {
            v["kind"] == "tool_call"
                && v["tool_call_id"] == "orbis-setup"
                && v["status"] == "completed"
        })
        .await;
    assert_eq!(setup["content"][0]["type"], "terminal");
    assert_eq!(setup["content"][0]["exit_code"], 0);
    assert!(worktree.join("setup-ran.txt").is_file());
    conn.wait_status("awaiting_gate").await;

    // 同一份設定內容的第二個 Run：不再問。
    let before = conn.events.len();
    env.offer(&mut conn, "r2", "fake", "再做一次", 2).await;
    conn.wait_for("r2 awaiting_gate", |v| {
        v["run_id"] == "r2" && v["kind"] == "status_changed" && v["status"] == "awaiting_gate"
    })
    .await;
    let asked_again = conn.events[before..]
        .iter()
        .any(|e| e["run_id"] == "r2" && e["kind"] == "permission_request");
    assert!(!asked_again, "永遠允許過的內容不必再核准");
}

/// 拒絕信任核准：Run 以 setup_failed 失敗，不執行腳本。
#[tokio::test(flavor = "multi_thread")]
async fn 拒絕信任核准時_run_失敗() {
    let config = "[worktree]\nsetup = \"echo setup > setup-ran.txt\"\n";
    let mut env = Env::new(&[(cfg().as_str(), config)], |wt| {
        fake_agent_toml(wt, &runner_script("simple.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    let request = conn.wait_event("permission_request").await;
    conn.control(
        "r1",
        "d-r1",
        "c1",
        RunControlAction::PermissionResponse {
            request_id: request["request_id"].as_str().unwrap().into(),
            option_id: "reject_once".into(),
        },
    )
    .await;
    let error = conn.wait_event("error").await;
    assert_eq!(error["code"], "setup_failed");
    assert_eq!(error["fatal"], true);
    conn.wait_status("failed").await;
}

/// `<CONFIG_DIR>/<CONFIG_FILE>` 的 allow_commands 中的指令自動允許，不產生權限請求；commit 訊息格式可以設定。
#[tokio::test(flavor = "multi_thread")]
async fn allow_commands_中的指令自動允許() {
    let config = "[permissions]\nallow_commands = [\"make *\"]\n[git]\ncommit_message = \"feat: {title}（{task_key}）\"\n";
    let mut env = Env::new(&[(cfg().as_str(), config)], |wt| {
        fake_agent_toml(wt, &runner_script("review-loop.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    // allow_commands 會放寬政策，第一次要核准設定檔。
    approve_config(&mut conn, "r1").await;
    conn.wait_status("awaiting_gate").await;
    assert!(
        !conn
            .events
            .iter()
            .any(|e| e["kind"] == "permission_request" && e["purpose"] == "tool"),
        "allow_commands 中的指令不問人：{:#?}",
        conn.event_summary()
    );
    conn.control(
        "r1",
        "d-r1",
        "c1",
        RunControlAction::GateResult {
            gate: GateKind::Review,
            decision: GateDecision::Approved,
        },
    )
    .await;
    let result = conn
        .control("r1", "d-r1", "c2", RunControlAction::PushBranch)
        .await;
    let sha = result["commit_sha"]
        .as_str()
        .unwrap_or_else(|| panic!("{result}"));
    let subject = git(&env.remote.bare, &["log", "-1", "--format=%s", sha]);
    assert_eq!(subject, "feat: 測試 Task（ORB-1）");
}

/// runner.toml：用內建 claude-code profile 的修補與受保護路徑，但啟動指令換成 Fake Agent。
fn claude_code_as_fake(wt: &Path, script: &Path) -> String {
    claude_code_as_fake_with(wt, script, &[])
}

/// 同 [`claude_code_as_fake`]，另外加上 Fake Agent 的參數。
fn claude_code_as_fake_with(wt: &Path, script: &Path, extra: &[String]) -> String {
    let mut args = vec![
        toml_string("--script"),
        toml_string(&script.to_string_lossy()),
    ];
    args.extend(extra.iter().map(|a| toml_string(a)));
    format!(
        "worktree_root = {}\n[agents.claude-code]\ncommand = {}\nargs = [{}]\n",
        toml_string(&wt.to_string_lossy()),
        toml_string(&support::fake_agent_bin().to_string_lossy()),
        args.join(", "),
    )
}

/// Fake Agent 的 session 保存目錄參數（讓重新啟動的 Agent 能接續 session）。
fn agent_state_args(wt: &Path, load_only: bool) -> Vec<String> {
    let dir = wt.parent().unwrap().join("agent-state");
    let mut args = vec!["--state-dir".to_owned(), dir.to_string_lossy().into_owned()];
    if load_only {
        args.push("--no-resume".to_owned());
    }
    args
}

/// 回覆權限請求，確認被接受。
async fn answer(conn: &mut RunnerSide, control_id: &str, request: &Value, option_id: &str) {
    let result = conn
        .control(
            "r1",
            "d-r1",
            control_id,
            RunControlAction::PermissionResponse {
                request_id: request["request_id"].as_str().unwrap().into(),
                option_id: option_id.into(),
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
}

/// Agent 修改自己的設定檔（issue #52）：經權限請求寫入時問人，人允許的寫入視為已接受；
/// 不經過權限請求的寫入在 session 中途就被發現 → 中止回合並問人，選「還原」後檔案還原、
/// 重新啟動 Agent（讓它重新讀取設定）並以 `session/resume` 接續同一個 session。
#[tokio::test(flavor = "multi_thread")]
async fn agent_設定檔在_session_中途被改時中止回合並問人_還原後繼續() {
    restore_settings_flow(false).await;
}

/// 同上，但 Agent 只支援 `session/load`：load 重播的對話不會再以 Event 送出。
#[tokio::test(flavor = "multi_thread")]
async fn agent_設定檔還原後以_session_load_接續_重播的對話不重送() {
    let conn = restore_settings_flow(true).await;
    let replayed = conn.events.iter().any(|e| {
        e["kind"] == "message_chunk"
            && e["content"]["text"] == orbis_fake_agent::agent::LOADED_SESSION_TEXT
    });
    assert!(!replayed, "session/load 重播的對話不可以再送成 Event");
}

async fn restore_settings_flow(load_only: bool) -> RunnerSide {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        claude_code_as_fake_with(
            wt,
            &runner_script("agent-settings.yaml"),
            &agent_state_args(wt, load_only),
        )
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "claude-code", "做事").await;
    let worktree = std::path::PathBuf::from(
        conn.wait_event("worktree_ready").await["worktree_path"]
            .as_str()
            .unwrap(),
    );
    // 寫入 .claude/settings.json：Worktree 內的寫入在 auto 下本來自動允許，Agent 設定檔例外。
    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "tool");
    assert_eq!(request["tool_call_id"], "write-settings");
    answer(&mut conn, "c1", &request, "allow_once").await;

    // Agent 直接寫入 settings.local.json：回合被中止，問人。
    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "agent_settings_changed", "{request}");
    let title = request["title"].as_str().unwrap();
    assert!(title.contains(".claude/settings.local.json"), "{title}");
    assert!(
        !title.contains(".claude/settings.json"),
        "人允許的寫入不再問：{title}"
    );
    let options: Vec<&str> = request["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["option_id"].as_str().unwrap())
        .collect();
    assert_eq!(options, ["allow_once", "reject_once"]);
    answer(&mut conn, "c2", &request, "reject_once").await;

    conn.wait_for("第二回合", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "第二回合完成。"
    })
    .await;
    let diff = conn.wait_event("run_diff").await;
    conn.wait_status("awaiting_gate").await;
    assert!(
        !worktree
            .join(".claude")
            .join("settings.local.json")
            .exists(),
        "選「還原」後 base commit 沒有的設定檔要刪除"
    );
    assert!(worktree.join(".claude").join("settings.json").is_file());
    let paths: Vec<&str> = diff["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, [".claude/settings.json"], "{diff}");
    conn
}

/// session 中途被改，人選「接受」：保留變更並繼續，之後的回合不再為同一份內容問人。
#[tokio::test(flavor = "multi_thread")]
async fn agent_設定檔在_session_中途被改_接受後不再重複問() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        claude_code_as_fake(wt, &runner_script("agent-settings.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "claude-code", "做事").await;
    let worktree = std::path::PathBuf::from(
        conn.wait_event("worktree_ready").await["worktree_path"]
            .as_str()
            .unwrap(),
    );
    let request = conn.wait_event("permission_request").await;
    answer(&mut conn, "c1", &request, "allow_once").await;
    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "agent_settings_changed", "{request}");
    answer(&mut conn, "c2", &request, "allow_once").await;
    conn.wait_status("awaiting_gate").await;
    assert!(
        worktree
            .join(".claude")
            .join("settings.local.json")
            .is_file()
    );
    let asked_again = conn
        .events
        .iter()
        .filter(|e| e["kind"] == "permission_request")
        .count();
    assert_eq!(asked_again, 2, "接受之後不再問");
}

/// 啟動 session 前：Worktree 中 Agent 的設定檔和 base commit 不同（這裡是 setup 寫入的），
/// 先問人，允許後才開始回合。
#[tokio::test(flavor = "multi_thread")]
async fn 啟動_session_前設定檔和_base_commit_不同時先問人() {
    let config = "[worktree]\nsetup = \"mkdir .claude && cd .claude && echo {} > settings.json\"\n";
    let mut env = Env::new(&[("README.md", "a\n"), (cfg().as_str(), config)], |wt| {
        claude_code_as_fake(wt, &runner_script("simple.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "claude-code", "做事").await;
    approve_config(&mut conn, "r1").await;
    let request = conn.wait_event("permission_request").await;
    assert_eq!(request["purpose"], "agent_settings_changed", "{request}");
    assert!(
        request["title"]
            .as_str()
            .unwrap()
            .contains(".claude/settings.json"),
        "{request}"
    );
    let running_before_answer = conn
        .events
        .iter()
        .any(|e| e["kind"] == "status_changed" && e["status"] == "running");
    assert!(!running_before_answer, "允許前不可以開始回合");
    answer(&mut conn, "c1", &request, "allow_once").await;
    conn.wait_status("running").await;
    conn.wait_status("awaiting_gate").await;
}

/// 取出第一則訊息片段並解析成 JSON（`echo_session_meta` 回報的 `_meta`）。
async fn session_meta(conn: &mut RunnerSide) -> Value {
    let chunk = conn.wait_event("message_chunk").await;
    serde_json::from_str(chunk["content"]["text"].as_str().unwrap()).unwrap()
}

/// issue #55：Claude Code 在 Run 中預設不載入使用者全域的設定（plugin、MCP、allow 規則），
/// 只載入 Repo 的 project／local 設定。
#[tokio::test(flavor = "multi_thread")]
async fn claude_code_預設不載入使用者全域設定() {
    let mut env = Env::new(
        &[(
            "README.md",
            "a
",
        )],
        |wt| claude_code_as_fake(wt, &runner_script("session-meta.yaml")),
    )
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "claude-code", "做事").await;
    let meta = session_meta(&mut conn).await;
    assert_eq!(
        meta["claudeCode"]["options"]["settingSources"],
        serde_json::json!(["project", "local"]),
        "{meta}"
    );
}

/// runner.toml 的 `user_settings = true`：照 Claude Code 的預設載入使用者全域設定。
#[tokio::test(flavor = "multi_thread")]
async fn claude_code_設定_user_settings_時載入使用者全域設定() {
    let mut env = Env::new(
        &[(
            "README.md",
            "a
",
        )],
        |wt| {
            format!(
                "{}user_settings = true
",
                claude_code_as_fake(wt, &runner_script("session-meta.yaml"))
            )
        },
    )
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "claude-code", "做事").await;
    let meta = session_meta(&mut conn).await;
    assert_eq!(
        meta,
        Value::Null,
        "不傳 settingSources，沿用 Claude Code 的預設"
    );
}

/// rate limit：回報 rate_limited 並暫停，額度恢復後在同一個 session 繼續。
#[tokio::test(flavor = "multi_thread")]
async fn rate_limit_後在同一個_session_繼續() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &script("rate-limit.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    let limited = conn.wait_event("rate_limited").await;
    assert!(limited["resets_at"].is_string());
    conn.wait_status("rate_limited").await;
    conn.wait_status("running").await;
    let diff = conn.wait_event("run_diff").await;
    assert_eq!(diff_file(&diff, "resumed.txt")["change"], "added");
    conn.wait_status("awaiting_gate").await;
}

/// 大型內容改成 blob：先以 HTTP PUT 上傳，再送參照它的 Event。
#[tokio::test(flavor = "multi_thread")]
async fn 大型內容以_blob_上傳() {
    let big = "0123456789abcdef\n".repeat(5000);
    let dir = temp_dir("orbis script");
    let script_path = dir.path().join("big.yaml");
    std::fs::write(
        &script_path,
        format!(
            "turns:\n  - steps:\n      - tool_call:\n          id: write-big\n          title: 新增 big.txt\n          edit:\n            path: big.txt\n            content: {}\n      - stop: end_turn\n",
            serde_json::to_string(&big).unwrap()
        ),
    )
    .unwrap();
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &script_path)
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    let diff = conn.wait_event("run_diff").await;
    let file = diff_file(&diff, "big.txt");
    assert_eq!(file["new"]["type"], "blob", "{file}");
    let blob_id = file["new"]["blob_id"].as_str().unwrap();
    assert_eq!(file["new"]["size"], big.len());
    let uploaded = env.server.blobs.lock().unwrap().get(blob_id).cloned();
    assert_eq!(
        uploaded.as_deref(),
        Some(big.as_bytes()),
        "送出 Event 前 blob 已經上傳"
    );
}

/// Windows：Agent 是 PATH 上的 `.cmd` shim（放在含空白的目錄），參數含空白。
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn 透過_cmd_shim_啟動_agent() {
    let shim_dir = temp_dir("orbis shim dir");
    std::fs::write(
        shim_dir.path().join("fake-agent-shim.cmd"),
        format!(
            "@echo off\r\n\"{}\" %*\r\n",
            support::fake_agent_bin().display()
        ),
    )
    .unwrap();
    // 劇本路徑含空白。
    let script_dir = temp_dir("orbis script dir");
    let script_path = script_dir.path().join("simple script.yaml");
    std::fs::copy(runner_script("simple.yaml"), &script_path).unwrap();
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        format!(
            "worktree_root = {}\n[agents.fake]\ncommand = \"fake-agent-shim\"\nargs = [\"--script\", {}]\n",
            toml_string(&wt.to_string_lossy()),
            toml_string(&script_path.to_string_lossy()),
        )
    })
    .await;
    let path = std::env::join_paths(
        std::iter::once(shim_dir.path().to_owned())
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    let base_url = env.server.base_url();
    let home = env.home();
    let mut opts = RunnerOptions::new(&base_url, &home);
    opts.env
        .push(("PATH".into(), path.to_string_lossy().into_owned()));
    let runner = spawn_runner(opts);
    let mut conn = env.dispatch("r1", "fake", "做事").await;
    conn.wait_for("完成訊息", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "完成了。"
    })
    .await;
    conn.wait_status("awaiting_gate").await;
    drop(runner);
}

/// manual 政策：Worktree 內的寫入也要問人；拒絕後 Agent 走另一條分支。
#[tokio::test(flavor = "multi_thread")]
async fn manual_政策下拒絕權限請求() {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        fake_agent_toml(wt, &script("permission.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    let mut o = offer(
        "r1",
        "d-r1",
        env.remote.dispatch_repo("web"),
        "fake",
        "寫 config",
    );
    o.permission_policy = PermissionPolicy::Manual;
    conn.send(&send_offer(o)).await;
    let request = conn.wait_event("permission_request").await;
    let bad = conn
        .control(
            "r1",
            "d-r1",
            "c0",
            RunControlAction::PermissionResponse {
                request_id: request["request_id"].as_str().unwrap().into(),
                option_id: "no-such-option".into(),
            },
        )
        .await;
    assert_eq!(bad["reason"], "unknown_permission_request");
    conn.control(
        "r1",
        "d-r1",
        "c1",
        RunControlAction::PermissionResponse {
            request_id: request["request_id"].as_str().unwrap().into(),
            option_id: "reject_once".into(),
        },
    )
    .await;
    conn.wait_for("拒絕分支", |v| {
        v["kind"] == "message_chunk" && v["content"]["text"] == "好，我不會修改 config.json。"
    })
    .await;
    let diff = conn.wait_event("run_diff").await;
    assert!(
        diff["files"].as_array().unwrap().is_empty(),
        "拒絕後沒有寫入檔案：{diff}"
    );
}

#[test]
fn runner_的劇本都能解析() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("scripts");
    let mut count = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "yaml") {
            orbis_fake_agent::Script::from_path(&path)
                .unwrap_or_else(|e| panic!("{} 不合法：{e}", path.display()));
            count += 1;
        }
    }
    assert!(count >= 4, "{count}");
}

/// copy 進來的 `.env` 只在本機使用：不出現在 Review 的 diff，也不會被 commit 或 push。
#[tokio::test(flavor = "multi_thread")]
async fn copy_進來的檔案不會送到_server_也不會_push() {
    let config = "[worktree]\ncopy = [\".env\"]\n[permissions]\nallow_commands = [\"make *\"]\n";
    let remote = Remote::new(&[(cfg().as_str(), config)]);
    let dir = temp_dir("orbis run");
    let checkout = dir.path().join("member");
    git(dir.path(), &["clone", &remote.clone_url(), "member"]);
    std::fs::write(checkout.join(".env"), "API_TOKEN=abcdef123456\n").unwrap();
    let home = dir.path().join("home");
    write_runner_toml(
        &home,
        &format!(
            "{}[repos.web]\npath = {}\n",
            fake_agent_toml(&dir.path().join("wt"), &runner_script("review-loop.yaml")),
            toml_string(&checkout.to_string_lossy())
        ),
    );
    let mut server = FakeServer::start().await;
    let _runner = spawn_runner(RunnerOptions::new(&server.base_url(), &home));
    let mut conn = server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    conn.send(&send_offer(offer(
        "r1",
        "d-r1",
        remote.dispatch_repo("web"),
        "fake",
        "做事",
    )))
    .await;
    let ready = conn.wait_event("worktree_ready").await;
    let worktree = std::path::PathBuf::from(ready["worktree_path"].as_str().unwrap());
    approve_config(&mut conn, "r1").await;
    let diff = conn.wait_event("run_diff").await;
    assert!(
        diff["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f["path"] != ".env"),
        "{diff}"
    );
    assert!(
        worktree.join(".env").is_file(),
        "Worktree 中要有複製進來的 .env"
    );
    conn.wait_status("awaiting_gate").await;
    conn.control(
        "r1",
        "d-r1",
        "c1",
        RunControlAction::GateResult {
            gate: GateKind::Review,
            decision: GateDecision::Approved,
        },
    )
    .await;
    let result = conn
        .control("r1", "d-r1", "c2", RunControlAction::PushBranch)
        .await;
    let sha = result["commit_sha"]
        .as_str()
        .unwrap_or_else(|| panic!("{result}"))
        .to_owned();
    let files = git(&remote.bare, &["ls-tree", "-r", "--name-only", &sha]);
    assert!(files.lines().any(|f| f == "feature.txt"), "{files}");
    assert!(
        !files.lines().any(|f| f == ".env"),
        ".env 不可以被 push：{files}"
    );
    // Agent 自己把 .env commit 進去：拒絕 push。
    // 先 commit 再刪掉也一樣：.env 仍在要 push 的歷史中。
    git(&worktree, &["add", "--", ".env"]);
    git(&worktree, &["commit", "-m", "不小心 commit 了 .env"]);
    git(&worktree, &["rm", "--cached", "-q", "--", ".env"]);
    git(&worktree, &["commit", "-m", "再把 .env 拿掉"]);
    let refused = conn
        .control("r1", "d-r1", "c3", RunControlAction::PushBranch)
        .await;
    assert_eq!(refused["reason"], "failed", "{refused}");
    assert!(
        refused["message"].as_str().unwrap().contains(".env"),
        "{refused}"
    );
    assert_eq!(
        remote.branch_head(&branch("ORB-1-r1")).as_deref(),
        Some(sha.as_str()),
        "被拒絕的 push 不可以送出"
    );
    let all_events = serde_json::to_string(&conn.events).unwrap();
    assert!(
        !all_events.contains("abcdef123456"),
        "secret 不可以出現在 Event 中"
    );
}
