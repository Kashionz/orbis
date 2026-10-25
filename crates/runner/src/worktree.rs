//! Worktree 管理（ARCHITECTURE §6.2、§6.3）。
//!
//! 建立流程：
//! 1. 準備 Repo 來源：runner.toml 有對應的本機 checkout 就用它，否則 Runner 自己 clone 到
//!    `<Worktree 根目錄>/<repo>/_main`。
//! 2. `git fetch`，解析 base ref，從 base commit 讀出 `<CONFIG_DIR>/<CONFIG_FILE>`。
//! 3. `git worktree add`（分支由 Server 指定）。
//! 4. `shared_dirs` 建立連結（Windows 優先 junction）、`copy` 複製檔案。
//! 5. 分配 port、組出注入的環境變數。
//! 6. 由 Run 負責信任核准，接著執行 setup，最後啟動 Agent。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbis_protocol::dispatch::DispatchRepo;
use orbis_protocol::event::RunErrorCode;
use orbis_protocol::ids::RunId;
use orbis_protocol::names;

use crate::git::{Git, GitError};
use crate::home::RunnerHome;
use crate::paths;
use crate::process::{self, Output};
use crate::repo_config::{self, LoadedConfig};
use crate::shell::Shell;

/// Runner 自己 clone 的 Repo 放在 `<root>/<repo>/` 下的這個目錄。
/// Task Key 一定是大寫字母開頭，不會和 Worktree 目錄撞名。
pub const MANAGED_CLONE_DIR: &str = "_main";

/// Worktree 操作失敗。
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct WorktreeError {
    pub code: RunErrorCode,
    pub message: String,
}

impl WorktreeError {
    pub fn new(code: RunErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn worktree(message: impl Into<String>) -> Self {
        Self::new(RunErrorCode::WorktreeFailed, message)
    }
}

impl From<GitError> for WorktreeError {
    fn from(e: GitError) -> Self {
        Self::new(e.code, e.to_string())
    }
}

/// 建立 Worktree 需要的資訊（取自 DispatchOffer）。
#[derive(Debug, Clone)]
pub struct WorktreeRequest {
    pub run_id: RunId,
    pub task_key: String,
    pub run_seq: u32,
    pub repo: DispatchRepo,
    /// `None` 時以 detached HEAD 開出（`consult` 模式的 Child Run）。
    pub branch: Option<String>,
    /// 不從 `repo.base_ref` 開出時的基準（`branch` 模式的 Child Run：父 Run 當下的 HEAD；
    /// Feedback Loop：前一個 Run 的 base commit）。
    pub base: Option<BaseOverride>,
    /// 沿用的 Worktree 位置（Feedback Loop 的新 Run 沿用前一個 Run 的 Worktree）；`None` 時依
    /// Task Key 與 Run 序號計算（§6.2）。
    pub path: Option<std::path::PathBuf>,
}

/// [`WorktreeRequest::base`]：開出 Worktree 的 commit，與讀取 Repo 設定檔的 commit。
/// Repo 設定檔一律從 base commit 讀（§6.2），所以 Child Run 沿用父 Run 的 base commit 讀設定，
/// Agent 在父 Worktree 中修改並 commit 的設定不會生效。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseOverride {
    pub commit: String,
    pub config_commit: String,
}

/// 建好的 Worktree。
#[derive(Debug, Clone)]
pub struct Worktree {
    /// 正規化後的絕對路徑。
    pub path: PathBuf,
    /// Repo 來源（Member 的 checkout 或 Runner 自己的 clone），注入為 `<前綴>ROOT_PATH`。
    pub root_checkout: PathBuf,
    /// 是否為 Member 自己的 checkout（決定 `copy` 是否生效）。
    pub member_checkout: bool,
    pub branch: Option<String>,
    pub base_commit: String,
    pub base_ref: String,
    pub default_branch: String,
    /// 讀設定檔的 commit（通常就是 base commit）。
    pub config_commit: String,
    /// 從 base commit 讀出的設定檔。
    pub config: LoadedConfig,
    pub port: u16,
    pub run_id: RunId,
    pub task_key: String,
    /// 設定檔中的腳本是否已核准（§6.2「設定的信任核准」）。沒有腳本，或這份內容已被
    /// 「永遠允許」時為 `true`；否則由 Run 取得人工核准後設為 `true`。未核准時不執行任何腳本。
    pub scripts_approved: bool,
    /// 沿用 Worktree 時本機分支與 `origin/<branch>` 的對齊結果（§5.2）。新建的 Worktree 一律是
    /// [`RemoteAlignment::UpToDate`]。
    pub remote_alignment: RemoteAlignment,
}

/// 沿用 Worktree（Feedback Loop）時，本機分支和遠端分支的關係。有人直接 push 到 PR 分支時，
/// 修正 Run 的 Agent 要看得到那些 commit，否則 `push_branch` 會因 non-fast-forward 失敗。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum RemoteAlignment {
    /// 遠端沒有這個分支、和本機相同，或本機領先遠端（push 時會 fast-forward）。
    #[default]
    UpToDate,
    /// 遠端領先本機，已把本機分支 fast-forward 到遠端的 commit。
    FastForwarded { from: String, to: String },
    /// 兩邊都有對方沒有的 commit（或工作目錄有變更而無法 fast-forward）：不動本機，交給 Agent 整合。
    Diverged {
        remote_branch: String,
        /// 本機沒有的遠端 commit 數。
        behind: u64,
        /// 遠端沒有的本機 commit 數。
        ahead: u64,
    },
}

impl RemoteAlignment {
    /// 分岔時給 Agent 的說明，放進修正 Run 的第一個 prompt；其他情況為 `None`。
    pub fn prompt_note(&self) -> Option<String> {
        match self {
            Self::Diverged {
                remote_branch,
                behind,
                ahead,
            } => Some(format!(
                "（注意：遠端分支 {remote_branch} 有 {behind} 個本機沒有的 commit，而本機也有 {ahead} 個遠端沒有的 commit，兩邊已經分岔。請先整合遠端的變更（例如 `git merge {remote_branch}`，衝突請解決後 commit），再進行修改；否則 push 會因為 non-fast-forward 失敗。）"
            )),
            _ => None,
        }
    }
}

impl Worktree {
    pub fn git(&self) -> Git {
        Git::new(&self.path)
    }

    /// 注入到 setup、Agent 等 Worktree 程序的環境變數（§6.3）。
    pub fn env(&self) -> Vec<(String, String)> {
        vec![
            (
                names::ENV_ROOT_PATH.into(),
                self.root_checkout.to_string_lossy().into_owned(),
            ),
            (
                names::ENV_WORKTREE_PATH.into(),
                self.path.to_string_lossy().into_owned(),
            ),
            (names::ENV_PORT.into(), self.port.to_string()),
            (names::ENV_RUN_ID.into(), self.run_id.to_string()),
            (names::ENV_TASK_KEY.into(), self.task_key.clone()),
        ]
    }

    /// 只在本機使用、不可以 commit 或送到 Server 的路徑：`copy` 進來的檔案與 `shared_dirs` 的連結。
    pub fn local_only_paths(&self) -> Vec<String> {
        let w = &self.config.config.worktree;
        w.copy
            .iter()
            .chain(&w.shared_dirs)
            .filter_map(|p| repo_config::literal_relative_path(p).ok())
            .collect()
    }

    /// 找出 `base..HEAD` 中，tree 內含本機檔案、而且內容和 base commit 不同的第一個 commit。
    pub async fn local_only_leak(&self) -> Result<Option<String>, GitError> {
        let git = self.git();
        let base = self.base_commit.as_str();
        let local_only = self.local_only_paths();
        if local_only.is_empty() {
            return Ok(None);
        }
        // 列出整個 tree（`-z` 的路徑不加引號），在這裡以不分大小寫比對：
        // ls-tree 不支援 icase pathspec，大小寫不同的 `.ENV` 也要算。
        let matches = |path: &str| {
            let path = path.to_ascii_lowercase();
            local_only.iter().any(|p| {
                let p = p.trim_end_matches('/').to_ascii_lowercase();
                path == p || path.starts_with(&format!("{p}/"))
            })
        };
        let entries = |listing: String| -> std::collections::HashSet<String> {
            listing
                .split('\0')
                // 每一筆是「mode type sha<TAB>path」
                .filter(|e| e.split_once('\t').is_some_and(|(_, path)| matches(path)))
                .map(str::to_owned)
                .collect()
        };
        let base_entries = entries(git.run(["ls-tree", "-r", "-z", base]).await?);
        let commits = git.run(["rev-list", &format!("{base}..HEAD")]).await?;
        for commit in commits.lines().filter(|c| !c.trim().is_empty()) {
            let listed = entries(git.run(["ls-tree", "-r", "-z", commit]).await?);
            // 和 base 完全相同（同路徑同內容）的不算洩漏。
            if listed.iter().any(|e| !base_entries.contains(e)) {
                return Ok(Some(commit.to_owned()));
            }
        }
        Ok(None)
    }

    /// 信任紀錄用的 Repo 識別。
    pub fn repo_key(&self, repo: &DispatchRepo) -> String {
        repo_key(repo)
    }
}

/// 管理這台 Runner 上的所有 Worktree。
#[derive(Debug)]
pub struct WorktreeManager {
    home: Arc<RunnerHome>,
    /// 同一個 Repo 來源同時只能有一個 git 寫入操作（fetch、worktree add）。
    repo_locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl WorktreeManager {
    pub fn new(home: Arc<RunnerHome>) -> Self {
        Self {
            home,
            repo_locks: Mutex::new(HashMap::new()),
        }
    }

    pub fn root(&self) -> PathBuf {
        self.home.worktree_root()
    }

    /// Worktree 的路徑：`<root>/<repo>/<task-key>-<run-seq>`（§6.2）。
    pub fn path_for(
        &self,
        repo_name: &str,
        task_key: &str,
        run_seq: u32,
    ) -> Result<PathBuf, WorktreeError> {
        let repo = path_segment(repo_name, "Repo 名稱")?;
        let key = path_segment(task_key, "Task Key")?;
        Ok(paths::normalize(
            &self.root().join(repo).join(format!("{key}-{run_seq}")),
        ))
    }

    /// 同一個 Repo 來源的 git 寫入操作（fetch、worktree add、本機合併、Repo Spec 提交）共用的鎖。
    pub fn repo_lock(&self, source: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .repo_locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks.entry(source.to_owned()).or_default().clone()
    }

    /// Repo 來源：Member 的 checkout，或 Runner 自己的 clone（必要時先 clone）。
    /// 本機 Repo 只依 `runner.toml` 的 `[repos.<名稱>]` 找 checkout，不 clone。
    async fn source(&self, repo: &DispatchRepo) -> Result<(PathBuf, bool), WorktreeError> {
        let mapped = match repo.clone_url() {
            Some(clone_url) => self.home.settings().repo_checkout(clone_url, repo.name()),
            None => self.home.settings().local_checkout(repo.name()),
        };
        if repo.clone_url().is_none() && mapped.is_none() {
            return Err(WorktreeError::worktree(format!(
                "runner.toml 中沒有本機 Repo {} 的對應（[repos.{}]）",
                repo.name(),
                repo.name()
            )));
        }
        if let Some(path) = mapped {
            let path = paths::normalize(path);
            if paths::is_wsl_unc(&path) {
                return Err(WorktreeError::worktree(wsl_unc_message(
                    &format!("runner.toml 中 {} 對應的 checkout", repo.name()),
                    &path,
                )));
            }
            if !path.join(".git").exists() {
                return Err(WorktreeError::worktree(format!(
                    "runner.toml 中 {} 對應的 {} 不是 git checkout",
                    repo.name(),
                    path.display()
                )));
            }
            return Ok((path, true));
        }
        let repo_dir = self.root().join(path_segment(repo.name(), "Repo 名稱")?);
        let clone = repo_dir.join(MANAGED_CLONE_DIR);
        if !clone.join(".git").exists() {
            std::fs::create_dir_all(&repo_dir).map_err(|e| {
                WorktreeError::worktree(format!("無法建立 {}：{e}", repo_dir.display()))
            })?;
            let lock = self.repo_lock(&clone);
            let _guard = lock.lock().await;
            if !clone.join(".git").exists() {
                Git::new(&repo_dir)
                    .run([
                        "clone",
                        "--no-checkout",
                        "--",
                        repo.clone_url().unwrap_or_default(),
                        MANAGED_CLONE_DIR,
                    ])
                    .await?;
            }
        }
        Ok((paths::normalize(&clone), false))
    }

    /// 執行 §6.2 建立流程的 1–5 步（不含信任核准與 setup）。
    pub async fn create(&self, req: &WorktreeRequest) -> Result<Worktree, WorktreeError> {
        let path = match &req.path {
            Some(path) => {
                // 只沿用 Worktree 根目錄之下的路徑（本機紀錄被改過時不會跑到別的地方）。
                if !paths::is_within(
                    &paths::canonical(path),
                    &paths::canonical(&self.home.worktree_root()),
                ) {
                    return Err(WorktreeError::worktree(format!(
                        "要沿用的 Worktree 不在 Worktree 根目錄之下：{}",
                        path.display()
                    )));
                }
                path.clone()
            }
            None => self.path_for(req.repo.name(), &req.task_key, req.run_seq)?,
        };
        validate_request(req).await?;
        if paths::is_wsl_unc(&path) {
            return Err(WorktreeError::worktree(wsl_unc_message(
                "Worktree 根目錄",
                &path,
            )));
        }
        if paths::running_in_wsl() && paths::is_wsl_windows_mount(&path) {
            return Err(WorktreeError::worktree(format!(
                "git 跑在 WSL 中時 Worktree 不可以放在 Windows 磁碟上：{}",
                path.display()
            )));
        }
        let (source, member_checkout) = self.source(&req.repo).await?;
        let git = Git::new(&source);
        let lock = self.repo_lock(&source);
        let _guard = lock.lock().await;

        // 本機 Repo 不 fetch remote：Worktree 從本機的基準分支開出。
        if repo_is_github(&req.repo) {
            git.run(["fetch", "--prune", "origin"]).await?;
        }
        let (base_commit, config_commit) = match &req.base {
            Some(base) => (
                git.rev_parse_commit(&base.commit).await?,
                git.rev_parse_commit(&base.config_commit).await?,
            ),
            None => {
                let commit = git.rev_parse_commit(req.repo.base_ref()).await?;
                (commit.clone(), commit)
            }
        };
        let config_text = git
            .show_file(&config_commit, &repo_config::config_path())
            .await?
            .unwrap_or_default();
        let config = LoadedConfig::parse(&config_text).map_err(|e| {
            WorktreeError::new(
                RunErrorCode::SetupFailed,
                format!("{} 的格式不正確：{e}", repo_config::config_path()),
            )
        })?;

        let reuse = path.join(".git").exists();
        let mut remote_alignment = RemoteAlignment::UpToDate;
        if reuse {
            tracing::info!(path = %path.display(), "Worktree 已存在，沿用");
            if let Some(branch) = &req.branch {
                remote_alignment = align_with_remote(&Git::new(&path), branch).await?;
            }
        } else {
            git.run(["worktree", "prune"]).await?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    WorktreeError::worktree(format!("無法建立 {}：{e}", parent.display()))
                })?;
            }
            let path_arg = path.to_string_lossy().into_owned();
            match &req.branch {
                Some(branch) => {
                    let exists = git
                        .succeeds([
                            "rev-parse",
                            "--verify",
                            "--quiet",
                            &format!("refs/heads/{branch}"),
                        ])
                        .await;
                    let remote = format!("refs/remotes/origin/{branch}");
                    if exists {
                        git.run(["worktree", "add", "--", &path_arg, branch])
                            .await?;
                    } else if req.path.is_some()
                        && git
                            .succeeds(["rev-parse", "--verify", "--quiet", &remote])
                            .await
                    {
                        // 要沿用的 Worktree 已經不在、本機也沒有分支：從 remote 的分支重建（§5.2）。
                        git.run(["worktree", "add", "-b", branch, "--", &path_arg, &remote])
                            .await?;
                    } else {
                        git.run([
                            "worktree",
                            "add",
                            "-b",
                            branch,
                            "--",
                            &path_arg,
                            &base_commit,
                        ])
                        .await?;
                    }
                }
                None => {
                    git.run(["worktree", "add", "--detach", "--", &path_arg, &base_commit])
                        .await?;
                }
            }
        }
        let path = paths::canonical(&path);
        let port = self
            .home
            .allocate_port(&path)
            .map_err(|e| WorktreeError::worktree(format!("{e:#}")))?;
        let scripts_approved = config.scripts().is_empty()
            || self
                .home
                .is_trusted(&repo_key(&req.repo), &config.hash)
                .map_err(|e| WorktreeError::worktree(format!("{e:#}")))?;
        Ok(Worktree {
            scripts_approved,
            remote_alignment,
            path,
            root_checkout: source,
            member_checkout,
            branch: req.branch.clone(),
            base_commit,
            base_ref: req.repo.base_ref().to_owned(),
            default_branch: req.repo.default_branch().to_owned(),
            config_commit,
            config,
            port,
            run_id: req.run_id.clone(),
            task_key: req.task_key.clone(),
        })
    }

    /// §6.2 第 3、4 步：`shared_dirs` 建立連結、`copy` 複製檔案。
    /// 回傳複製進來的 dotenv 檔內容，供遮蔽 secret 使用。
    pub fn link_and_copy(&self, wt: &Worktree) -> Result<Vec<String>, WorktreeError> {
        for raw in &wt.config.config.worktree.shared_dirs {
            let rel = repo_config::literal_relative_path(raw).map_err(|e| {
                WorktreeError::new(RunErrorCode::SetupFailed, format!("shared_dirs：{e}"))
            })?;
            let source = wt.root_checkout.join(&rel);
            let target = wt.path.join(&rel);
            std::fs::create_dir_all(&source).map_err(|e| {
                WorktreeError::worktree(format!("無法建立共用目錄 {}：{e}", source.display()))
            })?;
            if target.exists() {
                tracing::warn!(target = %target.display(), "共用目錄的位置已經存在，略過");
                continue;
            }
            link_dir(&source, &target)?;
        }
        let mut dotenv = Vec::new();
        if !wt.config.config.worktree.copy.is_empty() && !wt.member_checkout {
            tracing::info!("沒有對應的本機 checkout，copy 不生效");
            return Ok(dotenv);
        }
        for raw in &wt.config.config.worktree.copy {
            let rel = repo_config::literal_relative_path(raw)
                .map_err(|e| WorktreeError::new(RunErrorCode::SetupFailed, format!("copy：{e}")))?;
            let source = wt.root_checkout.join(&rel);
            if !source.is_file() {
                tracing::info!(file = %source.display(), "copy 的來源不存在，略過");
                continue;
            }
            let target = wt.path.join(&rel);
            // 不跟著 symlink／junction 讀寫：來源要真的在 checkout 內，目標要真的在 Worktree 內。
            let source_is_link =
                std::fs::symlink_metadata(&source).is_ok_and(|m| m.file_type().is_symlink());
            let target_is_link =
                std::fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink());
            if source_is_link
                || target_is_link
                || !paths::is_within(
                    &paths::resolve_existing(&source),
                    &paths::canonical(&wt.root_checkout),
                )
                || !paths::is_within(
                    &paths::resolve_existing(&target),
                    &paths::canonical(&wt.path),
                )
            {
                return Err(WorktreeError::new(
                    RunErrorCode::SetupFailed,
                    format!("copy：{raw} 經由連結指向 checkout 或 Worktree 以外，拒絕複製"),
                ));
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    WorktreeError::worktree(format!("無法建立 {}：{e}", parent.display()))
                })?;
            }
            std::fs::copy(&source, &target).map_err(|e| {
                WorktreeError::worktree(format!("無法複製 {}：{e}", source.display()))
            })?;
            let is_dotenv = Path::new(&rel)
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with(".env"));
            if is_dotenv && let Ok(text) = std::fs::read_to_string(&target) {
                dotenv.push(text);
            }
        }
        Ok(dotenv)
    }

    /// 執行 setup（§6.3）。沒有設定 setup 時回傳 `None`。
    pub async fn run_setup(&self, wt: &Worktree) -> Result<Option<Output>, WorktreeError> {
        let Some(script) = wt
            .config
            .config
            .worktree
            .setup
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        else {
            return Ok(None);
        };
        if !wt.scripts_approved {
            return Err(WorktreeError::new(
                RunErrorCode::SetupFailed,
                "setup 腳本尚未核准，不執行",
            ));
        }
        let spec = Shell::script(script, wt.env())
            .cwd(&wt.path)
            .unattended_git();
        let output = process::run(&spec)
            .await
            .map_err(|e| WorktreeError::new(RunErrorCode::SetupFailed, format!("{e:#}")))?;
        Ok(Some(output))
    }

    /// 刪除 Worktree（§6.2 刪除保護）。
    ///
    /// - 拒絕刪除 Worktree 根目錄以外、家目錄、Repo 來源本身。
    /// - `archive` hook 失敗時擋下刪除。
    /// - 分支上還有未合併的 commit 時保留分支。
    pub async fn remove(&self, wt: &Worktree) -> Result<Removal, WorktreeError> {
        // 一律比較解開 symlink 後的路徑（macOS 的 /var → /private/var、Windows 的 8.3 短檔名）。
        let path = paths::canonical(&wt.path);
        let root = paths::canonical(&self.root());
        let home = paths::canonical(self.home.user_home());
        let refuse = |why: &str| {
            Err(WorktreeError::worktree(format!(
                "拒絕刪除 {}：{why}",
                path.display()
            )))
        };
        if !paths::is_within(&path, &root) || paths::same_path(&path, &root) {
            return refuse("不在 Worktree 根目錄之內");
        }
        if paths::is_within(&home, &path) {
            return refuse("是家目錄或包含家目錄");
        }
        if paths::is_within(&paths::canonical(&wt.root_checkout), &path) {
            return refuse("是 Repo 來源本身");
        }
        // 至少要是 <root>/<repo>/<name> 這一層。
        if path.components().count() < root.components().count() + 2 {
            return refuse("不是 Run 的 Worktree 目錄");
        }

        if let Some(script) = wt
            .config
            .config
            .worktree
            .archive
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            if !wt.scripts_approved {
                return Err(WorktreeError::worktree(
                    "archive 腳本尚未核准，無法執行，已擋下刪除",
                ));
            }
            let spec = Shell::script(script, wt.env()).cwd(&path).unattended_git();
            let output = process::run(&spec)
                .await
                .map_err(|e| WorktreeError::worktree(format!("{e:#}")))?;
            if !output.success() {
                return Err(WorktreeError::worktree(format!(
                    "archive 失敗，已擋下刪除：{}",
                    output.combined()
                )));
            }
        }

        let source = Git::new(&wt.root_checkout);
        remove_worktree_dir(&source, &path).await?;
        let mut branch_kept = false;
        if let Some(branch) = &wt.branch {
            let unmerged = source
                .run(["rev-list", "--count", &format!("{}..{branch}", wt.base_ref)])
                .await
                .ok()
                .and_then(|n| n.trim().parse::<u64>().ok())
                .unwrap_or(1);
            if unmerged > 0 {
                branch_kept = true;
            } else {
                source.run(["branch", "-D", branch]).await?;
            }
        }
        self.home
            .release_port(&path)
            .map_err(|e| WorktreeError::worktree(format!("{e:#}")))?;
        Ok(Removal { branch_kept })
    }
}

/// 刪除 Worktree 目錄時每次失敗後等待的時間（合計約 8 秒）：防毒軟體或索引服務掃描時會短暫鎖住
/// 剛寫入的檔案，Windows 上刪除會以「被另一個程序使用」或「拒絕存取」失敗。
pub const REMOVE_RETRY_DELAYS: [Duration; 5] = [
    Duration::from_millis(200),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
/// 前幾次用 `git worktree remove`，之後改用直接刪目錄（git 刪一半失敗後目錄已經不是完整的 Worktree）。
const GIT_REMOVE_ATTEMPTS: usize = 2;

/// 刪除 Worktree 目錄並從 git 的 Worktree 清單移除，被鎖住時重試（[`REMOVE_RETRY_DELAYS`]）。
async fn remove_worktree_dir(source: &Git, path: &Path) -> Result<(), WorktreeError> {
    let path_arg = path.to_string_lossy().into_owned();
    let mut last_error = String::new();
    for attempt in 0..=REMOVE_RETRY_DELAYS.len() {
        let result = if attempt < GIT_REMOVE_ATTEMPTS {
            source
                .run(["worktree", "remove", "--force", &path_arg])
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        } else {
            match std::fs::remove_dir_all(path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("刪除 {} 失敗：{e}", path.display())),
            }
        };
        match result {
            Ok(()) if !path.exists() => {
                // 直接刪目錄之後要讓 git 忘掉這個 Worktree；git 自己刪成功時 prune 也無害。
                source.run(["worktree", "prune"]).await?;
                if attempt > 0 {
                    tracing::info!(path = %path.display(), attempt, "Worktree 重試後刪除成功");
                }
                return Ok(());
            }
            Ok(()) => last_error = "指令成功但目錄還在".into(),
            Err(e) => last_error = e,
        }
        if let Some(delay) = REMOVE_RETRY_DELAYS.get(attempt) {
            tracing::warn!(
                path = %path.display(),
                attempt,
                error = %last_error,
                "刪除 Worktree 失敗，稍後重試（檔案可能被防毒軟體或索引服務鎖住）"
            );
            tokio::time::sleep(*delay).await;
        }
    }
    Err(WorktreeError::worktree(format!(
        "刪除 {} 失敗（已重試 {} 次，檔案可能被防毒軟體、索引服務或開著的程式鎖住）：{last_error}",
        path.display(),
        REMOVE_RETRY_DELAYS.len()
    )))
}

/// Repo 或 Worktree 放在 WSL 檔案系統時的錯誤訊息（§6.4）。
fn wsl_unc_message(what: &str, path: &Path) -> String {
    format!(
        "{what} {} 在 WSL 的檔案系統中（\\\\wsl$），Windows 上的 Runner 不支援：請把 Repo clone 到 Windows 磁碟（例如 D:\\code），或改在 WSL 中執行 Runner",
        path.display()
    )
}

/// 刪除的結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Removal {
    /// 分支上有未合併的 commit，保留下來（UI 顯示為「保留的分支」）。
    pub branch_kept: bool,
}

/// 沿用的 Worktree 在 `git fetch` 之後把本機分支對齊 `origin/<branch>`（§5.2）：
/// 遠端是本機的後代時 fast-forward；分岔時不動，回報給 Run 放進 prompt。
async fn align_with_remote(git: &Git, branch: &str) -> Result<RemoteAlignment, WorktreeError> {
    let remote_branch = format!("origin/{branch}");
    let remote_ref = format!("refs/remotes/{remote_branch}");
    if !git
        .succeeds(["rev-parse", "--verify", "--quiet", &remote_ref])
        .await
    {
        return Ok(RemoteAlignment::UpToDate);
    }
    let local = git.rev_parse_commit("HEAD").await?;
    let remote = git.rev_parse_commit(&remote_ref).await?;
    if local == remote {
        return Ok(RemoteAlignment::UpToDate);
    }
    let counts = git
        .run([
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{remote_ref}"),
        ])
        .await?;
    let mut parts = counts
        .split_whitespace()
        .map(|n| n.parse::<u64>().unwrap_or(0));
    let ahead = parts.next().unwrap_or(0);
    let behind = parts.next().unwrap_or(0);
    if behind == 0 {
        // 本機領先：push 時會 fast-forward。
        return Ok(RemoteAlignment::UpToDate);
    }
    let diverged = RemoteAlignment::Diverged {
        remote_branch: remote_branch.clone(),
        behind,
        ahead,
    };
    if ahead > 0 {
        tracing::warn!(branch, ahead, behind, "本機分支與遠端分岔，交給 Agent 整合");
        return Ok(diverged);
    }
    // 遠端是本機的後代：fast-forward。工作目錄有會被覆寫的變更時 git 會拒絕，這時也交給 Agent。
    match git.run(["merge", "--ff-only", &remote_ref]).await {
        Ok(_) => {
            tracing::info!(branch, from = %local, to = %remote, "本機分支已 fast-forward 到遠端");
            Ok(RemoteAlignment::FastForwarded {
                from: local,
                to: remote,
            })
        }
        Err(e) => {
            tracing::warn!(branch, error = %e, "無法 fast-forward 到遠端，交給 Agent 整合");
            Ok(diverged)
        }
    }
}

/// 檢查 DispatchOffer 中會成為 git 參數的值，避免被當成選項（參數注入）。
async fn validate_request(req: &WorktreeRequest) -> Result<(), WorktreeError> {
    let checks = [
        ("clone URL", req.repo.clone_url()),
        ("base ref", Some(req.repo.base_ref())),
        ("default branch", Some(req.repo.default_branch())),
    ];
    for (what, value) in checks.into_iter().filter_map(|(w, v)| v.map(|v| (w, v))) {
        if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
            return Err(WorktreeError::worktree(format!("{what} {value:?} 不合法")));
        }
    }
    if let Some(branch) = &req.branch {
        let valid = !branch.starts_with('-')
            && Git::new(".")
                .succeeds(["check-ref-format", "--branch", branch])
                .await;
        if !valid {
            return Err(WorktreeError::worktree(format!(
                "分支名稱 {branch:?} 不合法"
            )));
        }
    }
    Ok(())
}

/// 路徑中的一段：不可以含分隔字元、`..` 或 Windows 不允許的字元。
pub(crate) fn path_segment<'a>(raw: &'a str, what: &str) -> Result<&'a str, WorktreeError> {
    let bad = raw.is_empty()
        || raw == "."
        || raw == ".."
        || raw.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || raw.chars().any(char::is_control)
        || raw.ends_with(['.', ' ']);
    if bad {
        Err(WorktreeError::worktree(format!(
            "{what} {raw:?} 不能當作路徑的一部分"
        )))
    } else {
        Ok(raw)
    }
}

/// 建立目錄連結：Windows 優先 junction（不需要系統管理員權限），失敗才用 symlink。
fn link_dir(source: &Path, target: &Path) -> Result<(), WorktreeError> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| WorktreeError::worktree(format!("無法建立 {}：{e}", parent.display())))?;
    }
    #[cfg(windows)]
    {
        let junction = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(target)
            .arg(source)
            .output();
        if junction.as_ref().is_ok_and(|o| o.status.success()) {
            return Ok(());
        }
        tracing::warn!(?junction, "junction 建立失敗，改用 symlink");
        std::os::windows::fs::symlink_dir(source, target).map_err(|e| {
            WorktreeError::worktree(format!(
                "無法連結 {} → {}：{e}",
                target.display(),
                source.display()
            ))
        })
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, target).map_err(|e| {
            WorktreeError::worktree(format!(
                "無法連結 {} → {}：{e}",
                target.display(),
                source.display()
            ))
        })
    }
}

/// 信任紀錄與 Worktree 紀錄用的 Repo 識別：GitHub Repo 是 clone URL，本機 Repo 是 `local:<名稱>`。
pub fn repo_key(repo: &DispatchRepo) -> String {
    match repo {
        DispatchRepo::Github { clone_url, .. } => clone_url.clone(),
        DispatchRepo::Local { name, .. } => format!("local:{name}"),
    }
}

fn repo_is_github(repo: &DispatchRepo) -> bool {
    repo.kind() == orbis_protocol::enums::RepoKind::Github
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 路徑片段不可以跳出目錄() {
        assert!(path_segment("web", "x").is_ok());
        assert!(path_segment("ORB-12", "x").is_ok());
        for bad in ["", "..", "a/b", r"a\b", "c:", "a*", "x.", "x "] {
            assert!(path_segment(bad, "x").is_err(), "{bad:?}");
        }
    }
}
