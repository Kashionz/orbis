# 包裝現有 CLI Agent，並以 ACP v1 作為唯一的 Agent 介面

我們不自建 agent loop，而是驅動 Claude Code、Codex、Gemini CLI、Grok Build 等現有的 CLI，讓使用者沿用自己的訂閱，品質也跟著上游提升。Agent 介面採用 ACP v1（JSON-RPC over stdio），原因有三：一個 adapter 加上每個 Agent 一份 profile，就能接約 40 種 Agent；ACP 提供結構化的權限請求、diff 與 plan；注入 MCP server 是所有 Agent 都必須支援的能力。ACP v2 仍是草案，所以鎖定 v1。

## Considered Options

- **每個 CLI 各寫一個原生 adapter**（Claude Agent SDK、Codex App Server 等）：功能最完整，但維護成本隨 Agent 數量線性成長。保留為後備方案：ACP 做不到時才加 `ClaudeSdkAdapter`。
- **用 PTY 驅動 TUI 並解析輸出**（Orca 的 TUI 模式）：拿不到結構化事件，權限也無法由我們控管。

## Consequences

- Claude 與 Codex 依賴第三方 adapter（`claude-agent-acp`、`codex-acp`），它們更新頻繁、常有 regression，所以版本要鎖定。
- Runner 對內使用自己的正規化 Event 模型，ACP 的型別不外流到 Server。

- 2026-10-24 註記：Gemini CLI 的個人方案已在 2026-06-18 停止服務，內建 Agent 改由 Antigravity（Google 官方的 `agy_acp_server`）取代，見 ARCHITECTURE §7。
