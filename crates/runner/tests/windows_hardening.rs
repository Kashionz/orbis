//! Windows 強化（ARCHITECTURE §6.4、issue #80）：路徑含中文與空白、超過 260 字元的長路徑、
//! 被鎖住的檔案的刪除重試、WSL 檔案系統中的 Repo。macOS 上也跑，確認同一套程式碼在兩個平台都成立。

mod support;

use std::path::Path;
use std::time::{Duration, Instant};

use orbis_protocol::control::{RunControlAction, RunControlOutcome};
use orbis_protocol::enums::{GateDecision, GateKind};
use orbis_protocol::names::RUNNER_CONFIG_FILE;
use orbis_runner::home::RunnerHome;
use orbis_runner::worktree::{WorktreeManager, WorktreeRequest};
use support::flow::{Env, answer};
use support::server::{fake_agent_toml, parse_result};
use support::{Remote, TestHome, branch, cfg, git, runner_script, toml_string};

/// 含中文與空白的暫存目錄前綴（像中文使用者名稱底下的路徑）。
const ZH_PREFIX: &str = "orbis 測試使用者";

fn request(remote: &Remote, task_key: &str, run_seq: u32, branch: Option<&str>) -> WorktreeRequest {
    WorktreeRequest {
        run_id: format!("run-{task_key}-{run_seq}").as_str().into(),
        task_key: task_key.into(),
        run_seq,
        repo: remote.dispatch_repo("web"),
        branch: branch.map(str::to_owned),
        base: None,
        path: None,
    }
}

/// 在 remote 的 `main` 上放一個超過 MAX_PATH（260）的路徑（用 git plumbing，不經過檔案系統）。
fn commit_long_path(remote: &Remote) -> String {
    let long_dir = "d".repeat(120);
    let long_path = format!("{long_dir}/{long_dir}/{long_dir}/file.txt");
    let blob = {
        let out = std::process::Command::new("git")
            .args(["hash-object", "-w", "--stdin"])
            .current_dir(&remote.work)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(b"x")?;
                child.wait_with_output()
            })
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };
    git(
        &remote.work,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("100644,{blob},{long_path}"),
        ],
    );
    git(&remote.work, &["commit", "-m", "長路徑"]);
    git(&remote.work, &["push", "origin", "main"]);
    long_path
}

/// Runner 本機目錄、Worktree 根目錄、Repo 路徑都含中文與空白：建立 Worktree、以 cmd／sh 跑 setup、
/// Fake Agent 寫入中文檔名的檔案、核准後 push，整條路徑都通。
#[tokio::test(flavor = "multi_thread")]
async fn 路徑含中文與空白時可以跑完整個_run() {
    let config = "[worktree]\nsetup = \"echo setup > setup-ran.txt\"\n";
    let mut env = Env::new_in(
        ZH_PREFIX,
        &[("README.md", "# 中文 repo\n"), (cfg().as_str(), config)],
        |wt| fake_agent_toml(wt, &runner_script("hardening-edit.yaml")),
    )
    .await;
    assert!(env.home().to_string_lossy().contains("測試使用者"));
    assert!(env.remote.bare.to_string_lossy().contains("測試使用者"));
    let _runner = env.spawn();
    let mut conn = env.dispatch("r1", "fake", "新增中文檔案").await;
    let ready = conn.wait_event("worktree_ready").await;
    let worktree = std::path::PathBuf::from(ready["worktree_path"].as_str().unwrap());
    assert!(
        worktree.to_string_lossy().contains("測試使用者"),
        "{}",
        worktree.display()
    );
    let trust = conn.wait_event("permission_request").await;
    assert_eq!(trust["purpose"], "config_trust", "{trust}");
    answer(&mut conn, "r1-trust", &trust, "allow_always").await;
    let setup = conn
        .wait_for("setup 完成", |v| {
            v["kind"] == "tool_call"
                && v["tool_call_id"] == "orbis-setup"
                && v["status"] == "completed"
        })
        .await;
    assert_eq!(setup["content"][0]["exit_code"], 0, "{setup}");
    assert!(worktree.join("setup-ran.txt").is_file(), "setup 在中文路徑的 Worktree 中執行");
    conn.wait_status("awaiting_gate").await;
    assert_eq!(
        std::fs::read_to_string(worktree.join("中文檔案.txt"))
            .unwrap()
            .trim(),
        "路徑含中文也沒問題"
    );
    conn.control(
        "r1",
        "d-r1",
        "approve",
        RunControlAction::GateResult {
            gate: GateKind::Review,
            decision: GateDecision::Approved,
        },
    )
    .await;
    let result = conn
        .control("r1", "d-r1", "push", RunControlAction::PushBranch)
        .await;
    let RunControlOutcome::BranchPushed { commit_sha, .. } = parse_result(&result).outcome else {
        panic!("push 應該成功：{result}");
    };
    conn.wait_status("completed").await;
    let content = git(
        &env.remote.bare,
        &["show", &format!("{commit_sha}:中文檔案.txt")],
    );
    assert_eq!(content.trim(), "路徑含中文也沒問題");
}

/// Repo 內的路徑超過 260 字元：Runner 的 git 一律開 core.longpaths，Worktree 建得起來、Agent 可以在
/// 同一層寫檔、刪除也成功（std 的 remove_dir_all 自己用 `\\?\` 形式）。
#[tokio::test]
async fn 超過_260_字元的路徑可以建立_寫檔與刪除() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let long_path = commit_long_path(&remote);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let wt = manager
        .create(&request(&remote, "ORB-14", 1, Some(branch("x").as_str())))
        .await
        .unwrap_or_else(|e| panic!("{:?}：{}", e.code, e.message));
    let file = wt.path.join(&long_path);
    assert!(file.to_string_lossy().len() > 260, "{}", file.display());
    assert!(file.is_file(), "長路徑的檔案要 checkout 出來：{}", file.display());
    // Agent 在同一層寫檔（Fake Agent 用 std 寫入，和這裡相同）。
    let sibling = file.with_file_name("agent.txt");
    std::fs::write(&sibling, "由 Agent 寫入").unwrap();
    // 測試自己呼叫的 git 也要開 longpaths（Runner 的 Git 一律會加）。
    let lp = ["-c", "core.longpaths=true"];
    git(&wt.path, &[lp[0], lp[1], "add", "-A"]);
    git(&wt.path, &[lp[0], lp[1], "commit", "-m", "長路徑中的新檔案"]);
    let agent_file = long_path.replace("file.txt", "agent.txt");
    assert_eq!(
        git(&wt.path, &[lp[0], lp[1], "show", &format!("HEAD:{agent_file}")]),
        "由 Agent 寫入"
    );
    // 刪除含長路徑的 Worktree。
    manager.remove(&wt).await.unwrap();
    assert!(!wt.path.exists());
}

/// 檔案被其他程式鎖住（防毒軟體、索引服務）時刪除會失敗：Runner 退避重試，鎖放開後刪除成功。
#[cfg(windows)]
#[tokio::test]
async fn 檔案被鎖住時刪除會重試() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x1;

    let remote = Remote::new(&[("README.md", "a\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let wt = manager
        .create(&request(&remote, "ORB-15", 1, Some(branch("lock").as_str())))
        .await
        .unwrap();
    // 不共用 delete：刪除會以 os error 32（被另一個程序使用）失敗，直到關閉 handle。
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(wt.path.join("README.md"))
        .unwrap();
    let holder = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        drop(locked);
    });
    let started = Instant::now();
    manager.remove(&wt).await.unwrap();
    holder.await.unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(1000),
        "要等鎖放開才刪得掉：{:?}",
        started.elapsed()
    );
    assert!(!wt.path.exists());
    // git 也不再記得這個 Worktree。
    let list = git(&wt.root_checkout, &["worktree", "list", "--porcelain"]);
    assert!(!list.contains("ORB-15-1"), "{list}");
}

/// Repo 對應到 WSL 檔案系統（`\\wsl$\…`）或 Worktree 根目錄在 WSL 中：Windows 上的 Runner 以明確的
/// 錯誤拒絕，不去碰那個路徑。
#[tokio::test]
async fn 拒絕_wsl_檔案系統中的_repo_與_worktree_根目錄() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let wsl_repo = r"\\wsl$\Ubuntu\home\me\web";
    let home = TestHome::new(&format!(
        "[repos.web]\npath = {}\n",
        toml_string(wsl_repo)
    ));
    let manager = WorktreeManager::new(home.home.clone());
    let err = manager
        .create(&request(&remote, "ORB-16", 1, Some(branch("w").as_str())))
        .await
        .unwrap_err();
    assert!(
        err.message.contains("WSL") && err.message.contains("clone 到 Windows 磁碟"),
        "{}",
        err.message
    );

    let dir = support::temp_dir("orbis wsl home");
    let root = dir.path().join("orbis");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join(RUNNER_CONFIG_FILE),
        format!(
            "worktree_root = {}\n",
            toml_string(r"\\wsl.localhost\Ubuntu\home\me\wt")
        ),
    )
    .unwrap();
    let home = std::sync::Arc::new(RunnerHome::open(Some(root)).unwrap());
    let manager = WorktreeManager::new(home);
    let err = manager
        .create(&request(&remote, "ORB-17", 1, Some(branch("w").as_str())))
        .await
        .unwrap_err();
    assert!(
        err.message.contains("Worktree 根目錄") && err.message.contains("WSL"),
        "{}",
        err.message
    );
}

#[test]
fn 測試用的中文前綴真的含中文與空白() {
    let dir = support::temp_dir(ZH_PREFIX);
    let text = dir.path().to_string_lossy().into_owned();
    assert!(text.contains("測試使用者") && text.contains(' '), "{text}");
    let _ = Path::new(&text);
}
