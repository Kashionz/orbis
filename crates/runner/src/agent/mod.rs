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

/// Agent 的啟動方式。
#[derive(Debug, Clone, PartialEq)]
pub enum Launch {
    /// 直接執行指令（`.cmd` shim 由 [`process`] 解析）。
    Command {
        command: PathBuf,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    /// Runner 代管安裝的 npm 套件，以 `node <entry>` 啟動（不經過 npx 與 shim）。
    ManagedNpm {
        package: &'static str,
        version: &'static str,
        entry: &'static str,
        min_node: u32,
    },
}

/// 一個 Agent 的接入設定。
#[derive(Debug, Clone, PartialEq)]
pub struct AgentProfile {
    pub id: String,
    pub launch: Launch,
    /// 建立 session 後要切換到的 session mode（修補使用者設定的 bypass／acceptEdits 預設模式）。
    pub session_mode: Option<&'static str>,
    /// Agent 自己的設定檔（相對於 Worktree）。修改它們可能讓 Agent 繞過 Permission Policy，
    /// `auto` 下寫入一律問人；每次送出 prompt 前和 base commit 比對，有差異就先問人。
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
}

impl AgentProfile {
    /// 內建的 Claude Code profile。
    pub fn claude_code() -> Self {
        Self {
            id: CLAUDE_CODE.into(),
            launch: Launch::ManagedNpm {
                package: CLAUDE_ACP_PACKAGE,
                version: CLAUDE_ACP_VERSION,
                entry: CLAUDE_ACP_ENTRY,
                min_node: CLAUDE_ACP_MIN_NODE,
            },
            // 使用者的 `permissions.defaultMode` 可能是 acceptEdits 或 bypassPermissions；
            // 一律切回會詢問的 default 模式（ADR-0006：不使用 bypass）。
            session_mode: Some("default"),
            protected_paths: vec![
                ".claude/settings.json".into(),
                ".claude/settings.local.json".into(),
            ],
            permission_gaps: vec![
                "Claude 自己的設定（~/.claude/settings.json、Repo 的 .claude/settings*.json）中 allow 的工具不會詢問 Runner".into(),
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
            protected_paths: Vec::new(),
            permission_gaps: vec!["一般 ACP Agent：只能攔截 Agent 主動送出的權限請求".into()],
            known_issues: Vec::new(),
            reports_usage: true,
            credential: format!("{id}-local"),
            max_concurrent_runs: settings
                .max_concurrent_runs
                .unwrap_or(DEFAULT_MAX_CONCURRENT_RUNS),
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
                ..
            } => {
                let entry = install::entry_path(agents_dir, package, version, entry);
                Ok(ProcessSpec::new("node").arg(entry))
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
        Some(ToolKind::Edit | ToolKind::Move) => PermissionSubject::Write { paths },
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
        let claude = AgentProfile::claude_code();
        profiles.insert(claude.id.clone(), claude);
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

/// 偵測 Agent 是否能用（§7、AgentAvailability）。
#[derive(Debug, Clone, PartialEq)]
pub struct Detected {
    pub available: bool,
    pub version: Option<String>,
    pub unavailable_reason: Option<String>,
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
                Some(_) => Detected {
                    available: true,
                    version: None,
                    unavailable_reason: None,
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
