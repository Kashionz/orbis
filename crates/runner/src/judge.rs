//! Verification 的 `agent`／`browser` 判定（ARCHITECTURE §5.1）。
//!
//! 被驗證的 Run 以 Orbis 工具呼叫 `delegate`（`purpose = verification`、`consult`）請 Server 建立
//! 判定用的 Child Run，等它結束後取出它以 `report_verdict` 回報的判定。`browser` 類型的 Child Run
//! 另外注入 Playwright MCP（鎖定版本、headless），截圖存成 blob 作為證據。
//!
//! Playwright MCP 的 `--allowed-origins` 只是盡力過濾請求（不處理 redirect 等），不是安全邊界：
//! 自動允許的範圍由 [`is_auto_allowed_browser_tool`] 決定，`browser_navigate` 只在網址的 origin
//! 就是 Preview 時自動允許，其他情況照 Permission Policy 問人。

use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{McpServer, McpServerStdio};
use orbis_protocol::event::ContentBlock;
use orbis_protocol::verification::VerificationCriterion;

use crate::home::RunnerHome;

/// Runner 管理的 Playwright MCP（鎖定版本）。
pub const PLAYWRIGHT_MCP_PACKAGE: &str = "@playwright/mcp";
pub const PLAYWRIGHT_MCP_VERSION: &str = "0.0.83";
const PLAYWRIGHT_MCP_ENTRY: &str = "cli.js";
/// 注入的瀏覽器 MCP server 名稱。
pub const BROWSER_SERVER: &str = "playwright";
/// 證據中最多附幾張截圖。
const MAX_SCREENSHOTS: usize = 10;
/// 一張截圖的大小上限。
const MAX_SCREENSHOT_BYTES: u64 = 10 * 1024 * 1024;

/// 給判定用 Child Run 的 prompt：要判定的條件、上下文與回報方式。
pub fn prompt(
    task: &str,
    criteria: &[&VerificationCriterion],
    context: &[ContentBlock],
    browser_url: Option<&str>,
) -> String {
    let mut text = format!(
        "你是 {task} 的 Verification 判定者。請檢查目前 Worktree 中的實作是否符合下列每一條 Acceptance Criterion。\n\
         這是唯讀的檢查：不要修改任何檔案，也不要執行會改變狀態的指令。\n\n"
    );
    for criterion in criteria {
        text.push_str(&format!(
            "- criterion_id `{}`：{}\n",
            criterion.criterion_id, criterion.description
        ));
    }
    if let Some(url) = browser_url {
        text.push_str(&format!(
            "\n請用 `{BROWSER_SERVER}` MCP server 的瀏覽器工具開啟這個 Run 的 Preview（{url}）實際操作確認，並在關鍵畫面截圖。\n"
        ));
    }
    let context: Vec<&str> = context
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    if !context.is_empty() {
        text.push_str("\n上下文：\n");
        text.push_str(&context.join("\n"));
        text.push('\n');
    }
    text.push_str(&format!(
        "\n每一條都要用 `{}` MCP server 的 `{}` 工具回報一次（criterion_id、outcome 為 passed 或 failed、summary 說明理由）。",
        crate::orbis_mcp::server_name(),
        crate::orbis_mcp::REPORT_VERDICT
    ));
    text
}

/// `browser` 類型的判定注入的瀏覽器 MCP server：runner.toml 的 `[browser_judge]`，沒有設定時用
/// Runner 管理的 Playwright MCP（第一次使用時安裝）。只允許連到 Preview 的 origin，截圖寫到
/// `output_dir`。
pub async fn browser_server(
    home: &RunnerHome,
    url: &str,
    output_dir: &Path,
) -> anyhow::Result<McpServer> {
    let (command, mut args) = match &home.settings().browser_judge {
        Some(settings) => (
            settings.command.to_string_lossy().into_owned(),
            settings.args.clone(),
        ),
        None => {
            let entry = crate::agent::install::ensure_installed(
                &home.agents_dir(),
                PLAYWRIGHT_MCP_PACKAGE,
                PLAYWRIGHT_MCP_VERSION,
                PLAYWRIGHT_MCP_ENTRY,
            )
            .await?;
            (
                "node".to_owned(),
                vec![
                    crate::paths::spawnable(&entry)
                        .to_string_lossy()
                        .into_owned(),
                ],
            )
        }
    };
    std::fs::create_dir_all(output_dir)?;
    args.extend([
        "--headless".to_owned(),
        "--isolated".to_owned(),
        "--allowed-origins".to_owned(),
        origin(url).to_owned(),
        "--output-dir".to_owned(),
        crate::paths::normalize(output_dir)
            .to_string_lossy()
            .into_owned(),
    ]);
    Ok(McpServer::Stdio(
        McpServerStdio::new(BROWSER_SERVER.to_owned(), command).args(args),
    ))
}

/// 網址的 origin（`scheme://host:port`）。
fn origin(url: &str) -> &str {
    let after_scheme = url.find("://").map_or(0, |i| i + 3);
    match url[after_scheme..].find('/') {
        Some(i) => &url[..after_scheme + i],
        None => url,
    }
}

/// 判定用的 Child Run 自動允許的瀏覽器工具：只有在目前頁面上操作、讀取與截圖（`browser_navigate`
/// 另外檢查網址）。執行任意程式碼（`browser_evaluate`、`browser_run_code`）、上傳本機檔案
/// （`browser_file_upload`）、開新分頁到任意網址（`browser_tabs`）、安裝瀏覽器等其他工具不在清單中，
/// 照 Permission Policy 問人。
const AUTO_ALLOWED_BROWSER_TOOLS: &[&str] = &[
    "navigate_back",
    "snapshot",
    "click",
    "hover",
    "type",
    "press_key",
    "select_option",
    "fill_form",
    "drag",
    "wait_for",
    "resize",
    "handle_dialog",
    "console_messages",
    "network_requests",
    "take_screenshot",
    "close",
];

/// 這個權限請求是不是注入的瀏覽器 MCP server 中、判定用的 Child Run 可以自動允許的工具：
/// [`AUTO_ALLOWED_BROWSER_TOOLS`]，或網址的 origin 就是 Preview（`preview_url`）的 `browser_navigate`。
/// 標題只認完全相符的形式：Claude Code 的 `mcp__playwright__browser_<名稱>`、Antigravity 的
/// `playwright_browser_<名稱>`，或常見的 `playwright/…`、`playwright.…`、`playwright: …`。
pub fn is_auto_allowed_browser_tool(
    title: &str,
    raw_input: Option<&serde_json::Value>,
    preview_url: &str,
) -> bool {
    let title = title.trim();
    let tool = [
        format!("mcp__{BROWSER_SERVER}__"),
        format!("{BROWSER_SERVER}_"),
        format!("{BROWSER_SERVER}/"),
        format!("{BROWSER_SERVER}."),
        format!("{BROWSER_SERVER}: "),
    ]
    .iter()
    .find_map(|prefix| title.strip_prefix(prefix.as_str()));
    let Some(name) = tool.and_then(|t| t.strip_prefix("browser_")) else {
        return false;
    };
    if name == "navigate" {
        return raw_input
            .and_then(|input| input.get("url"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|url| same_origin(url, preview_url));
    }
    AUTO_ALLOWED_BROWSER_TOOLS.contains(&name)
}

/// 兩個 http(s) 網址的 origin 完全相同（`http://localhost:4100@evil.example/` 這類寫法不算）。
fn same_origin(url: &str, preview_url: &str) -> bool {
    let url = url.trim();
    (url.starts_with("http://") || url.starts_with("https://"))
        && !url.contains(['\\', '@'])
        && origin(url).eq_ignore_ascii_case(origin(preview_url))
}

/// 截圖目錄中的圖片（依檔名排序，最多 [`MAX_SCREENSHOTS`] 張）：檔名、內容、media type。
pub fn screenshots(dir: &Path) -> Vec<(String, Vec<u8>, &'static str)> {
    let mut files: Vec<PathBuf> = walk(dir);
    files.sort();
    files
        .into_iter()
        .filter_map(|path| {
            let media_type = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                _ => return None,
            };
            // 不跟著連結讀（只收 Playwright 寫出的一般檔案）。
            let meta = std::fs::symlink_metadata(&path).ok()?;
            if !meta.is_file() || meta.len() > MAX_SCREENSHOT_BYTES {
                return None;
            }
            let bytes = std::fs::read(&path).ok()?;
            let name = path
                .strip_prefix(dir)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            Some((name, bytes, media_type))
        })
        .take(MAX_SCREENSHOTS)
        .collect()
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            out.extend(walk(&entry.path()));
        } else if kind.is_file() {
            out.push(entry.path());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只自動允許瀏覽器_mcp_server_中操作_preview_的工具() {
        let preview = "http://localhost:4100/ready";
        let allowed = |title: &str| is_auto_allowed_browser_tool(title, None, preview);
        assert!(allowed("mcp__playwright__browser_click"));
        assert!(allowed("playwright/browser_take_screenshot"));
        assert!(allowed("playwright: browser_snapshot"));
        assert!(allowed("playwright_browser_click"));
        assert!(!allowed("playwright_browser_evaluate"));
        assert!(!allowed("mcp__playwright__browser_"));
        assert!(!allowed("mcp__playwright__browser_click; rm -rf /"));
        assert!(!allowed("mcp__playwright__install"));
        assert!(!allowed("mcp__other__browser_click"));
        assert!(!allowed("rm -rf playwright/browser_click"));
        // 執行程式碼、上傳檔案、開分頁、安裝瀏覽器不自動允許。
        for tool in ["evaluate", "run_code", "file_upload", "tabs", "install"] {
            assert!(
                !allowed(&format!("mcp__playwright__browser_{tool}")),
                "{tool}"
            );
        }
        // browser_navigate 只在網址的 origin 就是 Preview 時自動允許。
        let navigate = |url: &str| {
            is_auto_allowed_browser_tool(
                "mcp__playwright__browser_navigate",
                Some(&serde_json::json!({ "url": url })),
                preview,
            )
        };
        assert!(navigate("http://localhost:4100/"));
        assert!(navigate("http://localhost:4100/app?x=1"));
        assert!(!navigate("http://localhost:4101/"));
        assert!(!navigate("http://localhost:4100@evil.example/"));
        assert!(!navigate("https://evil.example/"));
        assert!(!navigate("file:///C:/Users/x/.ssh/id_rsa"));
        assert!(
            !allowed("mcp__playwright__browser_navigate"),
            "沒有網址時問人"
        );
    }

    #[test]
    fn 網址的_origin() {
        assert_eq!(
            origin("http://localhost:4100/app?x=1"),
            "http://localhost:4100"
        );
        assert_eq!(origin("http://localhost:4100"), "http://localhost:4100");
    }
}
