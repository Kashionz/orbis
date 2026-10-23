//! 依 YAML 劇本行動的 ACP v1 agent，只用於測試（ARCHITECTURE §17）。
//!
//! - 執行檔 `orbis-fake-agent --script <劇本 YAML 路徑>`：以 stdio 講 ACP v1。
//! - 執行檔 `orbis-fake-mcp-server`：測試用的 stdio MCP server，提供 `echo`、`get_env`、`get_args` 與模擬截圖的工具。
//! - 劇本格式見 [`script`]；隨附的劇本放在 crate 的 `scripts/` 目錄。

pub mod agent;
pub mod echo_server;
pub mod mcp;
pub mod paths;
pub mod script;

pub use script::Script;
