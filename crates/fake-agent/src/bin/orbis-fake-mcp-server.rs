//! `orbis-fake-mcp-server`：測試用的 stdio MCP server，提供 `echo` 與 `get_env` 工具。

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    orbis_fake_agent::echo_server::serve_stdio().await
}
