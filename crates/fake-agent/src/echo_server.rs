//! 測試用的 stdio MCP server（`orbis-fake-mcp-server` 執行檔）。
//!
//! 工具：
//! - `echo { text }`：原樣回傳 `text`。
//! - `get_env { name }`：回傳環境變數的值，用來確認 `session/new` 注入的 `env` 有傳到子程序。
//! - `get_args {}`：回傳啟動時的參數（JSON 陣列），用來確認注入的 MCP server 設定。
//! - `browser_take_screenshot { filename }`：模擬 Playwright MCP 的截圖，在 `--output-dir` 寫一張
//!   1×1 的 PNG，回傳寫入的路徑。

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

/// `browser_take_screenshot` 的參數。
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ScreenshotArgs {
    /// 檔名（不含目錄）。
    pub filename: String,
}

/// 1×1 的透明 PNG。
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

/// 測試用的 MCP server。
#[derive(Debug, Clone)]
pub struct EchoServer {
    tool_router: ToolRouter<Self>,
    args: Vec<String>,
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
            args: std::env::args().skip(1).collect(),
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

    /// 回傳啟動時的參數。
    #[tool(description = "Return the command-line arguments of this server")]
    fn get_args(&self) -> String {
        serde_json::to_string(&self.args).unwrap_or_default()
    }

    /// 模擬截圖：在 `--output-dir` 寫一張 PNG。
    #[tool(description = "Take a screenshot (fake: writes a 1x1 PNG into --output-dir)")]
    fn browser_take_screenshot(
        &self,
        Parameters(ScreenshotArgs { filename }): Parameters<ScreenshotArgs>,
    ) -> Result<String, String> {
        if filename.contains(['/', '\\']) || filename.contains("..") {
            return Err(format!("filename must not contain a directory: {filename}"));
        }
        let dir = self
            .args
            .iter()
            .position(|a| a == "--output-dir")
            .and_then(|i| self.args.get(i + 1))
            .ok_or("--output-dir is not set")?;
        let path = std::path::Path::new(dir).join(&filename);
        std::fs::write(&path, TINY_PNG).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(path.display().to_string())
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
