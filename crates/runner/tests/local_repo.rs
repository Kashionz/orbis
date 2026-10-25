//! 本機 Repo（local-repo，ARCHITECTURE §5、§6.2、§12.1、ADR-0013）：只依 runner.toml 找 checkout、
//! 核准後合併到本機 checkout 的基準分支（四種情況、squash 與 merge commit、push 基準分支）、
//! 封存已合併的分支，以及 Repo Spec 直接 commit 到基準分支。全部用真實 git。

mod support;

use std::path::{Path, PathBuf};

use orbis_protocol::control::RunControlAction;
use orbis_protocol::dispatch::DispatchRepo;
use orbis_protocol::enums::{GateDecision, GateKind, LocalMergeStrategy};
use orbis_protocol::frame::ServerToRunner;
use orbis_protocol::repo_spec::RepoSpecCommit;
use serde_json::Value;
use support::flow::Env;
use support::server::{
    RunnerProcess, RunnerSide, fake_agent_toml, offer, result_outcome, send_offer,
    write_runner_toml,
};
use support::{git, runner_script, toml_string};

fn local_repo() -> DispatchRepo {
    DispatchRepo::Local {
        name: "web".into(),
        default_branch: "main".into(),
        base_ref: "main".into(),
    }
}

/// 環境：checkout 是 remote 的工作 clone（有 origin），runner.toml 把本機 Repo `web` 對應到它。
async fn env() -> Env {
    let env = Env::new(&[("README.md", "# web\n")], |_| String::new()).await;
    let toml = format!(
        "{}[repos.web]\npath = {}\n",
        fake_agent_toml(
            &env.dir.path().join("wt"),
            &runner_script("local-edit.yaml")
        ),
        toml_string(&env.remote.work.to_string_lossy())
    );
    write_runner_toml(&env.home(), &toml);
    env
}

fn checkout(env: &Env) -> &Path {
    &env.remote.work
}

/// 派工到本機 Repo，等到 Review Gate 並核准。
async fn approved(env: &mut Env) -> (RunnerProcess, RunnerSide) {
    let runner = env.spawn();
    let mut conn = env
        .dispatch_with("r1", "fake", "做事", |o| o.repo = local_repo())
        .await;
    conn.wait_status("awaiting_gate").await;
    let result = conn
        .control(
            "r1",
            "d-r1",
            "approve",
            RunControlAction::GateResult {
                gate: GateKind::Review,
                decision: GateDecision::Approved,
            },
        )
        .await;
    assert_eq!(result_outcome(&result), "applied");
    (runner, conn)
}

async fn merge(
    conn: &mut RunnerSide,
    id: &str,
    strategy: LocalMergeStrategy,
    push_base: bool,
) -> Value {
    conn.control(
        "r1",
        "d-r1",
        id,
        RunControlAction::MergeLocal {
            strategy,
            push_base,
        },
    )
    .await
}

fn show(dir: &Path, spec: &str) -> String {
    git(dir, &["show", spec]).replace("\r\n", "\n")
}

fn temp_worktrees(env: &Env) -> Vec<PathBuf> {
    let repo_dir = env.dir.path().join("wt").join("web");
    std::fs::read_dir(&repo_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".merge-")
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn runner_toml_沒有對應時拒絕派工() {
    let mut env = Env::new(&[("README.md", "# web\n")], |wt| {
        fake_agent_toml(wt, &runner_script("local-edit.yaml"))
    })
    .await;
    let _runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    let mut o = offer("r1", "d-r1", local_repo(), "fake", "做事");
    o.repo = local_repo();
    conn.send(&send_offer(o)).await;
    let reply = conn
        .wait_for("dispatch_reject", |v| v["type"] == "dispatch_reject")
        .await;
    assert_eq!(reply["reason"], "repo_unavailable");
    assert!(
        reply["message"].as_str().unwrap().contains("[repos.web]"),
        "{reply}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn 基準分支沒有簽出時在暫時的_worktree_中_squash_合併_封存時刪掉分支() {
    let mut env = env().await;
    git(checkout(&env), &["switch", "-c", "side"]);
    let before = git(checkout(&env), &["rev-parse", "main"]);
    let (_runner, mut conn) = approved(&mut env).await;
    let result = merge(&mut conn, "m1", LocalMergeStrategy::Squash, false).await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
    let merged = conn.wait_event("local_merged").await;
    let head = git(checkout(&env), &["rev-parse", "main"]);
    assert_eq!(merged["commit_sha"], head);
    assert_eq!(merged["base_branch"], "main");
    assert_eq!(merged["pushed"], false);
    conn.wait_status("completed").await;
    assert_eq!(
        git(checkout(&env), &["rev-parse", "main~1"]),
        before,
        "squash 成一個 commit"
    );
    assert_eq!(show(checkout(&env), "main:feature.txt"), "feature");
    assert_eq!(
        git(checkout(&env), &["rev-parse", "--abbrev-ref", "HEAD"]),
        "side",
        "checkout 的簽出不變"
    );
    assert!(temp_worktrees(&env).is_empty(), "暫時的 worktree 已刪除");
    assert!(!git(checkout(&env), &["worktree", "list"]).contains(".merge-"));

    let branch = support::branch("ORB-1-r1");
    assert!(git(checkout(&env), &["branch", "--list", &branch]).contains("ORB-1-r1"));
    let archived = conn
        .control("r1", "d-r1", "archive", RunControlAction::Archive)
        .await;
    assert_eq!(result_outcome(&archived), "applied", "{archived}");
    assert_eq!(
        git(checkout(&env), &["branch", "--list", &branch]),
        "",
        "squash 合併過的分支在封存時刪除"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn 已簽出且乾淨時直接合併_merge_commit_並_push_基準分支() {
    let mut env = env().await;
    let (_runner, mut conn) = approved(&mut env).await;
    let result = merge(&mut conn, "m1", LocalMergeStrategy::Merge, true).await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
    let merged = conn.wait_event("local_merged").await;
    assert_eq!(merged["pushed"], true);
    let head = git(checkout(&env), &["rev-parse", "HEAD"]);
    assert_eq!(merged["commit_sha"], head);
    let parents = git(
        checkout(&env),
        &["rev-list", "--parents", "-n", "1", "HEAD"],
    );
    assert_eq!(
        parents.split_whitespace().count(),
        3,
        "merge commit 有兩個 parent：{parents}"
    );
    assert_eq!(
        std::fs::read_to_string(checkout(&env).join("feature.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "feature\n",
        "直接在 checkout 中合併，工作目錄也更新"
    );
    assert_eq!(
        git(&env.remote.bare, &["rev-parse", "main"]),
        head,
        "已 push 基準分支"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn push_基準分支失敗不影響合併() {
    let mut env = env().await;
    git(
        checkout(&env),
        &["remote", "set-url", "origin", "file:///no/such/repo.git"],
    );
    let (_runner, mut conn) = approved(&mut env).await;
    let result = merge(&mut conn, "m1", LocalMergeStrategy::Squash, true).await;
    assert_eq!(result_outcome(&result), "applied", "{result}");
    let error = conn.wait_event("error").await;
    assert_eq!(error["code"], "git_failed");
    assert_eq!(error["fatal"], false);
    let merged = conn.wait_event("local_merged").await;
    assert_eq!(merged["pushed"], false);
    conn.wait_status("completed").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn 工作目錄有未_commit_的變更時擋下_處理後重試() {
    let mut env = env().await;
    let before = git(checkout(&env), &["rev-parse", "main"]);
    std::fs::write(checkout(&env).join("README.md"), "# 人還在改\n").unwrap();
    let (_runner, mut conn) = approved(&mut env).await;
    let blocked = merge(&mut conn, "m1", LocalMergeStrategy::Squash, false).await;
    assert_eq!(blocked["outcome"], "rejected");
    assert_eq!(blocked["reason"], "failed");
    assert!(
        blocked["message"].as_str().unwrap().contains("README.md"),
        "{blocked}"
    );
    assert_eq!(
        git(checkout(&env), &["rev-parse", "main"]),
        before,
        "沒有合併"
    );
    assert_eq!(
        std::fs::read_to_string(checkout(&env).join("README.md")).unwrap(),
        "# 人還在改\n",
        "不動人的變更"
    );
    // 處理後重試。
    git(checkout(&env), &["checkout", "--", "README.md"]);
    let retried = merge(&mut conn, "m2", LocalMergeStrategy::Squash, false).await;
    assert_eq!(result_outcome(&retried), "applied", "{retried}");
    conn.wait_event("local_merged").await;
    conn.wait_status("completed").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn 合併衝突時還原並擋下() {
    let mut env = env().await;
    let (_runner, mut conn) = approved(&mut env).await;
    // Run 開出之後有人在基準分支改了同一行。
    std::fs::write(checkout(&env).join("README.md"), "# web\nhuman\n").unwrap();
    git(checkout(&env), &["commit", "-am", "人的修改"]);
    let before = git(checkout(&env), &["rev-parse", "main"]);
    for strategy in [LocalMergeStrategy::Squash, LocalMergeStrategy::Merge] {
        let id = format!("m-{}", strategy.as_str());
        let blocked = merge(&mut conn, &id, strategy, false).await;
        assert_eq!(blocked["reason"], "failed", "{blocked}");
        assert!(
            blocked["message"].as_str().unwrap().contains("衝突"),
            "{blocked}"
        );
        assert_eq!(git(checkout(&env), &["rev-parse", "main"]), before);
        assert_eq!(
            git(checkout(&env), &["status", "--porcelain"]),
            "",
            "衝突已還原（{}）",
            strategy.as_str()
        );
    }
}

async fn spec_commit(
    conn: &mut RunnerSide,
    id: &str,
    repo: &str,
    path: &str,
    content: &str,
) -> Value {
    conn.send(&ServerToRunner::RepoSpecCommit(RepoSpecCommit {
        commit_id: id.into(),
        repo: repo.into(),
        base_branch: "main".into(),
        path: path.into(),
        content: content.into(),
        message: "docs: 更新 Spec\n\nCo-authored-by: Member <member@example.invalid>".into(),
    }))
    .await;
    conn.wait_for(&format!("repo_spec_commit_result {id}"), |v| {
        v["type"] == "repo_spec_commit_result" && v["commit_id"] == id
    })
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn repo_spec_直接_commit_到基準分支() {
    let mut env = env().await;
    let _runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;

    let committed = spec_commit(&mut conn, "c1", "web", "docs/spec.md", "# Spec\n").await;
    assert_eq!(committed["outcome"], "committed", "{committed}");
    assert_eq!(
        committed["commit_sha"],
        git(checkout(&env), &["rev-parse", "main"])
    );
    assert_eq!(show(checkout(&env), "main:docs/spec.md"), "# Spec");
    assert_eq!(git(checkout(&env), &["status", "--porcelain"]), "");

    let unchanged = spec_commit(&mut conn, "c2", "web", "docs/spec.md", "# Spec\n").await;
    assert_eq!(unchanged["outcome"], "unchanged", "{unchanged}");
    assert_eq!(unchanged["commit_sha"], committed["commit_sha"]);

    std::fs::write(checkout(&env).join("README.md"), "改到一半\n").unwrap();
    let dirty = spec_commit(&mut conn, "c3", "web", "docs/spec.md", "# 新的 Spec\n").await;
    assert_eq!(dirty["reason"], "working_tree_dirty", "{dirty}");
    git(checkout(&env), &["checkout", "--", "README.md"]);

    // 基準分支沒有簽出：在暫時的 worktree 中 commit。
    git(checkout(&env), &["switch", "-c", "side"]);
    let detached = spec_commit(&mut conn, "c4", "web", "docs/spec.md", "# 新的 Spec\n").await;
    assert_eq!(detached["outcome"], "committed", "{detached}");
    assert_eq!(show(checkout(&env), "main:docs/spec.md"), "# 新的 Spec");
    assert!(temp_worktrees(&env).is_empty());

    let unknown = spec_commit(&mut conn, "c5", "api", "docs/spec.md", "x").await;
    assert_eq!(unknown["reason"], "repo_unavailable");
    let bad = spec_commit(&mut conn, "c6", "web", ".github/x.md", "x").await;
    assert_eq!(bad["reason"], "failed");
}
