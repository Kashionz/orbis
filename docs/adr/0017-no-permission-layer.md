# 不設權限層：Runner 一律允許 Agent 的權限請求，體驗對齊 Orca

ADR-0006 讓 Runner 依 Permission Policy（`manual`／`auto`／`yolo`）回覆 ACP 的權限請求，另外加上 `allow_commands` 的指令字面分析、`.orbis/config.toml` 腳本的信任核准、受保護的 Agent 設定與竄改偵測，以及主分支的寫入保護。實際使用時，派工、對話、驗收都會停下來問人，Project 與派工對話框也多了一整組政策設定。使用者要求和 Orca 完全一樣的體驗（2026-10-26）：Orbis 不另外限制 Agent。

我們決定 Orbis 不設權限層：

- Runner 收到 `session/request_permission` 一律選「允許」，優先選只允許這一次的選項，避免寫進 Agent 自己的設定檔。照常送出 `permission_resolved`（作者是系統），事件串流照常顯示，所以事後查得到 Agent 做了什麼。
- 不使用 Agent 的 bypass 旗標。claude-agent-acp 的 bypassPermissions 有已知 bug，而且只有經過 ACP 的權限請求才拿得到結構化的紀錄。Agent Profile 指定的 session mode 照舊，但模式不在 Agent 回報的清單中時不再拒絕啟動。
- Claude Code 載入使用者全域的設定（`~/.claude/settings.json`、plugin 與它帶的 MCP、hooks），和在終端機直接執行一樣。其他 Agent 本來就會載入自己的使用者設定。
- 拿掉的機制：Permission Policy（三個等級、派工與執行中的切換、Project 的預設）、`[permissions].allow_commands` 與指令分析、`command` 驗收指令的信任詢問、`.orbis/config.toml` 腳本的信任核准、受保護的 Agent 設定與竄改偵測、主分支的寫入保護、Child Run 的權限繼承，以及 Needs You 中的權限請求。
- **Team Runner 保留，同樣不設權限層。** 終端機改成能操作這個 Task 的人都能開，Local Runner 與 Team Runner 相同；拿掉 Team 設定「允許 Team Runner 的終端機」與 `runner.toml` 的 `allow_terminal`。
- **不做執行環境隔離**：取消原本規劃的每個 Run 一個 worker 容器、egress proxy、Credential proxy 與 Credential 最小化、Local Runner 清理環境變數、Agent 設定目錄的隔離。保留 Team Runner 向 Server 要短效 push token 的做法，它的目的是讓 Team Runner 不必設定長效的 PAT，不是限制 Agent。

## Considered Options

- **保留 Permission Policy，只把預設改成 `yolo`**：政策的設定、程式碼與測試都還在；信任核准與竄改偵測仍會打斷 Run，不是 Orca 的體驗。
- **改用 Agent 原生的 bypass 旗標**：Claude Code adapter 的 bypass 模式有 bug，各 Agent 的旗標也不一致；而且拿不到結構化的權限紀錄。
- **只有 Local Runner 不設限，Team Runner 保留權限層**：同一個產品有兩套規則，使用者要記得哪台電腦會問。使用者決定兩者一致（2026-10-26）。

## Consequences

- 安全邊界只剩 Worktree 與機器本身，而 Worktree 只避免檔案衝突，不是沙盒。Agent 可以讀寫 Worktree 以外的檔案、讀取 `~/.ssh` 與雲端憑證、連到任何網站、push 到任何分支（包括主分支）。
- **Team Runner**：能派工到 Team Runner 的人，等於能在那台主機上執行任何指令，也讀得到 Runner 程序中的 Agent Credential。Team Runner 要放在專用的機器或 VM，只放這個團隊會用到的東西；INSTALL.md 要寫明。ADR-0005 的共用訂閱風險不變。
- prompt injection（CI 輸出、Issue 內容、網頁）少了一道防線。ARCHITECTURE §5.2 把 CI 輸出當成資料標示的做法保留。
- Runner 的政策判斷與指令分析、信任核准、竄改偵測，Server 的政策欄位與 Needs You 的權限種類，Web 的權限選單都要刪除（v0.1.0 完成規劃的 S1）。
- 取代 [ADR-0006](0006-runner-enforced-permission-policy.md)；修訂 [ADR-0005](0005-shared-subscription-on-team-runner.md)、[ADR-0009](0009-delegation-via-injected-mcp.md)、[ADR-0014](0014-interactive-terminal-through-runner.md)。
