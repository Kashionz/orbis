//! 連線設定：從命令列參數與環境變數決定要連到哪個 Server、用什麼身分連線。

use anyhow::{Context, bail};
use orbis_protocol::RUNNER_WS_PATH;
use orbis_protocol::connection::{Pairing, RunnerInfo};
use orbis_protocol::names;

/// 環境變數名稱的後綴，完整名稱由 [`names::env_var`] 組出。
pub const ENV_SERVER_URL: &str = "SERVER_URL";
pub const ENV_PAIRING_TOKEN: &str = "PAIRING_TOKEN";
/// tracing 的過濾設定（`EnvFilter` 語法），未設定時為 `info`。
pub const ENV_LOG: &str = "LOG";

/// 連上 Server 所需的一切。
#[derive(Debug, Clone)]
pub struct ConnectConfig {
    /// Runner 的 WebSocket 端點，例如 `ws://localhost:4000/runner`。
    pub url: String,
    pub pairing: Pairing,
    pub runner: RunnerInfo,
}

/// 命令列上提供的值；沒有提供的項目從環境變數讀取。
#[derive(Debug, Clone, Default)]
pub struct ConfigArgs {
    pub server: Option<String>,
    pub pairing_token: Option<String>,
    pub name: Option<String>,
}

impl ConnectConfig {
    /// 命令列優先，其次是環境變數。`lookup_env` 讓測試不必改動真正的環境變數。
    pub fn resolve(
        args: ConfigArgs,
        lookup_env: impl Fn(&str) -> Option<String>,
    ) -> anyhow::Result<Self> {
        let from_env = |suffix: &str| {
            let name = names::env_var(suffix);
            lookup_env(&name).filter(|v| !v.trim().is_empty())
        };
        let server = args
            .server
            .or_else(|| from_env(ENV_SERVER_URL))
            .with_context(|| {
                format!(
                    "缺少 Server 網址：請指定 --server 或設定環境變數 {}",
                    names::env_var(ENV_SERVER_URL)
                )
            })?;
        let token = args
            .pairing_token
            .or_else(|| from_env(ENV_PAIRING_TOKEN))
            .with_context(|| {
                format!(
                    "缺少 Pairing token：請指定 --pairing-token 或設定環境變數 {}",
                    names::env_var(ENV_PAIRING_TOKEN)
                )
            })?;
        let name = args
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(default_name);

        Ok(Self {
            url: runner_ws_url(&server)?,
            pairing: Pairing::PairingToken { token },
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
    let trimmed = server.trim().trim_end_matches('/');
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        bail!("Server 網址 {server:?} 缺少 http:// 或 https://");
    };
    let ws_scheme = match scheme.to_ascii_lowercase().as_str() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        other => bail!("Server 網址 {server:?} 的 scheme {other:?} 不支援，請用 http 或 https"),
    };
    if rest.is_empty() {
        bail!("Server 網址 {server:?} 缺少主機名稱");
    }
    Ok(format!("{ws_scheme}://{rest}{RUNNER_WS_PATH}"))
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
            .map(|(k, v)| (names::env_var(k), (*v).to_owned()))
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
            env(&[
                (ENV_SERVER_URL, "http://env:2"),
                (ENV_PAIRING_TOKEN, "pt_env"),
            ]),
        )
        .unwrap();
        assert_eq!(config.url, format!("ws://cli:1{RUNNER_WS_PATH}"));
        assert_eq!(
            config.pairing,
            Pairing::PairingToken {
                token: "pt_cli".into()
            }
        );
        assert_eq!(config.runner.name, "my-runner");
    }

    #[test]
    fn falls_back_to_environment_variables() {
        let config = ConnectConfig::resolve(
            ConfigArgs::default(),
            env(&[
                (ENV_SERVER_URL, "https://env:2"),
                (ENV_PAIRING_TOKEN, "pt_env"),
            ]),
        )
        .unwrap();
        assert_eq!(config.url, format!("wss://env:2{RUNNER_WS_PATH}"));
        assert_eq!(
            config.pairing,
            Pairing::PairingToken {
                token: "pt_env".into()
            }
        );
        assert!(!config.runner.name.is_empty(), "預設名稱是主機名稱");
        assert_eq!(config.runner.os, std::env::consts::OS);
    }

    #[test]
    fn missing_values_name_the_environment_variable() {
        let err = ConnectConfig::resolve(ConfigArgs::default(), env(&[])).unwrap_err();
        assert!(
            err.to_string().contains(&names::env_var(ENV_SERVER_URL)),
            "{err}"
        );

        let err = ConnectConfig::resolve(
            ConfigArgs::default(),
            env(&[(ENV_SERVER_URL, "http://env:2"), (ENV_PAIRING_TOKEN, "  ")]),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains(&names::env_var(ENV_PAIRING_TOKEN)),
            "{err}"
        );
    }
}
