//! Worktree 管理（ARCHITECTURE §6.2、§6.3），使用真實 git。

mod support;

use std::path::Path;

use orbis_protocol::event::RunErrorCode;
use orbis_protocol::names;
use orbis_runner::paths;
use orbis_runner::worktree::{MANAGED_CLONE_DIR, WorktreeManager, WorktreeRequest};
use support::{Remote, TestHome, git, toml_string};

fn request(remote: &Remote, task_key: &str, run_seq: u32, branch: Option<&str>) -> WorktreeRequest {
    WorktreeRequest {
        run_id: format!("run-{task_key}-{run_seq}").as_str().into(),
        task_key: task_key.into(),
        run_seq,
        repo: remote.dispatch_repo("web"),
        branch: branch.map(str::to_owned),
    }
}

const CONFIG: &str = r#"
[worktree]
setup = "echo setup-ran > setup.txt"
copy = [".env", "config/local.json", "missing.txt"]
shared_dirs = [".cache/shared"]

[permissions]
allow_commands = ["pnpm *"]
"#;

#[tokio::test]
async fn 從_runner_自己的_clone_開出_worktree() {
    let remote = Remote::new(&[("README.md", "# web\n"), (".orbis/config.toml", CONFIG)]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());

    let mut wt = manager
        .create(&request(&remote, "ORB-1", 1, Some("orbis/ORB-1-readme")))
        .await
        .unwrap();
    assert!(!wt.scripts_approved, "有 setup 腳本而且還沒核准");

    // 路徑：<root>/<repo>/<task-key>-<run-seq>，而且路徑含空白也沒問題。
    let expected = paths::canonical(&home.dir.path().join("wt").join("web").join("ORB-1-1"));
    assert!(
        paths::same_path(&wt.path, &expected),
        "{}",
        wt.path.display()
    );
    assert!(wt.path.to_string_lossy().contains(' '));
    // Windows 的 git 可能設定了 core.autocrlf。
    let readme = std::fs::read_to_string(wt.path.join("README.md")).unwrap();
    assert_eq!(readme.replace("\r\n", "\n"), "# web\n");
    assert_eq!(
        git(&wt.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "orbis/ORB-1-readme"
    );
    assert_eq!(wt.base_commit, git(&remote.work, &["rev-parse", "HEAD"]));
    assert!(!wt.member_checkout);
    assert!(paths::same_path(
        &wt.root_checkout,
        &home
            .dir
            .path()
            .join("wt")
            .join("web")
            .join(MANAGED_CLONE_DIR)
    ));
    // 設定檔從 base commit 讀出。
    assert_eq!(wt.config.config.permissions.allow_commands, ["pnpm *"]);

    // 注入的環境變數名稱都來自名稱常數。
    let env = wt.env();
    let get = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    assert_eq!(get(names::ENV_PORT), Some(wt.port.to_string()));
    assert_eq!(get(names::ENV_TASK_KEY).as_deref(), Some("ORB-1"));
    assert_eq!(get(names::ENV_RUN_ID).as_deref(), Some("run-ORB-1-1"));
    assert!(get(names::ENV_WORKTREE_PATH).is_some());
    assert!(get(names::ENV_ROOT_PATH).is_some());

    // 沒有對應的本機 checkout：copy 不生效，shared_dirs 仍然建立。
    let dotenv = manager.link_and_copy(&wt).unwrap();
    assert!(dotenv.is_empty());
    assert!(!wt.path.join(".env").exists());
    assert!(wt.path.join(".cache").join("shared").is_dir());

    // setup 在 Worktree 中執行。
    // 未核准時不執行；核准後在 Worktree 中執行。
    let refused = manager.run_setup(&wt).await.unwrap_err();
    assert_eq!(refused.code, RunErrorCode::SetupFailed);
    assert!(!wt.path.join("setup.txt").exists());
    wt.scripts_approved = true;
    let output = manager.run_setup(&wt).await.unwrap().unwrap();
    assert!(output.success(), "{}", output.combined());
    assert!(
        std::fs::read_to_string(wt.path.join("setup.txt"))
            .unwrap()
            .contains("setup-ran")
    );
}

#[tokio::test]
async fn 從_member_的_checkout_開出並複製檔案() {
    let remote = Remote::new(&[("README.md", "# web\n"), (".orbis/config.toml", CONFIG)]);
    let checkout = support::temp_dir("orbis member checkout");
    let member = checkout.path().join("web");
    git(checkout.path(), &["clone", &remote.clone_url(), "web"]);
    std::fs::write(member.join(".env"), "API_TOKEN=abcdef123456\n").unwrap();
    std::fs::create_dir_all(member.join("config")).unwrap();
    std::fs::write(member.join("config").join("local.json"), "{}").unwrap();

    let home = TestHome::new(&format!(
        "[repos.{}]\npath = {}\n",
        toml_string(&remote.clone_url()),
        toml_string(&member.to_string_lossy())
    ));
    let manager = WorktreeManager::new(home.home.clone());
    let wt = manager
        .create(&request(&remote, "ORB-2", 1, Some("orbis/ORB-2-x")))
        .await
        .unwrap();
    assert!(wt.member_checkout);
    assert!(paths::same_path(&wt.root_checkout, &member));

    let dotenv = manager.link_and_copy(&wt).unwrap();
    assert_eq!(dotenv, ["API_TOKEN=abcdef123456\n"]);
    assert!(wt.path.join(".env").is_file());
    assert!(wt.path.join("config").join("local.json").is_file());
    // 共用目錄是連結，寫進去的檔案會出現在 Member 的 checkout。
    std::fs::write(wt.path.join(".cache").join("shared").join("x"), "1").unwrap();
    assert!(member.join(".cache").join("shared").join("x").is_file());
    // Worktree 註冊在 Member 的 checkout 中。
    let list = git(&member, &["worktree", "list"]);
    assert!(list.contains("ORB-2-1"), "{list}");
}

#[tokio::test]
async fn 同一個_run_再次派到這台_runner_時沿用_worktree() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let req = request(&remote, "ORB-3", 2, Some("orbis/ORB-3-x"));
    let first = manager.create(&req).await.unwrap();
    std::fs::write(first.path.join("wip.txt"), "未 commit").unwrap();
    let second = manager.create(&req).await.unwrap();
    assert!(paths::same_path(&first.path, &second.path));
    assert_eq!(first.port, second.port, "同一個 Worktree 沿用同一個 port");
    assert!(second.path.join("wip.txt").exists());
}

#[tokio::test]
async fn consult_模式沒有分支() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let wt = manager
        .create(&request(&remote, "ORB-4", 1, None))
        .await
        .unwrap();
    assert_eq!(
        git(&wt.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "HEAD"
    );
}

#[tokio::test]
async fn 不同_worktree_分到不同的_port() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let a = manager
        .create(&request(&remote, "ORB-5", 1, Some("orbis/a")))
        .await
        .unwrap();
    let b = manager
        .create(&request(&remote, "ORB-5", 2, Some("orbis/b")))
        .await
        .unwrap();
    assert_ne!(a.port, b.port);
}

#[tokio::test]
async fn setup_失敗會回報輸出() {
    let remote = Remote::new(&[(
        ".orbis/config.toml",
        "[worktree]\nsetup = \"echo 壞掉了 && exit 3\"\n",
    )]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let mut wt = manager
        .create(&request(&remote, "ORB-6", 1, Some("orbis/x")))
        .await
        .unwrap();
    wt.scripts_approved = true;
    let output = manager.run_setup(&wt).await.unwrap().unwrap();
    assert!(!output.success());
    assert_eq!(output.status.code(), Some(3));
}

#[tokio::test]
async fn 設定檔格式錯誤時以_setup_failed_失敗() {
    let remote = Remote::new(&[(".orbis/config.toml", "[worktree\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let err = manager
        .create(&request(&remote, "ORB-7", 1, Some("orbis/x")))
        .await
        .unwrap_err();
    assert_eq!(err.code, RunErrorCode::SetupFailed);
}

#[tokio::test]
async fn copy_拒絕_glob_與跳出_repo_的路徑() {
    let remote = Remote::new(&[(".orbis/config.toml", "[worktree]\ncopy = [\"../secret\"]\n")]);
    let checkout = support::temp_dir("orbis member checkout");
    git(checkout.path(), &["clone", &remote.clone_url(), "web"]);
    let home = TestHome::new(&format!(
        "[repos.web]\npath = {}\n",
        toml_string(&checkout.path().join("web").to_string_lossy())
    ));
    let manager = WorktreeManager::new(home.home.clone());
    let wt = manager
        .create(&request(&remote, "ORB-8", 1, Some("orbis/x")))
        .await
        .unwrap();
    let err = manager.link_and_copy(&wt).unwrap_err();
    assert_eq!(err.code, RunErrorCode::SetupFailed);
    assert!(err.message.contains(".."), "{}", err.message);
}

#[tokio::test]
async fn base_ref_不存在時以_git_failed_失敗() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let mut req = request(&remote, "ORB-9", 1, Some("orbis/x"));
    req.repo.base_ref = "origin/does-not-exist".into();
    let err = manager.create(&req).await.unwrap_err();
    assert_eq!(err.code, RunErrorCode::GitFailed);
}

#[tokio::test]
async fn repo_名稱不可以跳出_worktree_根目錄() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let mut req = request(&remote, "ORB-10", 1, Some("orbis/x"));
    req.repo.name = "../../etc".into();
    assert_eq!(
        manager.create(&req).await.unwrap_err().code,
        RunErrorCode::WorktreeFailed
    );
}

#[tokio::test]
async fn 刪除時保留有未合併_commit_的分支() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());

    let clean = manager
        .create(&request(&remote, "ORB-11", 1, Some("orbis/clean")))
        .await
        .unwrap();
    let removal = manager.remove(&clean).await.unwrap();
    assert!(!removal.branch_kept);
    assert!(!clean.path.exists());
    assert!(
        !git(&clean.root_checkout, &["branch", "--list", "orbis/clean"]).contains("orbis/clean")
    );

    let dirty = manager
        .create(&request(&remote, "ORB-11", 2, Some("orbis/dirty")))
        .await
        .unwrap();
    std::fs::write(dirty.path.join("new.txt"), "x").unwrap();
    git(&dirty.path, &["add", "-A"]);
    git(&dirty.path, &["commit", "-m", "未合併"]);
    let removal = manager.remove(&dirty).await.unwrap();
    assert!(removal.branch_kept, "有未合併 commit 的分支要保留");
    assert!(!dirty.path.exists());
    assert!(
        git(&dirty.root_checkout, &["branch", "--list", "orbis/dirty"]).contains("orbis/dirty")
    );
}

#[tokio::test]
async fn archive_失敗時擋下刪除() {
    let remote = Remote::new(&[(".orbis/config.toml", "[worktree]\narchive = \"exit 1\"\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let mut wt = manager
        .create(&request(&remote, "ORB-12", 1, Some("orbis/x")))
        .await
        .unwrap();
    // 未核准的 archive 腳本不執行，也不刪除。
    let err = manager.remove(&wt).await.unwrap_err();
    assert!(err.message.contains("尚未核准"), "{}", err.message);
    assert!(wt.path.exists());
    wt.scripts_approved = true;
    let err = manager.remove(&wt).await.unwrap_err();
    assert!(err.message.contains("archive"), "{}", err.message);
    assert!(wt.path.exists(), "archive 失敗時不可以刪除");
}

#[tokio::test]
async fn 拒絕刪除_worktree_根目錄以外的路徑() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let mut wt = manager
        .create(&request(&remote, "ORB-13", 1, Some("orbis/x")))
        .await
        .unwrap();
    let outside = support::temp_dir("orbis outside");
    for bad in [
        outside.path().to_owned(),
        manager.root(),
        home.home.user_home().to_owned(),
        wt.root_checkout.clone(),
    ] {
        wt.path = bad.clone();
        let err = manager.remove(&wt).await.unwrap_err();
        assert!(
            err.message.contains("拒絕刪除"),
            "{}：{}",
            bad.display(),
            err.message
        );
    }
    assert!(outside.path().exists());
}

/// Git for Windows 的長路徑錯誤要辨識成 `path_too_long`（§6.4）。
#[cfg(windows)]
#[tokio::test]
async fn 長路徑錯誤回報為_path_too_long() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    // 在 remote 放一個超過 MAX_PATH 的路徑（用 git plumbing，不經過檔案系統）。
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

    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    // core.longpaths=false 是 Git for Windows 的預設；明確設定，避免受 CI 機器的全域設定影響。
    let source = home
        .dir
        .path()
        .join("wt")
        .join("web")
        .join(MANAGED_CLONE_DIR);
    let req = request(&remote, "ORB-14", 1, Some("orbis/x"));
    // 先建立 clone，再關掉 longpaths。
    let _ = manager
        .create(&WorktreeRequest {
            run_seq: 99,
            ..req.clone()
        })
        .await;
    if source.join(".git").exists() {
        git(&source, &["config", "core.longpaths", "false"]);
    }
    let err = manager.create(&req).await.unwrap_err();
    assert_eq!(err.code, RunErrorCode::PathTooLong, "{}", err.message);
}

#[test]
fn 測試用的暫存路徑含空白() {
    assert!(
        support::temp_dir("x")
            .path()
            .to_string_lossy()
            .contains(' ')
    );
    let _ = Path::new("");
}

#[tokio::test]
async fn 永遠允許過的設定內容不必再核准_內容改變後要重新核准() {
    let remote = Remote::new(&[(".orbis/config.toml", "[worktree]\nsetup = \"echo a\"\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let first = manager
        .create(&request(&remote, "ORB-20", 1, Some("orbis/a")))
        .await
        .unwrap();
    assert!(!first.scripts_approved);
    home.home
        .trust(&remote.clone_url(), &first.config.hash)
        .unwrap();
    let second = manager
        .create(&request(&remote, "ORB-20", 2, Some("orbis/b")))
        .await
        .unwrap();
    assert!(second.scripts_approved, "同一份內容已被永遠允許");

    remote.commit(
        &[(".orbis/config.toml", "[worktree]\nsetup = \"echo b\"\n")],
        "改 setup",
    );
    let third = manager
        .create(&request(&remote, "ORB-20", 3, Some("orbis/c")))
        .await
        .unwrap();
    assert!(!third.scripts_approved, "內容改變後要重新核准");
}

#[tokio::test]
async fn 沒有腳本時不需要核准() {
    let remote = Remote::new(&[(
        ".orbis/config.toml",
        "[permissions]\nallow_commands = [\"pnpm *\"]\n",
    )]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    let wt = manager
        .create(&request(&remote, "ORB-21", 1, Some("orbis/a")))
        .await
        .unwrap();
    assert!(wt.scripts_approved);
}

#[tokio::test]
async fn 拒絕會被當成_git_選項的值() {
    let remote = Remote::new(&[("README.md", "a\n")]);
    let home = TestHome::new("");
    let manager = WorktreeManager::new(home.home.clone());
    for branch in ["--upload-pack=evil", "-b", "has space", "a..b"] {
        let err = manager
            .create(&request(&remote, "ORB-22", 1, Some(branch)))
            .await
            .unwrap_err();
        assert_eq!(err.code, RunErrorCode::WorktreeFailed, "{branch}");
    }
    let mut req = request(&remote, "ORB-22", 1, Some("orbis/ok"));
    req.repo.clone_url = "--upload-pack=touch /tmp/pwned".into();
    req.repo.name = "other".into();
    assert_eq!(
        manager.create(&req).await.unwrap_err().code,
        RunErrorCode::WorktreeFailed
    );
}

#[cfg(unix)]
#[tokio::test]
async fn copy_不跟著連結複製到_checkout_以外() {
    let remote = Remote::new(&[(".orbis/config.toml", "[worktree]\ncopy = [\".env\"]\n")]);
    let checkout = support::temp_dir("orbis member checkout");
    let member = checkout.path().join("web");
    git(checkout.path(), &["clone", &remote.clone_url(), "web"]);
    let secret = checkout.path().join("secret.txt");
    std::fs::write(&secret, "TOKEN=abcdef123456").unwrap();
    std::os::unix::fs::symlink(&secret, member.join(".env")).unwrap();
    let home = TestHome::new(&format!(
        "[repos.web]\npath = {}\n",
        toml_string(&member.to_string_lossy())
    ));
    let manager = WorktreeManager::new(home.home.clone());
    let wt = manager
        .create(&request(&remote, "ORB-23", 1, Some("orbis/x")))
        .await
        .unwrap();
    let err = manager.link_and_copy(&wt).unwrap_err();
    assert!(err.message.contains("連結"), "{}", err.message);
    assert!(!wt.path.join(".env").exists());
}
