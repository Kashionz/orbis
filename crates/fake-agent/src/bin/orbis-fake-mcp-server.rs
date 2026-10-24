//! `orbis-fake-mcp-server`：測試用的 stdio MCP server（工具見 [`orbis_fake_agent::echo_server`]）。

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    orbis_fake_agent::echo_server::serve_stdio().await
}
