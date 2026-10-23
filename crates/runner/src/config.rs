//! 連線設定：從命令列參數、環境變數與 `runner.toml` 決定要連到哪個 Server、用什麼身分連線。
//! 優先順序：命令列 > 環境變數 > `runner.toml`。

use anyhow::{Context, bail};
use orbis_protocol::RUNNER_WS_PATH;
use orbis_protocol::connection::RunnerInfo;
use orbis_protocol::names::{self, ENV_PAIRING_TOKEN, ENV_SERVER_URL};

use crate::home::Settings;

/// tracing 的過濾設定（`EnvFilter` 語法），未設定時為 `info`。
/// 這是環境變數名稱的後綴，完整名稱由 [`names::env_var`] 組出。
pub const ENV_LOG: &str = "LOG";

/// 連上 Server 所需的一切。
#[derive(Debug, Clone)]
pub struct ConnectConfig {
    /// Runner 的 WebSocket 端點，例如 `ws://localhost:4000/runner`。
    pub url: String,
    /// Server 的 HTTP base URL（上傳 blob 用），例如 `http://localhost:4000`。
    pub http_base: String,
    /// 第一次連線用的 Pairing token。本機已保存這個 Server 的 Runner token 時忽略。
    pub pairing_token: Option<String>,
    pub runner: RunnerInfo,
    /// 保存的 Runner token 被 Server 拒絕（例如已被撤銷）時，是否改用 Pairing token 重新 Pairing。
    /// sidecar 模式為 `false`：直接以需要重新 Pairing 的結束碼結束，由 Desktop 重新取得 Pairing token。
    pub repair_with_pairing_token: bool,
}

/// 命令列上提供的值；沒有提供的項目從環境變數或設定檔讀取。
#[derive(Debug, Clone, Default)]
pub struct ConfigArgs {
    pub server: Option<String>,
    pub pairing_token: Option<String>,
    pub name: Option<String>,
}

impl ConnectConfig {
    /// `lookup_env` 讓測試不必改動真正的環境變數。
    pub fn resolve(
        args: ConfigArgs,
        settings: &Settings,
        lookup_env: impl Fn(&str) -> Option<String>,
    ) -> anyhow::Result<Self> {
        let from_env = |name: &str| lookup_env(name).filter(|v| !v.trim().is_empty());
        let server = args
            .server
            .or_else(|| from_env(ENV_SERVER_URL))
            .or_else(|| settings.server.clone())
            .with_context(|| {
                format!(
                    "缺少 Server 網址：請指定 --server、設定環境變數 {}，或寫在 {} 的 server",
                    ENV_SERVER_URL,
                    names::RUNNER_CONFIG_FILE
                )
            })?;
        let pairing_token = args
            .pairing_token
            .or_else(|| from_env(ENV_PAIRING_TOKEN))
            .filter(|t| !t.trim().is_empty());
        let name = args
            .name
            .or_else(|| settings.name.clone())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(default_name);

        let (url, http_base) = server_urls(&server)?;
        Ok(Self {
            url,
            http_base,
            pairing_token,
            repair_with_pairing_token: true,
            runner: RunnerInfo {
                name,
                runner_version: env!("CARGO_PKG_VERSION").to_owned(),
                os: std::env::consts::OS.to_owned(),
                arch: std::env::consts::ARCH.to_owned(),
            },
        })
    }
}

/// 預設的顯示名稱：主機名稱。
fn default_name() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

/// 把 Server 的 base URL 轉成 Runner 的 WebSocket 端點：`http` → `ws`、`https` → `wss`，
/// 再接上 [`RUNNER_WS_PATH`]。已經是 `ws`／`wss` 的網址只接上路徑。
pub fn runner_ws_url(server: &str) -> anyhow::Result<String> {
    server_urls(server).map(|(ws, _)| ws)
}

/// WebSocket 端點與 HTTP base URL。
pub fn server_urls(server: &str) -> anyhow::Result<(String, String)> {
    let trimmed = server.trim().trim_end_matches('/');
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        bail!("Server 網址 {server:?} 缺少 http:// 或 https://");
    };
    let (ws_scheme, http_scheme) = match scheme.to_ascii_lowercase().as_str() {
        "http" | "ws" => ("ws", "http"),
        "https" | "wss" => ("wss", "https"),
        other => bail!("Server 網址 {server:?} 的 scheme {other:?} 不支援，請用 http 或 https"),
    };
    if rest.is_empty() {
        bail!("Server 網址 {server:?} 缺少主機名稱");
    }
    Ok((
        format!("{ws_scheme}://{rest}{RUNNER_WS_PATH}"),
        format!("{http_scheme}://{rest}"),
    ))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn http_becomes_ws_and_https_becomes_wss() {
        assert_eq!(
            runner_ws_url("http://localhost:4000").unwrap(),
            format!("ws://localhost:4000{RUNNER_WS_PATH}")
        );
        assert_eq!(
            runner_ws_url("https://example.com/").unwrap(),
            format!("wss://example.com{RUNNER_WS_PATH}")
        );
        assert_eq!(
            runner_ws_url("HTTPS://example.com/base").unwrap(),
            format!("wss://example.com/base{RUNNER_WS_PATH}")
        );
        assert_eq!(
            runner_ws_url("ws://127.0.0.1:9").unwrap(),
            format!("ws://127.0.0.1:9{RUNNER_WS_PATH}")
        );
        assert_eq!(
            server_urls("wss://example.com/base/").unwrap().1,
            "https://example.com/base"
        );
    }

    #[test]
    fn invalid_server_urls_are_rejected() {
        assert!(runner_ws_url("localhost:4000").is_err());
        assert!(runner_ws_url("ftp://example.com").is_err());
        assert!(runner_ws_url("http://").is_err());
    }

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn command_line_takes_precedence_over_environment() {
        let config = ConnectConfig::resolve(
            ConfigArgs {
                server: Some("http://cli:1".into()),
                pairing_token: Some("pt_cli".into()),
                name: Some("my-runner".into()),
            },
            &Settings::default(),
            env(&[
                (ENV_SERVER_URL, "http://env:2"),
                (ENV_PAIRING_TOKEN, "pt_env"),
            ]),
        )
        .unwrap();
        assert_eq!(config.url, format!("ws://cli:1{RUNNER_WS_PATH}"));
        assert_eq!(config.http_base, "http://cli:1");
        assert_eq!(config.pairing_token.as_deref(), Some("pt_cli"));
        assert_eq!(config.runner.name, "my-runner");
    }

    #[test]
    fn falls_back_to_environment_then_settings() {
        let settings =
            Settings::parse("server = \"http://file:3\"\nname = \"from-file\"\n").unwrap();
        let config = ConnectConfig::resolve(
            ConfigArgs::default(),
            &settings,
            env(&[
                (ENV_SERVER_URL, "https://env:2"),
                (ENV_PAIRING_TOKEN, "pt_env"),
            ]),
        )
        .unwrap();
        assert_eq!(config.url, format!("wss://env:2{RUNNER_WS_PATH}"));
        assert_eq!(config.pairing_token.as_deref(), Some("pt_env"));
        assert_eq!(config.runner.name, "from-file");
        assert_eq!(config.runner.os, std::env::consts::OS);

        let config = ConnectConfig::resolve(ConfigArgs::default(), &settings, env(&[])).unwrap();
        assert_eq!(config.url, format!("ws://file:3{RUNNER_WS_PATH}"));
        assert_eq!(
            config.pairing_token, None,
            "已 Pairing 的 Runner 不需要 Pairing token"
        );
    }

    #[test]
    fn missing_server_names_the_environment_variable() {
        let err = ConnectConfig::resolve(ConfigArgs::default(), &Settings::default(), env(&[]))
            .unwrap_err();
        assert!(err.to_string().contains(ENV_SERVER_URL), "{err}");
    }
}
