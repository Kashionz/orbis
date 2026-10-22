//! 測試用的 stdio MCP server（`orbis-fake-mcp-server` 執行檔）。
//!
//! 工具：
//! - `echo { text }`：原樣回傳 `text`。
//! - `get_env { name }`：回傳環境變數的值，用來確認 `session/new` 注入的 `env` 有傳到子程序。

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, ServiceExt, schemars, tool, tool_handler, tool_router};

/// `echo` 的參數。
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct EchoArgs {
    /// 要回傳的文字。
    pub text: String,
}

/// `get_env` 的參數。
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct GetEnvArgs {
    /// 環境變數名稱。
    pub name: String,
}

/// 測試用的 MCP server。
#[derive(Debug, Clone)]
pub struct EchoServer {
    tool_router: ToolRouter<Self>,
}

impl Default for EchoServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_router(router = tool_router)]
impl EchoServer {
    /// 建立 server。
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    /// 原樣回傳 `text`。
    #[tool(description = "Echo the given text back")]
    fn echo(&self, Parameters(EchoArgs { text }): Parameters<EchoArgs>) -> String {
        text
    }

    /// 回傳環境變數的值。
    #[tool(description = "Return the value of an environment variable")]
    fn get_env(
        &self,
        Parameters(GetEnvArgs { name }): Parameters<GetEnvArgs>,
    ) -> Result<String, String> {
        std::env::var(&name).map_err(|_| format!("environment variable {name} is not set"))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for EchoServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }
}

/// 以 stdio 提供服務，直到 stdin 關閉。
pub async fn serve_stdio() -> anyhow::Result<()> {
    let service = EchoServer::new().serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
