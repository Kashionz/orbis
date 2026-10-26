# Agent 之間的 Delegation 透過 Runner 注入的 Orbis MCP server，只開放 consult 與 branch 模式

為了讓 Claude 能把工作分派給 Codex、Grok 等其他 Agent，Runner 在每個 ACP session 開始時注入 Orbis MCP server（stdio），提供 `delegate`、`wait_run`、`merge_child`、`ask_parent` 等工具。所有 ACP Agent 都必須支援 stdio MCP，所以任何 Agent 都能當作父 Run。Child Run 只有兩種模式：`consult`（在父 Worktree 中唯讀）與 `branch`（從父 Run 當下的 HEAD 開出子 Worktree，由父 Agent 呼叫 `merge_child` 合併回來）。

## Considered Options

- **`shared` 模式**（兩個 Agent 在同一個 Worktree 中修改）：容易同時修改同一個檔案而產生衝突，所以不提供。
- **由 Orbis 的協調器決定怎麼拆工作**（Orca 的實驗性 orchestration）：太複雜。改由父 Agent 自己決定，Orbis 只負責提供工具與防護規則（深度 ≤ 2、每個 Run 最多 5 個 Child Run、權限只能收緊）。

## 2026-10-26 修訂

- 不再有權限層（[ADR-0017](0017-no-permission-layer.md)），所以「權限只能收緊」的防護規則拿掉；深度與數量的限制保留。
- Delegation 一律開啟、可以分派給所有 Agent，不再有 Project 設定與 `.orbis/config.toml` 的 `[delegation]`（[ADR-0018](0018-minimal-settings.md)）。
