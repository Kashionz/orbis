//! 整合測試共用的工具：真實 git 的 remote、暫存的 Runner 本機目錄、Fake Agent 執行檔。
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

use orbis_protocol::dispatch::DispatchRepo;
use orbis_runner::contract::RUNNER_CONFIG_FILE;
use orbis_runner::home::RunnerHome;
use tempfile::TempDir;

/// 測試用的 git 身分（不依賴 CI 機器上的 git 設定）。
pub const GIT_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "Orbis Test"),
    ("GIT_AUTHOR_EMAIL", "test@orbis.invalid"),
    ("GIT_COMMITTER_NAME", "Orbis Test"),
    ("GIT_COMMITTER_EMAIL", "test@orbis.invalid"),
];

/// 執行 git，失敗時 panic 並印出輸出。
pub fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .envs(GIT_IDENTITY)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap_or_else(|e| panic!("無法執行 git {args:?}：{e}"));
    assert!(
        output.status.success(),
        "git {args:?} 失敗：{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// 暫存目錄，名稱含空白（§6.4「路徑含空白」）。
pub fn temp_dir(prefix: &str) -> TempDir {
    tempfile::Builder::new()
        .prefix(&format!("{prefix} with space "))
        .tempdir()
        .unwrap()
}

/// 一個 bare remote 與它的工作用 clone（用來推新的 commit）。
pub struct Remote {
    pub dir: TempDir,
    pub bare: PathBuf,
    pub work: PathBuf,
}

impl Remote {
    /// 建立 remote，`main` 上有 `files` 這些檔案。
    pub fn new(files: &[(&str, &str)]) -> Self {
        let dir = temp_dir("orbis remote");
        let bare = dir.path().join("origin.git");
        let work = dir.path().join("seed");
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare", "--initial-branch=main"]);
        std::fs::create_dir_all(&work).unwrap();
        git(&work, &["init", "--initial-branch=main"]);
        git(&work, &["config", "core.autocrlf", "false"]);
        git(&work, &["remote", "add", "origin", &bare.to_string_lossy()]);
        let remote = Self { dir, bare, work };
        remote.commit(files, "初始內容");
        remote
    }

    /// 在 `main` 上加一個 commit 並 push。
    pub fn commit(&self, files: &[(&str, &str)], message: &str) {
        for (path, content) in files {
            let path = self.work.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        git(&self.work, &["add", "-A"]);
        git(&self.work, &["commit", "--allow-empty", "-m", message]);
        git(&self.work, &["push", "origin", "main"]);
    }

    pub fn clone_url(&self) -> String {
        self.bare.to_string_lossy().into_owned()
    }

    pub fn dispatch_repo(&self, name: &str) -> DispatchRepo {
        DispatchRepo {
            name: name.into(),
            clone_url: self.clone_url(),
            default_branch: "main".into(),
            base_ref: "origin/main".into(),
        }
    }

    /// remote 上某個分支的 commit；分支不存在時回傳 `None`。
    pub fn branch_head(&self, branch: &str) -> Option<String> {
        let output = Command::new("git")
            .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
            .current_dir(&self.bare)
            .output()
            .unwrap();
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
}

/// 暫存的 Runner 本機目錄：Worktree 根目錄放在暫存目錄中（含空白）。
pub struct TestHome {
    pub dir: TempDir,
    pub home: Arc<RunnerHome>,
}

impl TestHome {
    pub fn new(extra_settings: &str) -> Self {
        let dir = temp_dir("orbis home");
        let root = dir.path().join("orbis");
        std::fs::create_dir_all(&root).unwrap();
        let wt_root = dir.path().join("wt");
        let settings = format!(
            "worktree_root = {}\n{extra_settings}",
            toml_string(&wt_root.to_string_lossy())
        );
        std::fs::write(root.join(RUNNER_CONFIG_FILE), settings).unwrap();
        let home = Arc::new(RunnerHome::open(Some(root)).unwrap());
        Self { dir, home }
    }

    pub fn root(&self) -> PathBuf {
        self.dir.path().join("orbis")
    }
}

/// TOML 的 basic string。
pub fn toml_string(value: &str) -> String {
    format!("{value:?}")
}

/// 編譯好的 `orbis-fake-agent` 執行檔。`cargo test --workspace` 會一起編譯；
/// 單獨測這個 crate 時第一次用到才編譯。
pub fn fake_agent_bin() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let exe = format!("orbis-fake-agent{}", std::env::consts::EXE_SUFFIX);
        let target_dir = Path::new(env!("CARGO_BIN_EXE_orbis-runner"))
            .parent()
            .unwrap()
            .to_owned();
        let bin = target_dir.join(&exe);
        if !bin.is_file() {
            let status = Command::new(env!("CARGO"))
                .args(["build", "-p", "orbis-fake-agent", "--bins"])
                .status()
                .unwrap();
            assert!(status.success(), "編譯 orbis-fake-agent 失敗");
        }
        assert!(bin.is_file(), "找不到 {}", bin.display());
        bin
    })
    .clone()
}

/// Fake Agent 隨附劇本的路徑。
pub fn script(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fake-agent")
        .join("scripts")
        .join(name)
}

pub mod server;

/// Runner 整合測試自己的劇本（`tests/scripts/`）。
pub fn runner_script(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("scripts")
        .join(name)
}
