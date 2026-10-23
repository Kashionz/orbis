//! Runner 的本機目錄：給人編輯的設定檔與 Runner 自己的狀態目錄。
//!
//! ```text
//! ~/.orbis/                      （可用 --home 或環境變數 <前綴>HOME 覆寫）
//! ├── runner.toml                設定：Server 網址、Worktree 根目錄、Repo 對應、Agent Profile
//! └── runner/                    狀態（Runner 自己管理，不要手改）
//!     ├── credentials.json       Runner token（依 Server 網址分開）
//!     ├── ports.json             每個 Worktree 分到的 port
//!     ├── trust.json             `<CONFIG_DIR>/<CONFIG_FILE>` 腳本的信任核准紀錄
//!     ├── spool/                 尚未被 Server 確認的 Event 與 blob
//!     └── agents/                Runner 代管安裝的 ACP adapter
//! ```

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Context;
use orbis_protocol::ids::RunnerId;
use orbis_protocol::names;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use orbis_protocol::names::{RUNNER_CONFIG_FILE, RUNNER_STATE_DIR};

/// 預設的 port 範圍（含兩端）。
pub const DEFAULT_PORT_RANGE: (u16, u16) = (41000, 41999);

/// Runner 的本機目錄。
#[derive(Debug)]
pub struct RunnerHome {
    root: PathBuf,
    state_dir: PathBuf,
    user_home: PathBuf,
    settings: Settings,
    lock: Mutex<()>,
}

impl RunnerHome {
    /// 開啟（必要時建立）本機目錄並讀取設定檔。`root` 為 `None` 時用 `~/<CONFIG_DIR>`。
    pub fn open(root: Option<PathBuf>) -> anyhow::Result<Self> {
        Self::open_with(root, None)
    }

    /// 同 [`open`](Self::open)，`state_dir` 另外指定狀態目錄（[`names::ENV_RUNNER_STATE_DIR`]）；
    /// 設定檔仍從 `root` 讀取。
    pub fn open_with(root: Option<PathBuf>, state_dir: Option<PathBuf>) -> anyhow::Result<Self> {
        let user_home = user_home_dir().context("找不到家目錄")?;
        let root = root.unwrap_or_else(|| user_home.join(names::CONFIG_DIR));
        let state_dir = state_dir.unwrap_or_else(|| root.join(RUNNER_STATE_DIR));
        std::fs::create_dir_all(&state_dir)
            .with_context(|| format!("無法建立 {}", state_dir.display()))?;
        let settings = Settings::load(&root.join(RUNNER_CONFIG_FILE))?;
        Ok(Self {
            root,
            state_dir,
            user_home,
            settings,
            lock: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config_file(&self) -> PathBuf {
        self.root.join(RUNNER_CONFIG_FILE)
    }

    pub fn state_dir(&self) -> PathBuf {
        self.state_dir.clone()
    }

    pub fn spool_dir(&self) -> PathBuf {
        self.state_dir().join("spool")
    }

    pub fn agents_dir(&self) -> PathBuf {
        self.state_dir().join("agents")
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn user_home(&self) -> &Path {
        &self.user_home
    }

    /// Worktree 根目錄（§6.2）：設定檔優先，否則依平台的預設值。
    /// 在 WSL 中預設值或設定落在 `/mnt/<drive>` 時，改用家目錄下的預設位置。
    pub fn worktree_root(&self) -> PathBuf {
        let unix_default = || crate::paths::expand_home(names::WORKTREE_ROOT_UNIX, &self.user_home);
        let configured = self
            .settings
            .worktree_root
            .as_deref()
            .map(|raw| crate::paths::expand_home(raw, &self.user_home));
        let root = configured.unwrap_or_else(|| {
            if cfg!(windows) {
                PathBuf::from(names::WORKTREE_ROOT_WINDOWS)
            } else {
                unix_default()
            }
        });
        if crate::paths::running_in_wsl() && crate::paths::is_wsl_windows_mount(&root) {
            tracing::warn!(root = %root.display(), "WSL 中的 Worktree 不放在 Windows 磁碟上，改用預設位置");
            return unix_default();
        }
        crate::paths::normalize(&root)
    }

    fn read_json<T: DeserializeOwned + Default>(&self, name: &str) -> anyhow::Result<T> {
        let path = self.state_dir().join(name);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("{} 的內容不合法", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
            Err(e) => Err(e).with_context(|| format!("無法讀取 {}", path.display())),
        }
    }

    fn write_json<T: Serialize>(&self, name: &str, value: &T, private: bool) -> anyhow::Result<()> {
        let path = self.state_dir().join(name);
        write_atomic(
            &path,
            serde_json::to_string_pretty(value)?.as_bytes(),
            private,
        )
    }

    /// 這個 Server 的 Runner token（Pairing 完成後保存）。
    pub fn runner_token(&self, server_url: &str) -> anyhow::Result<Option<StoredToken>> {
        let _guard = lock(&self.lock);
        let all: BTreeMap<String, StoredToken> = self.read_json(CREDENTIALS_FILE)?;
        Ok(all.get(server_url).cloned())
    }

    pub fn save_runner_token(&self, server_url: &str, token: StoredToken) -> anyhow::Result<()> {
        let _guard = lock(&self.lock);
        let mut all: BTreeMap<String, StoredToken> = self.read_json(CREDENTIALS_FILE)?;
        all.insert(server_url.to_owned(), token);
        self.write_json(CREDENTIALS_FILE, &all, true)
    }

    pub fn forget_runner_token(&self, server_url: &str) -> anyhow::Result<()> {
        let _guard = lock(&self.lock);
        let mut all: BTreeMap<String, StoredToken> = self.read_json(CREDENTIALS_FILE)?;
        if all.remove(server_url).is_some() {
            self.write_json(CREDENTIALS_FILE, &all, true)?;
        }
        Ok(())
    }

    /// 這個 Worktree 的 port（§6.3）：已分配過就沿用，否則從範圍中挑一個目前沒被占用的。
    pub fn allocate_port(&self, worktree: &Path) -> anyhow::Result<u16> {
        let _guard = lock(&self.lock);
        let mut ports: BTreeMap<String, u16> = self.read_json(PORTS_FILE)?;
        let key = worktree.to_string_lossy().into_owned();
        if let Some(port) = ports.get(&key) {
            return Ok(*port);
        }
        let taken: BTreeSet<u16> = ports.values().copied().collect();
        let (low, high) = self.settings.port_range.unwrap_or(DEFAULT_PORT_RANGE);
        let port = (low..=high)
            .find(|port| !taken.contains(port) && port_is_free(*port))
            .with_context(|| format!("port 範圍 {low}–{high} 已經用完"))?;
        ports.insert(key, port);
        self.write_json(PORTS_FILE, &ports, false)?;
        Ok(port)
    }

    pub fn release_port(&self, worktree: &Path) -> anyhow::Result<()> {
        let _guard = lock(&self.lock);
        let mut ports: BTreeMap<String, u16> = self.read_json(PORTS_FILE)?;
        if ports.remove(&*worktree.to_string_lossy()).is_some() {
            self.write_json(PORTS_FILE, &ports, false)?;
        }
        Ok(())
    }

    /// 這個 Repo 的 config.toml 內容（hash）是否已被核准「永遠允許」。
    pub fn is_trusted(&self, repo_key: &str, hash: &str) -> anyhow::Result<bool> {
        let _guard = lock(&self.lock);
        let trust: BTreeMap<String, BTreeSet<String>> = self.read_json(TRUST_FILE)?;
        Ok(trust
            .get(repo_key)
            .is_some_and(|hashes| hashes.contains(hash)))
    }

    pub fn trust(&self, repo_key: &str, hash: &str) -> anyhow::Result<()> {
        let _guard = lock(&self.lock);
        let mut trust: BTreeMap<String, BTreeSet<String>> = self.read_json(TRUST_FILE)?;
        trust
            .entry(repo_key.to_owned())
            .or_default()
            .insert(hash.to_owned());
        self.write_json(TRUST_FILE, &trust, false)
    }
}

const CREDENTIALS_FILE: &str = "credentials.json";
const PORTS_FILE: &str = "ports.json";
const TRUST_FILE: &str = "trust.json";

fn lock(mutex: &Mutex<()>) -> std::sync::MutexGuard<'_, ()> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// 保存的 Runner token。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredToken {
    pub runner_id: RunnerId,
    pub token: String,
}

/// IPv4 與 IPv6 的 loopback 都要沒被占用：dev server 常綁 `localhost`（Linux 上 Node 先解析成 `::1`）
/// 或不指定 host（`::`，雙堆疊）。只查 127.0.0.1 時，`::1` 上 client 連線（含 TIME_WAIT）用掉的
/// port 會被當成空閒；Linux 的 ephemeral 範圍（32768–60999）又包含預設的 port 範圍。
/// 不 bind 萬用位址，避免 Windows 防火牆跳出允許存取的對話框。
fn port_is_free(port: u16) -> bool {
    use std::io::ErrorKind;
    use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};

    if TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_err() {
        return false;
    }
    // 沒有 IPv6 時略過；Windows 的保留範圍回 PermissionDenied
    match TcpListener::bind((Ipv6Addr::LOCALHOST, port)) {
        Ok(_) => true,
        Err(e) => !matches!(e.kind(), ErrorKind::AddrInUse | ErrorKind::PermissionDenied),
    }
}

/// 先寫到暫存檔再改名，避免寫到一半當掉留下壞掉的檔案。`private` 時 Unix 上權限設為 0600。
pub fn write_atomic(path: &Path, bytes: &[u8], private: bool) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes).with_context(|| format!("無法寫入 {}", tmp.display()))?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = private;
    std::fs::rename(&tmp, path).with_context(|| format!("無法寫入 {}", path.display()))
}

fn user_home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// `runner.toml` 的內容。所有欄位都是選填。
///
/// ```toml
/// server = "https://orbis.example.com"
/// name = "my-laptop"
/// worktree_root = "D:\\ob"
/// port_range = [41000, 41999]
///
/// # Repo 對應到本機的 checkout（key 是 clone URL 或 Repo 名稱）
/// [repos."https://github.com/acme/web.git"]
/// path = "D:\\code\\web"
///
/// # 加入一般的 ACP Agent，或覆寫內建 Agent Profile 的啟動指令
/// [agents.my-agent]
/// command = "my-agent-acp"
/// args = ["--stdio"]
/// env = { MY_AGENT_LOG = "debug" }
/// ```
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub server: Option<String>,
    pub name: Option<String>,
    pub worktree_root: Option<String>,
    pub port_range: Option<(u16, u16)>,
    #[serde(default)]
    pub repos: HashMap<String, RepoSettings>,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentSettings>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepoSettings {
    /// Member 自己的 checkout。Worktree 從這裡開出，`copy` 也從這裡複製。
    pub path: PathBuf,
}

/// 一個 Agent 的啟動設定。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSettings {
    pub command: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 每組 Credential 的並行上限，預設 30。
    pub max_concurrent_runs: Option<u32>,
    /// 只對內建的 Claude Code 有效：是否載入使用者全域的 Claude 設定（`~/.claude/settings.json`
    /// 的 allow 規則、plugin、hooks 等）。預設 `false`：Run 中只載入 Repo 的設定（ARCHITECTURE §8）。
    pub user_settings: Option<bool>,
}

impl Settings {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                Self::parse(&text).with_context(|| format!("{} 的內容不合法", path.display()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e).with_context(|| format!("無法讀取 {}", path.display())),
        }
    }

    pub fn parse(text: &str) -> anyhow::Result<Self> {
        let settings: Self = toml::from_str(text)?;
        if let Some((low, high)) = settings.port_range
            && (low == 0 || low > high)
        {
            anyhow::bail!("port_range 必須是 [最小值, 最大值]，而且最小值大於 0");
        }
        Ok(settings)
    }

    /// Repo 對應的本機 checkout：先比對 clone URL，再比對名稱。
    pub fn repo_checkout(&self, clone_url: &str, name: &str) -> Option<&Path> {
        self.repos
            .get(clone_url)
            .or_else(|| self.repos.get(name))
            .map(|repo| repo.path.as_path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> (tempfile::TempDir, RunnerHome) {
        let dir = tempfile::Builder::new()
            .prefix("orbis home ")
            .tempdir()
            .unwrap();
        let home = RunnerHome::open(Some(dir.path().join("h"))).unwrap();
        (dir, home)
    }

    #[test]
    fn runner_token_依_server_分開保存() {
        let (_dir, home) = temp_home();
        assert_eq!(home.runner_token("ws://a/runner").unwrap(), None);
        let token = StoredToken {
            runner_id: "r1".into(),
            token: "rt_1".into(),
        };
        home.save_runner_token("ws://a/runner", token.clone())
            .unwrap();
        assert_eq!(home.runner_token("ws://a/runner").unwrap(), Some(token));
        assert_eq!(home.runner_token("ws://b/runner").unwrap(), None);
        home.forget_runner_token("ws://a/runner").unwrap();
        assert_eq!(home.runner_token("ws://a/runner").unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn credentials_只有自己可以讀() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, home) = temp_home();
        home.save_runner_token(
            "ws://a/runner",
            StoredToken {
                runner_id: "r".into(),
                token: "t".into(),
            },
        )
        .unwrap();
        let mode = std::fs::metadata(home.state_dir().join(CREDENTIALS_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn 每個_worktree_固定一個不重複的_port() {
        let (_dir, home) = temp_home();
        let a = home.allocate_port(Path::new("/wt/a")).unwrap();
        let b = home.allocate_port(Path::new("/wt/b")).unwrap();
        assert_ne!(a, b);
        assert_eq!(home.allocate_port(Path::new("/wt/a")).unwrap(), a);
        assert!((DEFAULT_PORT_RANGE.0..=DEFAULT_PORT_RANGE.1).contains(&a));
        home.release_port(Path::new("/wt/a")).unwrap();
    }

    #[test]
    fn 被占用的_port_會跳過() {
        let dir = tempfile::Builder::new()
            .prefix("orbis home ")
            .tempdir()
            .unwrap();
        let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = busy.local_addr().unwrap().port();
        let root = dir.path().join("h");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(RUNNER_CONFIG_FILE),
            format!("port_range = [{port}, {}]\n", port.saturating_add(20)),
        )
        .unwrap();
        let home = RunnerHome::open(Some(root)).unwrap();
        let allocated = home.allocate_port(Path::new("/wt/a")).unwrap();
        assert_ne!(allocated, port);
    }

    #[test]
    fn 只在_ipv6_loopback_被占用的_port_也會跳過() {
        // dev server 綁 `::1` 時會和這個 port 衝突，即使 127.0.0.1 可以 bind
        let Ok(busy) = std::net::TcpListener::bind("[::1]:0") else {
            eprintln!("沒有 IPv6 loopback，略過");
            return;
        };
        let port = busy.local_addr().unwrap().port();
        let dir = tempfile::Builder::new()
            .prefix("orbis home ")
            .tempdir()
            .unwrap();
        let root = dir.path().join("h");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(RUNNER_CONFIG_FILE),
            format!("port_range = [{port}, {}]\n", port.saturating_add(20)),
        )
        .unwrap();
        let home = RunnerHome::open(Some(root)).unwrap();
        let allocated = home.allocate_port(Path::new("/wt/a")).unwrap();
        assert_ne!(allocated, port);
    }

    #[test]
    fn 信任紀錄以_repo_與_hash_為單位() {
        let (_dir, home) = temp_home();
        assert!(!home.is_trusted("acme/web", "h1").unwrap());
        home.trust("acme/web", "h1").unwrap();
        assert!(home.is_trusted("acme/web", "h1").unwrap());
        assert!(!home.is_trusted("acme/web", "h2").unwrap());
        assert!(!home.is_trusted("acme/api", "h1").unwrap());
    }

    #[test]
    fn 解析設定檔() {
        let settings = Settings::parse(
            r#"
server = "http://localhost:4000"
worktree_root = "~/wt"
port_range = [5000, 5100]
[repos."https://github.com/acme/web.git"]
path = "/code/web"
[agents.fake]
command = "/bin/fake"
args = ["--script", "a.yaml"]
env = { A = "1" }
"#,
        )
        .unwrap();
        assert_eq!(settings.port_range, Some((5000, 5100)));
        assert_eq!(
            settings.repo_checkout("https://github.com/acme/web.git", "web"),
            Some(Path::new("/code/web"))
        );
        assert_eq!(settings.repo_checkout("x", "web"), None);
        assert_eq!(settings.agents["fake"].args, ["--script", "a.yaml"]);
        assert!(Settings::parse("port_range = [10, 5]\n").is_err());
        assert!(Settings::parse("unknown = 1\n").is_err());
    }

    #[test]
    fn worktree_根目錄可以覆寫() {
        let dir = tempfile::Builder::new()
            .prefix("orbis home ")
            .tempdir()
            .unwrap();
        let root = dir.path().join("h");
        std::fs::create_dir_all(&root).unwrap();
        let wt = dir.path().join("wt root");
        std::fs::write(
            root.join(RUNNER_CONFIG_FILE),
            format!("worktree_root = {:?}\n", wt.to_string_lossy()),
        )
        .unwrap();
        let home = RunnerHome::open(Some(root)).unwrap();
        assert_eq!(home.worktree_root(), crate::paths::normalize(&wt));
    }
}
