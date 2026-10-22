//! 以 MCP client 身分連到 `session/new` 注入的 stdio MCP server。

use std::path::Path;
use std::process::Stdio;

use agent_client_protocol::schema::v1::McpServerStdio;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::service::RunningService;
use rmcp::transport::TokioChildProcess;
use rmcp::{RoleClient, ServiceExt};

use crate::paths;

/// 一個已完成 MCP initialize 的連線。drop 時會結束子程序。
pub struct McpConnection {
    service: RunningService<RoleClient, ()>,
}

impl McpConnection {
    /// 依 ACP 的 stdio MCP server 設定啟動子程序並完成 MCP initialize。
    ///
    /// - 指令依 `PATH`（以注入的 `env` 優先）與 Windows 的 `PATHEXT` 解析，支援含空白的路徑與 `.cmd` shim。
    /// - 參數逐一傳給作業系統，不經過 shell。
    /// - 子程序的工作目錄是 session cwd。
    pub async fn connect(server: &McpServerStdio, cwd: &Path) -> anyhow::Result<Self> {
        let injected = |name: &str| {
            server
                .env
                .iter()
                .find(|var| var.name.eq_ignore_ascii_case(name))
                .map(|var| std::ffi::OsString::from(&var.value))
        };
        let path_var = injected("PATH").or_else(|| std::env::var_os("PATH"));
        let pathext_var = injected("PATHEXT").or_else(|| std::env::var_os("PATHEXT"));
        let program =
            paths::resolve_command(&server.command, path_var.as_deref(), pathext_var.as_deref());

        let mut command = tokio::process::Command::new(&program);
        command
            .args(&server.args)
            .envs(server.env.iter().map(|var| (&var.name, &var.value)))
            .current_dir(cwd)
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            /// 不要替子程序開新的 console 視窗。
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let (transport, _stderr) = TokioChildProcess::builder(command)
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                anyhow::anyhow!(
                    "無法啟動 MCP server {}（{}）：{error}",
                    server.name,
                    program.display()
                )
            })?;
        let service = ().serve(transport).await.map_err(|error| {
            anyhow::anyhow!("MCP server {} initialize 失敗：{error}", server.name)
        })?;
        Ok(Self { service })
    }

    /// 呼叫工具。
    pub async fn call_tool(
        &self,
        tool: &str,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> anyhow::Result<CallToolResult> {
        let mut params = CallToolRequestParams::new(tool.to_owned());
        if let Some(arguments) = arguments {
            params = params.with_arguments(arguments);
        }
        Ok(self.service.call_tool(params).await?)
    }

    /// 關閉連線並等待子程序結束。
    pub async fn close(self) {
        let _ = self.service.cancel().await;
    }
}
