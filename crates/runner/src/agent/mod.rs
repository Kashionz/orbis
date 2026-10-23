//! Agent 整合（ARCHITECTURE §7、ADR-0002）。
//!
//! Runner 只有一個 [`acp::AcpAgentAdapter`]；各 Agent 的差異寫在 [`AgentProfile`] 中：
//! 啟動方式（含 Windows shim）、能力旗標、已知問題的修補、Permission Policy 的落差。

pub mod acp;
pub mod install;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{
    InitializeResponse, RequestPermissionRequest, ToolCallUpdate, ToolKind,
};
use orbis_protocol::availability::{AgentCapability, DEFAULT_MAX_CONCURRENT_RUNS};

use crate::home::{AgentSettings, Settings};
use crate::paths;
use crate::policy::PermissionSubject;
use crate::process::{self, ProcessSpec};

/// 內建 Claude Code profile 的 id（與 DispatchOffer 的 `agent` 相同）。
pub const CLAUDE_CODE: &str = "claude-code";

/// Claude Code 的 ACP adapter：npm 套件與鎖定的版本（ADR-0002：第三方 adapter 常有 regression）。
pub const CLAUDE_ACP_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";
pub const CLAUDE_ACP_VERSION: &str = "0.94.0";
/// 套件內的進入點（`package.json` 的 `bin`）。
pub const CLAUDE_ACP_ENTRY: &str = "dist/index.js";
/// claude-agent-acp 需要的最低 Node 主版本。
pub const CLAUDE_ACP_MIN_NODE: u32 = 22;

/// 內建 Codex profile 的 id。
pub const CODEX: &str = "codex";
/// Codex 的 ACP adapter（原本的 `@zed-industries/codex-acp` 已停更，改名到這裡），內附相容的
/// `@openai/codex`。版本鎖定（ADR-0002）。
pub const CODEX_ACP_PACKAGE: &str = "@agentclientprotocol/codex-acp";
pub const CODEX_ACP_VERSION: &str = "2.2.2";
const CODEX_ACP_ENTRY: &str = "dist/index.js";
/// `@openai/codex` 需要的最低 Node 主版本。
const CODEX_ACP_MIN_NODE: u32 = 20;

/// 內建 Gemini CLI profile 的 id。
pub const GEMINI: &str = "gemini";
/// Gemini CLI 本身就支援 ACP（`--acp`），由 Runner 代管安裝精確版本。
pub const GEMINI_PACKAGE: &str = "@google/gemini-cli";
pub const GEMINI_VERSION: &str = "0.65.0";
const GEMINI_ENTRY: &str = "bundle/gemini.js";
const GEMINI_MIN_NODE: u32 = 20;

/// 內建 Grok Build profile 的 id。
pub const GROK: &str = "grok";
/// Grok Build 由使用者自己安裝（原生安裝程式，無法代管）；這是測過的最低版本，
/// 偵測到更舊的版本時回報無法使用。
pub const GROK_MIN_VERSION: &str = "1.0.52";

/// Agent 的啟動方式。
#[derive(Debug, Clone, PartialEq)]
pub enum Launch {
    /// 直接執行指令（`.cmd` shim 由 [`process`] 解析）。
    Command {
        command: PathBuf,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    /// Runner 代管安裝的 npm 套件，以 `node <entry> <args>` 啟動（不經過 npx 與 shim）。
    ManagedNpm {
        package: &'static str,
        version: &'static str,
        entry: &'static str,
        args: &'static [&'static str],
        /// 固定加上的環境變數。
        env: &'static [(&'static str, &'static str)],
        min_node: u32,
        /// 套件內附、由套件再啟動的原生執行檔。
        native: Option<NativeBinary>,
    },
}

/// npm 套件內附的原生執行檔（例如 Claude Agent SDK 的 `claude.exe`）。
///
/// Windows 上安裝路徑可能超過 `MAX_PATH`（`--home` 或 Desktop 的狀態目錄很深時），
/// 套件用 Node 的 spawn 啟動它會回報找不到檔案；這時 Runner 以 `env` 指定的環境變數
/// 傳入帶 `\\?\` 前綴的路徑（[`paths::spawnable`](crate::paths::spawnable)）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeBinary {
    /// 套件接受的「執行檔路徑」環境變數。
    pub env: &'static str,
    /// 平台套件名稱的前綴，後面接 `<os>-<arch>`，例如 `@anthropic-ai/claude-agent-sdk-`。
    pub platform_package_prefix: &'static str,
    /// 平台套件內的執行檔位置（Windows）：npm 的 arch（`x64`、`arm64`）→ 以 `/` 分隔的相對路徑。
    pub windows_files: &'static [(&'static str, &'static str)],
}

impl NativeBinary {
    /// Windows 上平台套件內的執行檔位置；其他平台沒有路徑長度問題，回傳 `None`。
    fn windows_path(&self, node_modules: &Path) -> Option<PathBuf> {
        if !cfg!(windows) {
            return None;
        }
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => return None,
        };
        let (_, file) = self.windows_files.iter().find(|(a, _)| *a == arch)?;
        let mut path = node_modules.to_owned();
        for part in format!("{}win32-{arch}", self.platform_package_prefix).split('/') {
            path.push(part);
        }
        for part in file.split('/') {
            path.push(part);
        }
        Some(path)
    }
}

/// Claude Agent SDK 內附的 Claude Code 原生執行檔。
const CLAUDE_NATIVE: NativeBinary = NativeBinary {
    env: "CLAUDE_CODE_EXECUTABLE",
    platform_package_prefix: "@anthropic-ai/claude-agent-sdk-",
    windows_files: &[("x64", "claude.exe"), ("arm64", "claude.exe")],
};

/// codex-acp 內附的 `@openai/codex` 原生執行檔（adapter 接受 `CODEX_PATH`）。
const CODEX_NATIVE: NativeBinary = NativeBinary {
    env: "CODEX_PATH",
    platform_package_prefix: "@openai/codex-",
    windows_files: &[
        ("x64", "vendor/x86_64-pc-windows-msvc/bin/codex.exe"),
        ("arm64", "vendor/aarch64-pc-windows-msvc/bin/codex.exe"),
    ],
};

/// 一個 Agent 的接入設定。
#[derive(Debug, Clone, PartialEq)]
pub struct AgentProfile {
    pub id: String,
    pub launch: Launch,
    /// 建立 session 後要切換到的 session mode（修補使用者設定的 bypass／acceptEdits 預設模式）。
    pub session_mode: Option<&'static str>,
    /// 建立（或接續）session 時放在 `_meta` 的內容（Agent 專屬的選項）。
    pub session_meta: Option<serde_json::Map<String, serde_json::Value>>,
    /// Agent 自己的設定（相對於 Worktree，`/` 分隔；以 `/` 結尾的是整個目錄）。修改它們可能讓
    /// Agent 繞過 Permission Policy，`auto` 下寫入一律問人；和已接受的內容比對，有差異就先問人。
    pub protected_paths: Vec<String>,
    /// 在 Permission Policy 下無法攔截的操作（ADR-0006），會回報給 Server 讓 UI 顯示。
    pub permission_gaps: Vec<String>,
    /// 已知的功能落差（PR 說明與 UI 用）。
    pub known_issues: Vec<String>,
    /// 是否會回報 token 用量（ACP `usage_update`）。
    pub reports_usage: bool,
    /// 使用的 Credential 標籤與並行上限（§7）。
    pub credential: String,
    pub max_concurrent_runs: u32,
    /// 測過的最低版本（使用者自己安裝的 CLI）。偵測到更舊的版本時回報無法使用；
    /// runner.toml 覆寫啟動指令時不檢查。
    pub min_version: Option<&'static str>,
}

/// Claude Code 在 Run 中載入的設定來源（claude-agent-acp 的 `_meta.claudeCode.options.settingSources`，
/// 預設是 `user`、`project`、`local`）。不載入 `user`：使用者全域的 allow 規則、plugin 與 MCP、hooks
/// 都不會出現在 Run 中（issue #55、ARCHITECTURE §8）。登入不受影響（憑證不在設定檔中）。
const CLAUDE_ISOLATED_SETTING_SOURCES: [&str; 2] = ["project", "local"];

/// Claude Code 的 Permission Policy 落差：設定中 allow 的工具不會詢問 Runner。
fn claude_settings_gap(user_settings: bool) -> String {
    if user_settings {
        "Claude 自己的設定（~/.claude/settings.json、Repo 的 .claude/settings*.json）中 allow 的工具不會詢問 Runner".into()
    } else {
        "Repo 的 .claude/settings*.json 中 allow 的工具不會詢問 Runner（使用者全域的 ~/.claude 設定在 Run 中不載入）".into()
    }
}

impl AgentProfile {
    /// 內建的 Claude Code profile（不載入使用者全域設定）。
    pub fn claude_code() -> Self {
        Self::claude_code_with(false)
    }

    /// 內建的 Claude Code profile。`user_settings` 為 `true` 時載入使用者全域的 Claude 設定
    /// （runner.toml 的 `[agents.claude-code] user_settings = true`）。
    pub fn claude_code_with(user_settings: bool) -> Self {
        let session_meta = (!user_settings).then(|| {
            let meta = serde_json::json!({
                "claudeCode": { "options": { "settingSources": CLAUDE_ISOLATED_SETTING_SOURCES } }
            });
            match meta {
                serde_json::Value::Object(map) => map,
                _ => unreachable!("字面值是物件"),
            }
        });
        Self {
            id: CLAUDE_CODE.into(),
            launch: Launch::ManagedNpm {
                package: CLAUDE_ACP_PACKAGE,
                version: CLAUDE_ACP_VERSION,
                entry: CLAUDE_ACP_ENTRY,
                args: &[],
                env: &[],
                min_node: CLAUDE_ACP_MIN_NODE,
                native: Some(CLAUDE_NATIVE),
            },
            // 使用者的 `permissions.defaultMode` 可能是 acceptEdits 或 bypassPermissions；
            // 一律切回會詢問的 default 模式（ADR-0006：不使用 bypass）。
            session_mode: Some("default"),
            session_meta,
            protected_paths: vec![
                ".claude/settings.json".into(),
                ".claude/settings.local.json".into(),
                // 專案層級的 MCP server 設定。
                ".mcp.json".into(),
            ],
            permission_gaps: vec![
                claude_settings_gap(user_settings),
                "manual 政策攔不到 Worktree 內的讀取（Claude Code 讀取工作目錄內的檔案不會請求權限）".into(),
                "寫入 .claude/settings.json 與 .claude/settings.local.json 在 auto 政策下一律問人；Worktree 中這兩個檔案和 base commit 不同時，啟動 session 前會先問人".into(),
            ],
            known_issues: vec![
                "plan mode 與 bypassPermissions 有已知 bug（Planning 在 A2 處理）".into(),
                "Runner 沒有宣告 ACP fs／terminal 能力，指令輸出以文字內容回報，不是 terminal 內容".into(),
            ],
            reports_usage: true,
            credential: format!("{CLAUDE_CODE}-local"),
            max_concurrent_runs: DEFAULT_MAX_CONCURRENT_RUNS,
            min_version: None,
        }
    }

    /// 內建的 Codex profile（codex-acp adapter）。
    ///
    /// - 一開始就以 `read-only` 模式建立 session，建立後也切到這個模式：修改檔案與連網都要先問，
    ///   權限請求由 Runner 依 Permission Policy 回覆（ADR-0006）。預設的 `agent` 模式會自動核准。
    /// - 登入沿用使用者自己的 `~/.codex`（`codex login`）。
    pub fn codex() -> Self {
        Self {
            id: CODEX.into(),
            launch: Launch::ManagedNpm {
                package: CODEX_ACP_PACKAGE,
                version: CODEX_ACP_VERSION,
                entry: CODEX_ACP_ENTRY,
                args: &[],
                env: &[("INITIAL_AGENT_MODE", "read-only"), ("NO_BROWSER", "1")],
                min_node: CODEX_ACP_MIN_NODE,
                native: Some(CODEX_NATIVE),
            },
            session_mode: Some("read-only"),
            session_meta: None,
            protected_paths: vec![".codex/".into()],
            permission_gaps: vec![
                "read-only 模式下，Codex 在自己的沙盒中直接執行它認為唯讀的指令（含讀取 Worktree 以外的檔案），不會詢問 Runner".into(),
                "Codex 自己的設定與規則（~/.codex/config.toml、~/.codex/rules）中允許的指令不會詢問 Runner".into(),
            ],
            known_issues: vec![
                "CODEX_PATH 含空白時 adapter 無法啟動 Codex；Runner 只在內附執行檔的路徑超過 MAX_PATH 時才設定它".into(),
                "Windows 上 Codex 的沙盒仍是實驗性功能".into(),
                "需要先在本機執行 codex login；未登入時 session/new 會失敗".into(),
            ],
            reports_usage: true,
            credential: format!("{CODEX}-local"),
            max_concurrent_runs: DEFAULT_MAX_CONCURRENT_RUNS,
            min_version: None,
        }
    }

    /// 內建的 Gemini CLI profile（原生 ACP：`gemini --acp`）。
    ///
    /// - 以 `default` 審核模式啟動（每個工具都先問），不使用 `--yolo`／`auto_edit`。
    /// - 登入沿用使用者自己的 `~/.gemini`。
    pub fn gemini() -> Self {
        Self {
            id: GEMINI.into(),
            launch: Launch::ManagedNpm {
                package: GEMINI_PACKAGE,
                version: GEMINI_VERSION,
                entry: GEMINI_ENTRY,
                args: &["--acp", "--approval-mode", "default"],
                env: &[],
                min_node: GEMINI_MIN_NODE,
                native: None,
            },
            session_mode: None,
            session_meta: None,
            protected_paths: vec![".gemini/".into()],
            permission_gaps: vec![
                "Gemini 自己的設定（~/.gemini/settings.json、Repo 的 .gemini/settings.json）中允許的工具不會詢問 Runner".into(),
                "Gemini 直接執行的唯讀工具（讀檔、搜尋）不會詢問 Runner".into(),
            ],
            known_issues: vec![
                "路徑檢查區分大小寫：Runner 傳給 Agent 的 Worktree 路徑一律是正規化後、與磁碟一致的大小寫".into(),
                "需要先在本機執行 gemini 完成登入".into(),
            ],
            reports_usage: true,
            credential: format!("{GEMINI}-local"),
            max_concurrent_runs: DEFAULT_MAX_CONCURRENT_RUNS,
            min_version: None,
        }
    }

    /// 內建的 Grok Build profile（原生 ACP：`grok agent stdio`，beta）。
    ///
    /// - 使用者自己安裝（`~/.grok/bin`），偵測版本，低於 [`GROK_MIN_VERSION`] 時回報無法使用。
    /// - 不共用 leader 程序（`--no-leader`），每個 Run 各自一個程序樹，中止時才能整棵結束。
    /// - 不使用 `--always-approve`。
    pub fn grok() -> Self {
        Self {
            id: GROK.into(),
            launch: Launch::Command {
                command: PathBuf::from("grok"),
                // `--no-leader` 是 `grok agent` 的選項，要放在 `stdio` 之前（實機探測時發現）。
                args: vec!["agent".into(), "--no-leader".into(), "stdio".into()],
                env: BTreeMap::new(),
            },
            session_mode: None,
            session_meta: None,
            protected_paths: vec![".grok/".into()],
            permission_gaps: vec!["Grok 自己的設定（~/.grok）中允許的工具不會詢問 Runner".into()],
            known_issues: vec![
                "beta；需要 SuperGrok 系列訂閱".into(),
                "需要先在本機執行 grok 完成登入".into(),
            ],
            reports_usage: true,
            credential: format!("{GROK}-local"),
            max_concurrent_runs: DEFAULT_MAX_CONCURRENT_RUNS,
            min_version: Some(GROK_MIN_VERSION),
        }
    }

    /// 一般的 ACP Agent（runner.toml 的 `[agents.<id>]`）。
    pub fn generic(id: &str, settings: &AgentSettings) -> Self {
        Self {
            id: id.into(),
            launch: Launch::Command {
                command: settings.command.clone(),
                args: settings.args.clone(),
                env: settings.env.clone(),
            },
            session_mode: None,
            session_meta: None,
            protected_paths: Vec::new(),
            permission_gaps: vec!["一般 ACP Agent：只能攔截 Agent 主動送出的權限請求".into()],
            known_issues: Vec::new(),
            reports_usage: true,
            credential: format!("{id}-local"),
            max_concurrent_runs: settings
                .max_concurrent_runs
                .unwrap_or(DEFAULT_MAX_CONCURRENT_RUNS),
            min_version: None,
        }
    }

    /// 依 `initialize` 的回應推導能力旗標（§7），上層據此降級處理。
    pub fn capabilities(&self, init: &InitializeResponse) -> Vec<AgentCapability> {
        let caps = &init.agent_capabilities;
        let mut out = Vec::new();
        if caps.load_session {
            out.push(AgentCapability::LoadSession);
        }
        if caps.prompt_capabilities.image {
            out.push(AgentCapability::ImagePrompt);
        }
        if self.reports_usage {
            out.push(AgentCapability::UsageReport);
        }
        // plan mode 不可靠（§7），A2 實作 Planning 前不宣告。
        out
    }

    /// 組出啟動指令。`agents_dir` 是 Runner 代管安裝的位置。
    pub fn launch_spec(&self, agents_dir: &Path) -> anyhow::Result<ProcessSpec> {
        match &self.launch {
            Launch::Command { command, args, env } => Ok(ProcessSpec::new(command)
                .args(args)
                .envs(env.iter().map(|(k, v)| (k.clone(), v.clone())))),
            Launch::ManagedNpm {
                package,
                version,
                entry,
                args,
                env,
                native,
                ..
            } => {
                let entry_file = install::entry_path(agents_dir, package, version, entry);
                let mut spec = ProcessSpec::new("node")
                    .arg(entry_file)
                    .args(args.iter())
                    .envs(env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
                let native = native.as_ref().and_then(|native| {
                    let file = native
                        .windows_path(&install::node_modules(agents_dir, package, version))?;
                    let spawnable = paths::spawnable(&file);
                    (file.is_file() && spawnable != paths::normalize(&file))
                        .then_some((native.env, spawnable))
                });
                if let Some((env, file)) = native {
                    spec = spec.env(env, file);
                }
                Ok(spec)
            }
        }
    }

    /// 把 ACP 的權限請求分類成 Permission Policy 的對象。
    pub fn classify(
        &self,
        request: &RequestPermissionRequest,
        worktree: &Path,
    ) -> PermissionSubject {
        classify_tool_call(&request.tool_call, worktree)
    }
}

/// 依 tool call 的類別、位置與 `rawInput` 分類。各 Agent 的 `rawInput` 形狀不同，
/// 這裡涵蓋 Claude Code（`command`、`file_path`）與一般常見的鍵（`path`、`paths`、`cmd`）。
pub fn classify_tool_call(call: &ToolCallUpdate, worktree: &Path) -> PermissionSubject {
    let fields = &call.fields;
    let raw = fields.raw_input.as_ref();
    let title = fields.title.clone().unwrap_or_default();
    let mut paths: Vec<PathBuf> = fields
        .locations
        .iter()
        .flatten()
        .map(|l| l.path.clone())
        .collect();
    if let Some(raw) = raw {
        for key in [
            "file_path",
            "path",
            "abs_path",
            "notebook_path",
            "destination",
            "new_path",
            // 移動的來源：來源也會被刪除，必須一起判斷。
            "source",
            "src",
            "from",
            "old_path",
            "oldPath",
        ] {
            if let Some(p) = raw.get(key).and_then(|v| v.as_str()) {
                paths.push(PathBuf::from(p));
            }
        }
        if let Some(list) = raw.get("paths").and_then(|v| v.as_array()) {
            paths.extend(list.iter().filter_map(|v| v.as_str()).map(PathBuf::from));
        }
    }
    let paths: Vec<PathBuf> = paths
        .into_iter()
        .map(|p| if p.is_absolute() { p } else { worktree.join(p) })
        .collect();
    let command = raw.and_then(|raw| {
        let value = raw.get("command").or_else(|| raw.get("cmd"))?;
        match value {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Array(parts) => Some(
                parts
                    .iter()
                    .filter_map(|p| p.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            _ => None,
        }
    });
    match fields.kind {
        Some(ToolKind::Execute) => PermissionSubject::Command {
            command: command.unwrap_or(title),
        },
        Some(ToolKind::Read | ToolKind::Search) if !paths.is_empty() => {
            PermissionSubject::Read { paths }
        }
        Some(ToolKind::Edit) => PermissionSubject::Write { paths },
        // 移動等於刪除來源：當成刪除判斷，來源在 Worktree 外時一律拒絕；找不到路徑時問人。
        Some(ToolKind::Move) => PermissionSubject::Delete { paths },
        Some(ToolKind::Delete) => PermissionSubject::Delete { paths },
        _ => match command {
            Some(command) => PermissionSubject::Command { command },
            None => PermissionSubject::Other { title },
        },
    }
}

/// 這台 Runner 上可用的 Agent Profile：內建的加上 runner.toml 的 `[agents.*]`。
/// runner.toml 中與內建同名的設定會覆寫內建 profile 的啟動指令（其他修補保留）。
#[derive(Debug, Clone)]
pub struct Profiles {
    profiles: BTreeMap<String, AgentProfile>,
}

impl Profiles {
    pub fn from_settings(settings: &Settings) -> Self {
        let mut profiles = BTreeMap::new();
        let claude = AgentProfile::claude_code_with(
            settings
                .agents
                .get(CLAUDE_CODE)
                .and_then(|a| a.user_settings)
                .unwrap_or(false),
        );
        for builtin in [
            claude,
            AgentProfile::codex(),
            AgentProfile::gemini(),
            AgentProfile::grok(),
        ] {
            profiles.insert(builtin.id.clone(), builtin);
        }
        for (id, agent) in &settings.agents {
            let profile = match profiles.remove(id) {
                Some(mut builtin) => {
                    builtin.launch = Launch::Command {
                        command: agent.command.clone(),
                        args: agent.args.clone(),
                        env: agent.env.clone(),
                    };
                    if let Some(max) = agent.max_concurrent_runs {
                        builtin.max_concurrent_runs = max;
                    }
                    // 換成使用者自己的啟動指令：版本無從比較。
                    builtin.min_version = None;
                    builtin
                }
                None => AgentProfile::generic(id, agent),
            };
            profiles.insert(id.clone(), profile);
        }
        Self { profiles }
    }

    pub fn get(&self, id: &str) -> Option<&AgentProfile> {
        self.profiles.get(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &AgentProfile> {
        self.profiles.values()
    }
}

/// 從 `initialize` 得知的 Agent 資訊：Runner 啟動時探測，或 Run 啟動 Agent 時更新（issue #18）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Learned {
    pub capabilities: Vec<AgentCapability>,
    /// `initialize` 回報的版本。
    pub version: Option<String>,
}

/// 各 Agent 的 [`Learned`]，Supervisor 與各個 Run 共用。
#[derive(Debug, Default)]
pub struct LearnedAgents(std::sync::Mutex<BTreeMap<String, Learned>>);

impl LearnedAgents {
    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Learned>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 記下最新的資訊；內容有變化時回傳 `true`（要重送 AgentAvailability）。
    pub fn record(&self, id: &str, learned: Learned) -> bool {
        let mut map = self.lock();
        if map.get(id) == Some(&learned) {
            return false;
        }
        map.insert(id.to_owned(), learned);
        true
    }

    pub fn get(&self, id: &str) -> Option<Learned> {
        self.lock().get(id).cloned()
    }
}

/// 偵測 Agent 是否能用（§7、AgentAvailability）。
#[derive(Debug, Clone, PartialEq)]
pub struct Detected {
    pub available: bool,
    pub version: Option<String>,
    pub unavailable_reason: Option<String>,
}

/// 執行 `<指令> --version`，和測過的最低版本比較。讀不出版本時視為可用（交給實際啟動判斷）。
async fn check_version(command: &Path, min: &str) -> Detected {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        process::run(&ProcessSpec::new(command).arg("--version")),
    )
    .await;
    let version = match output {
        Ok(Ok(out)) => parse_version(&out.stdout).or_else(|| parse_version(&out.stderr)),
        _ => None,
    };
    match version {
        Some(found) if version_less(&found, min) => Detected {
            available: false,
            version: Some(found.clone()),
            unavailable_reason: Some(format!("版本 {found} 低於測過的最低版本 {min}，請更新")),
        },
        found => Detected {
            available: true,
            version: found,
            unavailable_reason: None,
        },
    }
}

/// 從 `--version` 的輸出取出第一個 `x.y.z` 形式的版本。
fn parse_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == ',' || c == '(' || c == ')')
        .map(|w| w.trim_start_matches('v'))
        .find(|w| {
            let parts: Vec<&str> = w.split('.').collect();
            parts.len() >= 2
                && parts
                    .iter()
                    .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_owned)
}

/// `a` 是否比 `b` 舊（逐段比較數字）。
fn version_less(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    parse(a) < parse(b)
}

/// 偵測 profile 需要的執行檔是否存在。代管安裝的 adapter 會在第一次派工時安裝，
/// 這裡只檢查 Node 的版本。
pub async fn detect(profile: &AgentProfile) -> Detected {
    match &profile.launch {
        Launch::Command { command, .. } => {
            let found = process::find_command(
                command,
                std::env::var_os("PATH").as_deref(),
                std::env::var_os("PATHEXT").as_deref(),
            );
            match found {
                Some(path) => match profile.min_version {
                    None => Detected {
                        available: true,
                        version: None,
                        unavailable_reason: None,
                    },
                    Some(min) => check_version(&path, min).await,
                },
                None => Detected {
                    available: false,
                    version: None,
                    unavailable_reason: Some(format!("未安裝：找不到 {}", command.display())),
                },
            }
        }
        Launch::ManagedNpm {
            version, min_node, ..
        } => match install::node_major_version().await {
            Some(major) if major >= *min_node => Detected {
                available: true,
                version: Some((*version).to_owned()),
                unavailable_reason: None,
            },
            Some(major) => Detected {
                available: false,
                version: None,
                unavailable_reason: Some(format!("需要 Node {min_node} 以上，目前是 {major}")),
            },
            None => Detected {
                available: false,
                version: None,
                unavailable_reason: Some(format!("未安裝：找不到 Node（需要 {min_node} 以上）")),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::ProtocolVersion;
    use agent_client_protocol::schema::v1::{
        AgentCapabilities, PromptCapabilities, ToolCallLocation, ToolCallUpdateFields,
    };
    use serde_json::json;

    use super::*;

    fn wt() -> PathBuf {
        std::env::temp_dir().join("wt")
    }

    /// 實機測試時發現：`--home` 很深時，內附的 `claude.exe` 路徑超過 `MAX_PATH`，
    /// adapter 用 Node 啟動它會失敗（ENOENT）。
    #[cfg(windows)]
    #[test]
    fn 內附執行檔路徑過長時以環境變數傳入長路徑形式() {
        let dir = tempfile::tempdir().unwrap();
        let profile = AgentProfile::claude_code();
        let env_of = |agents_dir: &Path| {
            profile
                .launch_spec(agents_dir)
                .unwrap()
                .env
                .into_iter()
                .find(|(k, _)| k == CLAUDE_NATIVE.env)
                .map(|(_, v)| PathBuf::from(v))
        };
        let install = |agents_dir: &Path| {
            let file = CLAUDE_NATIVE
                .windows_path(&install::node_modules(
                    agents_dir,
                    CLAUDE_ACP_PACKAGE,
                    CLAUDE_ACP_VERSION,
                ))
                .unwrap();
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, b"").unwrap();
            file
        };

        let short = dir.path().join("a");
        install(&short);
        assert_eq!(env_of(&short), None, "路徑不長時維持套件的預設行為");

        let deep = dir.path().join("d".repeat(150));
        let file = install(&deep);
        let passed = env_of(&deep).expect("應傳入執行檔路徑");
        assert!(passed.to_string_lossy().starts_with(r"\\?\"));
        assert!(paths::same_path(&passed, &file));
    }

    fn call(kind: ToolKind, raw: serde_json::Value) -> ToolCallUpdate {
        ToolCallUpdate::new(
            "t1",
            ToolCallUpdateFields::new()
                .kind(kind)
                .title("標題".to_owned())
                .raw_input(Some(raw)),
        )
    }

    #[test]
    fn 依_claude_code_的_raw_input_分類() {
        assert_eq!(
            classify_tool_call(
                &call(
                    ToolKind::Execute,
                    json!({ "command": "pnpm test", "description": "x" })
                ),
                &wt()
            ),
            PermissionSubject::Command {
                command: "pnpm test".into()
            }
        );
        assert_eq!(
            classify_tool_call(
                &call(ToolKind::Edit, json!({ "file_path": "src/a.rs" })),
                &wt()
            ),
            PermissionSubject::Write {
                paths: vec![wt().join("src/a.rs")]
            }
        );
        let outside = std::env::temp_dir().join("other.txt");
        assert_eq!(
            classify_tool_call(
                &call(ToolKind::Read, json!({ "file_path": outside })),
                &wt()
            ),
            PermissionSubject::Read {
                paths: vec![outside]
            }
        );
        let outside_src = std::env::temp_dir().join("secret.txt");
        assert_eq!(
            classify_tool_call(
                &call(
                    ToolKind::Move,
                    json!({ "source": outside_src, "destination": "in-worktree.txt" })
                ),
                &wt()
            ),
            PermissionSubject::Delete {
                paths: vec![wt().join("in-worktree.txt"), outside_src]
            },
            "移動的來源要一起判斷"
        );
        assert_eq!(
            classify_tool_call(&call(ToolKind::Fetch, json!({ "url": "https://x" })), &wt()),
            PermissionSubject::Other {
                title: "標題".into()
            }
        );
        assert_eq!(
            classify_tool_call(
                &call(ToolKind::Execute, json!({ "cmd": ["git", "status"] })),
                &wt()
            ),
            PermissionSubject::Command {
                command: "git status".into()
            }
        );
    }

    #[test]
    fn 沒有_raw_input_時用_locations_與標題() {
        let update = ToolCallUpdate::new(
            "t2",
            ToolCallUpdateFields::new()
                .kind(ToolKind::Delete)
                .locations(vec![ToolCallLocation::new(wt().join("x.txt"))]),
        );
        assert_eq!(
            classify_tool_call(&update, &wt()),
            PermissionSubject::Delete {
                paths: vec![wt().join("x.txt")]
            }
        );
        let execute = ToolCallUpdate::new(
            "t3",
            ToolCallUpdateFields::new()
                .kind(ToolKind::Execute)
                .title("npm test".to_owned()),
        );
        assert_eq!(
            classify_tool_call(&execute, &wt()),
            PermissionSubject::Command {
                command: "npm test".into()
            }
        );
    }

    #[test]
    fn 能力旗標來自_initialize() {
        let profile = AgentProfile::claude_code();
        let init = InitializeResponse::new(ProtocolVersion::V1).agent_capabilities(
            AgentCapabilities::new()
                .load_session(true)
                .prompt_capabilities(PromptCapabilities::new().image(true)),
        );
        assert_eq!(
            profile.capabilities(&init),
            [
                AgentCapability::LoadSession,
                AgentCapability::ImagePrompt,
                AgentCapability::UsageReport
            ]
        );
        let bare = InitializeResponse::new(ProtocolVersion::V1);
        assert_eq!(profile.capabilities(&bare), [AgentCapability::UsageReport]);
    }

    #[test]
    fn runner_toml_可以加入_agent_或覆寫內建的啟動指令() {
        let settings = Settings::parse(
            "[agents.fake]\ncommand = \"fake-agent\"\nargs = [\"--script\", \"a.yaml\"]\nmax_concurrent_runs = 2\n[agents.claude-code]\ncommand = \"my-claude-acp\"\n",
        )
        .unwrap();
        let profiles = Profiles::from_settings(&settings);
        let fake = profiles.get("fake").unwrap();
        assert_eq!(fake.max_concurrent_runs, 2);
        assert!(
            matches!(&fake.launch, Launch::Command { args, .. } if args == &["--script", "a.yaml"])
        );
        let claude = profiles.get(CLAUDE_CODE).unwrap();
        assert!(
            matches!(&claude.launch, Launch::Command { command, .. } if command == Path::new("my-claude-acp"))
        );
        assert_eq!(
            claude.session_mode,
            Some("default"),
            "覆寫啟動指令時保留修補"
        );
        assert!(!claude.protected_paths.is_empty());
    }

    /// issue #55：預設不載入使用者全域設定，落差說明跟著改變。
    #[test]
    fn claude_code_預設隔離使用者全域設定() {
        let isolated = AgentProfile::claude_code();
        let meta = isolated
            .session_meta
            .clone()
            .expect("預設要傳 settingSources");
        assert_eq!(
            meta["claudeCode"]["options"]["settingSources"],
            serde_json::json!(["project", "local"])
        );
        assert!(!isolated.permission_gaps[0].contains("~/.claude/settings.json）"));

        let settings =
            Settings::parse("[agents.claude-code]\ncommand = \"x\"\nuser_settings = true\n")
                .unwrap();
        let profiles = Profiles::from_settings(&settings);
        let with_user = profiles.get(CLAUDE_CODE).unwrap();
        assert_eq!(with_user.session_meta, None);
        assert!(with_user.permission_gaps[0].contains("~/.claude/settings.json"));
    }

    /// issue #31：Codex、Gemini CLI 由 Runner 代管安裝精確版本；Grok Build 檢查最低版本。
    #[test]
    fn 內建的_agent_profile_與版本鎖定() {
        let exact = |v: &str| v.chars().all(|c| c.is_ascii_digit() || c == '.');
        let codex = AgentProfile::codex();
        let Launch::ManagedNpm {
            package,
            version,
            env,
            ..
        } = &codex.launch
        else {
            panic!("Codex 由 Runner 代管安裝");
        };
        assert_eq!(*package, "@agentclientprotocol/codex-acp");
        assert!(exact(version), "{version}");
        assert!(env.contains(&("INITIAL_AGENT_MODE", "read-only")));
        assert_eq!(codex.session_mode, Some("read-only"));

        let gemini = AgentProfile::gemini();
        let spec = gemini.launch_spec(Path::new("/agents")).unwrap();
        assert_eq!(spec.program, PathBuf::from("node"));
        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args[0].contains(GEMINI_VERSION), "{args:?}");
        assert_eq!(&args[1..], ["--acp", "--approval-mode", "default"]);

        let grok = AgentProfile::grok();
        assert!(matches!(&grok.launch, Launch::Command { command, args, .. }
                if command == Path::new("grok") && args == &["agent", "--no-leader", "stdio"]));
        assert_eq!(grok.min_version, Some(GROK_MIN_VERSION));

        let profiles = Profiles::from_settings(&Settings::default());
        let ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, [CLAUDE_CODE, CODEX, GEMINI, GROK]);
        for profile in profiles.iter() {
            assert!(
                !profile.permission_gaps.is_empty(),
                "{} 要寫落差",
                profile.id
            );
        }
    }

    #[test]
    fn runner_toml_覆寫_grok_的啟動指令時不檢查版本() {
        let settings = Settings::parse("[agents.grok]\ncommand = \"my-grok\"\n").unwrap();
        let grok = Profiles::from_settings(&settings)
            .get(GROK)
            .cloned()
            .unwrap();
        assert_eq!(grok.min_version, None);
    }

    #[test]
    fn 解析與比較版本() {
        assert_eq!(
            parse_version("grok 1.0.52 (0920c8169e27) [stable]"),
            Some("1.0.52".into())
        );
        assert_eq!(parse_version("codex-cli 0.160.0\n"), Some("0.160.0".into()));
        assert_eq!(parse_version("v24.1.0"), Some("24.1.0".into()));
        assert_eq!(parse_version("沒有版本"), None);
        assert!(version_less("1.0.9", "1.0.52"));
        assert!(!version_less("1.0.52", "1.0.52"));
        assert!(!version_less("1.1.0", "1.0.52"));
        assert!(version_less("0.99", "1.0.52"));
    }

    /// codex-acp 內附的 codex.exe 在平台套件的 vendor 目錄中。
    #[cfg(windows)]
    #[test]
    fn codex_內附執行檔的位置() {
        let path = CODEX_NATIVE
            .windows_path(Path::new(r"C:\nm"))
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        assert!(
            path.starts_with("C:/nm/@openai/codex-win32-") && path.ends_with("/bin/codex.exe"),
            "{path}"
        );
    }

    #[test]
    fn claude_code_的_adapter_版本鎖定() {
        let profile = AgentProfile::claude_code();
        let Launch::ManagedNpm {
            package, version, ..
        } = profile.launch
        else {
            panic!("Claude Code 預設由 Runner 代管安裝");
        };
        assert_eq!(package, "@agentclientprotocol/claude-agent-acp");
        assert!(
            version.chars().all(|c| c.is_ascii_digit() || c == '.'),
            "版本必須是精確版本：{version}"
        );
        let spec = AgentProfile::claude_code()
            .launch_spec(Path::new("/agents"))
            .unwrap();
        assert_eq!(spec.program, PathBuf::from("node"));
        assert!(spec.args[0].to_string_lossy().contains(version));
    }
}
