//! Orbis MCP server（ARCHITECTURE §9、ADR-0009）。
//!
//! Runner 在每個 ACP session 注入一個 stdio MCP server：就是 Runner 執行檔自己，以
//! `--mcp-bridge` 啟動（[`bridge`]）。它把 Agent 的工具呼叫經由本機 TCP 交給 Runner（[`hub`]），
//! Runner 再以 `tool_call`／`tool_result` frame 轉給 Server；只在本機處理的工具（Verification 判定
//! 用的 `report_verdict`）不經過 Server。
//!
//! ```text
//! Agent ──stdio MCP──▶ orbis-runner --mcp-bridge ──TCP（每個 Run 一組 token）──▶ Runner（hub）
//!                                                                         └──tool_call──▶ Server
//! ```

pub mod bridge;
pub mod hub;

use agent_client_protocol::schema::v1::{EnvVariable, McpServer, McpServerStdio};
use orbis_protocol::names;
use serde::{Deserialize, Serialize};

/// 注入到 session 的 MCP server 名稱（產品的 slug，例如 `orbis`）。
pub fn server_name() -> &'static str {
    names::PRODUCT_SLUG
}

/// bridge 連回 Runner 的位址（`127.0.0.1:<port>`）。
pub fn env_endpoint() -> String {
    names::env_var("MCP_ENDPOINT")
}

/// bridge 呼叫工具時帶的 token，Runner 以此認出是哪個 Run。
pub fn env_token() -> String {
    names::env_var("MCP_TOKEN")
}

/// 有值時 bridge 提供 `report_verdict`（Verification 判定用的 Child Run）。
pub fn env_judge() -> String {
    names::env_var("MCP_JUDGE")
}

/// 只在 Runner 本機處理的工具：判定 Verification 條件的 Child Run 回報結果。
pub const REPORT_VERDICT: &str = "report_verdict";

/// bridge 送給 Runner 的一次工具呼叫（一行 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeRequest {
    pub token: String,
    pub tool: String,
    pub arguments: serde_json::Value,
}

/// Runner 回給 bridge 的結果（一行 JSON）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BridgeResponse {
    Ok { output: serde_json::Value },
    Error { code: String, message: String },
}

/// 注入到 `session/new`（與 load、resume）的 MCP server 設定。
pub fn session_server(endpoint: &str, token: &str, judge: bool) -> McpServer {
    let exe = std::env::current_exe()
        .map(|p| crate::paths::spawnable(&p).to_string_lossy().into_owned())
        .unwrap_or_else(|_| format!("{}-runner", names::PRODUCT_SLUG));
    let mut env = vec![
        EnvVariable::new(env_endpoint(), endpoint.to_owned()),
        EnvVariable::new(env_token(), token.to_owned()),
    ];
    if judge {
        env.push(EnvVariable::new(env_judge(), "1".to_owned()));
    }
    McpServer::Stdio(
        McpServerStdio::new(server_name().to_owned(), exe)
            .args(vec!["--mcp-bridge".to_owned()])
            .env(env),
    )
}

/// 這個權限請求是不是 Agent 呼叫 Orbis 自己的 MCP 工具（不轉給人，由 Server 套用防護規則）。
/// 各 Agent 的標題格式不同：Claude Code 是 `mcp__orbis__delegate`，其他常見的是 `orbis/delegate`、
/// `orbis.delegate` 或 `orbis: delegate`。
pub fn is_orbis_tool(title: &str) -> bool {
    let name = server_name().to_ascii_lowercase();
    let title = title.trim().to_ascii_lowercase();
    title.starts_with(&format!("mcp__{name}__"))
        || [
            format!("{name}/"),
            format!("{name}."),
            format!("{name}:"),
            format!("{name}__"),
        ]
        .iter()
        .any(|prefix| title.starts_with(prefix.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 認得_orbis_自己的_mcp_工具() {
        let name = server_name();
        assert!(is_orbis_tool(&format!("mcp__{name}__delegate")));
        assert!(is_orbis_tool(&format!("{name}/wait_run")));
        assert!(is_orbis_tool(&format!("{name}: ask_parent")));
        assert!(!is_orbis_tool("mcp__playwright__browser_navigate"));
        assert!(!is_orbis_tool(&format!("rm -rf {name}/x")));
    }
}
