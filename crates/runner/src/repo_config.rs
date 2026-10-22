//! Repo 的設定檔 `<CONFIG_DIR>/<CONFIG_FILE>`（ARCHITECTURE §6.3）。
//!
//! 一律從 Worktree 的 base commit 讀取（不讀 Worktree 中的檔案），Agent 在 Run 中修改設定檔
//! 不會放寬這個 Run 的 `allow_commands`，也不會讓未核准的腳本被執行。

use orbis_protocol::names;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// 設定檔在 Repo 中的路徑（`/` 分隔），例如 `<CONFIG_DIR>/<CONFIG_FILE>`。
pub fn config_path() -> String {
    format!("{}/{}", names::CONFIG_DIR, names::CONFIG_FILE)
}

/// 解析後的設定。所有段落都是選填。
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct RepoConfig {
    pub worktree: WorktreeConfig,
    pub preview: PreviewConfig,
    pub verify: VerifyConfig,
    pub permissions: PermissionsConfig,
    pub delegation: DelegationConfig,
    pub git: GitConfig,
}

/// `[git]`：Runner 代為操作 git 時的設定。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct GitConfig {
    /// `push_branch` 時替未 commit 的變更自動 commit 用的訊息。
    /// 佔位符：`{task_key}`、`{title}`、`{run_id}`、`{branch}`。
    pub commit_message: String,
}

/// 自動 commit 訊息的預設格式。
pub const DEFAULT_COMMIT_MESSAGE: &str = "{task_key}: {title}";

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            commit_message: DEFAULT_COMMIT_MESSAGE.to_owned(),
        }
    }
}

/// 自動 commit 訊息中佔位符的值。
#[derive(Debug, Clone, Copy)]
pub struct CommitFields<'a> {
    pub task_key: &'a str,
    pub title: &'a str,
    pub run_id: &'a str,
    pub branch: &'a str,
}

impl GitConfig {
    /// 代入佔位符；結果是空白時改用預設格式。
    pub fn commit_message(&self, fields: CommitFields<'_>) -> String {
        let render = |template: &str| {
            template
                .replace("{task_key}", fields.task_key)
                .replace("{title}", fields.title)
                .replace("{run_id}", fields.run_id)
                .replace("{branch}", fields.branch)
        };
        let message = render(&self.commit_message);
        if message.trim().is_empty() {
            render(DEFAULT_COMMIT_MESSAGE)
        } else {
            message
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct WorktreeConfig {
    /// 建立 Worktree 後執行。
    pub setup: Option<String>,
    /// 刪除前執行，失敗會擋下刪除。
    pub archive: Option<String>,
    pub wait_for_setup: bool,
    /// 從主 checkout 連結進 Worktree 的目錄。
    pub shared_dirs: Vec<String>,
    /// 從主 checkout 複製進 Worktree 的檔案（只限字面路徑）。
    pub copy: Vec<String>,
}

impl Default for WorktreeConfig {
    fn default() -> Self {
        Self {
            setup: None,
            archive: None,
            wait_for_setup: true,
            shared_dirs: Vec::new(),
            copy: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct PreviewConfig {
    pub command: Option<String>,
    pub ready_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct VerifyConfig {
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct PermissionsConfig {
    pub allow_commands: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct DelegationConfig {
    pub enabled: bool,
    pub allowed_agents: Vec<String>,
}

/// 讀到的設定檔：原文、hash 與解析結果。
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedConfig {
    /// 原文；Repo 中沒有設定檔時為空字串。
    pub text: String,
    /// 原文的 SHA-256（小寫十六進位），信任核准以此為單位（§6.2）。
    pub hash: String,
    pub config: RepoConfig,
}

impl LoadedConfig {
    pub fn parse(text: &str) -> Result<Self, toml::de::Error> {
        let config = if text.trim().is_empty() {
            RepoConfig::default()
        } else {
            toml::from_str(text)?
        };
        Ok(Self {
            text: text.to_owned(),
            hash: sha256_hex(text.as_bytes()),
            config,
        })
    }

    /// 需要人工核准的項目（§6.2「設定的信任核准」）：setup、archive、Preview 指令、
    /// Verification 指令，以及會放寬 Permission Policy 的 `allow_commands`。沒有腳本時不需要核准。
    pub fn scripts(&self) -> Vec<(&'static str, &str)> {
        let c = &self.config;
        [
            ("setup", c.worktree.setup.as_deref()),
            ("archive", c.worktree.archive.as_deref()),
            ("preview", c.preview.command.as_deref()),
        ]
        .into_iter()
        .chain(
            c.verify
                .commands
                .iter()
                .map(|cmd| ("verify", Some(cmd.as_str()))),
        )
        // allow_commands 會放寬 auto 政策自動允許的範圍，和腳本一樣需要核准。
        .chain(
            c.permissions
                .allow_commands
                .iter()
                .map(|cmd| ("allow_commands", Some(cmd.as_str()))),
        )
        .filter_map(|(name, script)| script.filter(|s| !s.trim().is_empty()).map(|s| (name, s)))
        .collect()
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// `copy` 與 `shared_dirs` 只接受 Repo 內的字面相對路徑：不可以有 glob、`..`、絕對路徑。
///
/// 回傳正規化後的形式（`/` 分隔、去掉 `.` 段落與重複的 `/`），和 git 輸出的路徑格式一致，
/// 所有使用者（複製、排除、洩漏檢查）都以這個形式比對。
pub fn literal_relative_path(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("路徑不可為空".into());
    }
    if trimmed.contains(['*', '?', '[', ']', '{', '}']) {
        return Err(format!("{raw} 含有 glob 字元；只接受字面路徑"));
    }
    let path = std::path::Path::new(trimmed);
    if path.is_absolute() || trimmed.starts_with(['/', '\\']) || trimmed.contains(':') {
        return Err(format!("{raw} 是絕對路徑；只接受 Repo 內的相對路徑"));
    }
    if trimmed.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!("{raw} 含有 ..；只接受 Repo 內的相對路徑"));
    }
    let normalized = trimmed
        .split(['/', '\\'])
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return Err(format!("{raw} 不是檔案路徑"));
    }
    // Windows 會改寫的形式（結尾的 . 或空白、8.3 短檔名、裝置名稱）會讓實際檔案和字串對不上，
    // 排除與洩漏檢查就可能漏掉，一律拒絕。
    for part in normalized.split('/') {
        let stem = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit());
        if part.ends_with(['.', ' ']) || part.contains('~') || reserved {
            return Err(format!("{raw} 含有 Windows 會改寫的路徑形式（{part}）"));
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = r#"
[worktree]
setup = "pnpm install --frozen-lockfile"
archive = "pnpm run clean"
wait_for_setup = true
shared_dirs = []
copy = [".env", ".env.local"]

[preview]
command = "pnpm dev --port $PORT"
ready_path = "/"

[verify]
commands = ["pnpm lint", "pnpm test"]

[permissions]
allow_commands = ["pnpm *", "git status", "git diff *"]

[delegation]
enabled = true
allowed_agents = ["claude-code", "codex", "gemini", "grok"]
"#;

    #[test]
    fn 解析_architecture_的範例() {
        let loaded = LoadedConfig::parse(EXAMPLE).unwrap();
        let c = &loaded.config;
        assert_eq!(
            c.worktree.setup.as_deref(),
            Some("pnpm install --frozen-lockfile")
        );
        assert_eq!(c.worktree.copy, [".env", ".env.local"]);
        assert_eq!(c.permissions.allow_commands.len(), 3);
        assert_eq!(c.verify.commands, ["pnpm lint", "pnpm test"]);
        assert!(c.delegation.enabled);
        assert_eq!(
            loaded.scripts().len(),
            8,
            "setup、archive、preview、兩個 verify 與三個 allow_commands"
        );
        assert_eq!(loaded.hash.len(), 64);
    }

    #[test]
    fn 自動_commit_訊息可以設定() {
        let fields = CommitFields {
            task_key: "ORB-12",
            title: "修好登入",
            run_id: "r1",
            branch: "feature/ORB-12-login",
        };
        assert_eq!(
            GitConfig::default().commit_message(fields),
            "ORB-12: 修好登入"
        );
        let custom = LoadedConfig::parse(
            "[git]
commit_message = \"feat: {title}（{task_key}，{branch}）\"
",
        )
        .unwrap();
        assert_eq!(
            custom.config.git.commit_message(fields),
            "feat: 修好登入（ORB-12，feature/ORB-12-login）"
        );
        let blank = LoadedConfig::parse(
            "[git]
commit_message = \"  \"
",
        )
        .unwrap();
        assert_eq!(blank.config.git.commit_message(fields), "ORB-12: 修好登入");
    }

    #[test]
    fn 沒有設定檔時用預設值且不需要核准() {
        let loaded = LoadedConfig::parse("").unwrap();
        assert_eq!(loaded.config, RepoConfig::default());
        assert!(loaded.config.worktree.wait_for_setup);
        assert!(loaded.scripts().is_empty());
    }

    #[test]
    fn 內容改變時_hash_也改變() {
        let a = LoadedConfig::parse("[worktree]\nsetup = \"a\"\n").unwrap();
        let b = LoadedConfig::parse("[worktree]\nsetup = \"b\"\n").unwrap();
        assert_ne!(a.hash, b.hash);
    }

    #[test]
    fn 設定檔路徑來自名稱常數() {
        assert_eq!(
            config_path(),
            format!("{}/{}", names::CONFIG_DIR, names::CONFIG_FILE)
        );
    }

    #[test]
    fn 只接受字面相對路徑() {
        assert_eq!(literal_relative_path(".env").as_deref(), Ok(".env"));
        assert_eq!(literal_relative_path("./.env").as_deref(), Ok(".env"));
        assert_eq!(
            literal_relative_path("config\\local.json").as_deref(),
            Ok("config/local.json")
        );
        assert_eq!(literal_relative_path("a//./b/").as_deref(), Ok("a/b"));
        assert!(literal_relative_path("./").is_err());
        for windows_alias in [
            ".env.",
            ".env ",
            "CONFIG~1/x",
            "nul",
            "aux.txt",
            "com1",
            "a/LPT9.log",
        ] {
            assert!(
                literal_relative_path(windows_alias).is_err(),
                "{windows_alias:?} 應該被拒絕"
            );
        }
        assert!(literal_relative_path("console.log").is_ok());
        assert_eq!(
            literal_relative_path("config/local.json").as_deref(),
            Ok("config/local.json")
        );
        for bad in [
            "*.env",
            "../secret",
            "/etc/passwd",
            r"C:\x",
            "a/../../b",
            "",
            "{a,b}",
        ] {
            assert!(literal_relative_path(bad).is_err(), "{bad:?} 應該被拒絕");
        }
    }
}
