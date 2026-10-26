# 權限只剩每個 session 的三種模式，預設全部允許，體驗對齊 Orca

ADR-0006 讓 Runner 依 Permission Policy（`manual`／`auto`／`yolo`）回覆 ACP 的權限請求，另外加上 `allow_commands` 的指令字面分析、`.orbis/config.toml` 腳本的信任核准、受保護的 Agent 設定與竄改偵測，以及主分支的寫入保護。實際使用時，派工、對話、驗收都會停下來問人，Project 與派工對話框也多了一整組政策設定。使用者要求和 Orca 一樣的體驗（2026-10-26）：Orbis 預設不限制 Agent。但使用者要保留每個 session 切換權限的能力，要嚴格時隨時能改成會詢問。Orca 也有同樣的開關（Yolo／Manual）。

我們決定權限只剩 Permission Policy 一項，而且只在 session 上：

- **三種模式**：`yolo`（全部允許，預設）、`auto`（自動）、`manual`（逐一確認）。每個 Run 與對話各自一個，派工、開對話時選，執行中可以從輸入框切換。沒有 Project 的預設值，也不記住上次的選擇：新的 session 一律從 `yolo` 開始。
- **`yolo`**：Runner 收到 `session/request_permission` 一律選「允許」，優先選只允許這一次的選項，避免寫進 Agent 自己的設定檔。照常送出 `permission_resolved`（標示為自動允許），事件串流照常顯示，所以事後查得到 Agent 做了什麼。
- **`auto`**：固定的規則，不能設定，也不做指令字面分析。
  - 自動允許：ACP tool kind 為 `read`、`search`、`think` 的請求；路徑都在工作位置內的 `edit`；`execute` 的整條指令和 `.orbis/config.toml` 的 `setup`、`[verify].commands`、`[preview].command` 其中一條完全相同。
  - 問人：其他的 `execute`、`delete`、`move`、`fetch`、`other`，以及任何路徑在工作位置以外的請求。
- **`manual`**：每個權限請求都問人。
- **問人時**：Run 暫停，請求出現在對話串與 Needs You，並發出桌面通知。選項只有三個：允許一次、這個 session 都允許、拒絕。「這個 session 都允許」由 Runner 記住同一個 tool kind 加同一條指令（或同一個路徑），只在這個 session 有效，不寫進 Agent 的設定檔，也不寫進 Repo。
- **誰能回覆、誰能切換**：能操作這個 Task 的人都可以，也就是 Team 內每個人；Local Runner 與 Team Runner 相同。切換從下一個權限請求開始套用；改成較寬的模式時，等待中的請求如果在新的模式下會自動允許，就直接允許。
- **Child Run** 沿用父 Run 當下的模式，之後各自切換。驗收的 judge Run 沿用被驗收的 Run。
- **不使用 Agent 的 bypass 旗標**：claude-agent-acp 的 bypassPermissions 有已知 bug，而且只有經過 ACP 的權限請求才拿得到結構化的紀錄。Agent Profile 指定的 session mode 照舊，但模式不在 Agent 回報的清單中時不再拒絕啟動。
- **Claude Code 載入使用者全域的設定**（`~/.claude/settings.json`、plugin 與它帶的 MCP、hooks），和在終端機直接執行一樣。其他 Agent 本來就會載入自己的使用者設定。使用者自己允許過的工具不會經過 Runner，三種模式都一樣。
- **拿掉的機制**：Project 的預設政策、`[permissions].allow_commands` 與指令分析、`command` 驗收指令的信任詢問、`.orbis/config.toml` 腳本的信任核准、受保護的 Agent 設定與竄改偵測、主分支的寫入保護與「一律拒絕」、`yolo` 只能在 Local Runner 選的限制與警告、Child Run「只能收緊」的規則。
- **Team Runner 保留，規則和 Local Runner 相同**。終端機改成能操作這個 Task 的人都能開；拿掉 Team 設定「允許 Team Runner 的終端機」與 `runner.toml` 的 `allow_terminal`。
- **不做執行環境隔離**：取消原本規劃的每個 Run 一個 worker 容器、egress proxy、Credential proxy 與 Credential 最小化、Local Runner 清理環境變數、Agent 設定目錄的隔離。保留 Team Runner 向 Server 要短效 push token 的做法，它的目的是讓 Team Runner 不必設定長效的 PAT，不是限制 Agent。

## Considered Options

- **完全不設權限層**（這份 ADR 2026-10-26 的第一版）：最接近 Orca 的預設，但使用者要能在個別 session 改成會詢問。
- **只有兩種模式（全部允許、逐一確認）**：和 Orca 的開關一樣。使用者要保留中間的「自動」，讓一般的讀寫不必一直按允許。
- **`auto` 沿用 `allow_commands` 與指令字面分析**：要維護一份白名單和一套解析規則，Project 也多一項設定（ADR-0018）。改成以 ACP 的 tool kind、路徑與 `.orbis/config.toml` 已有的指令判斷。
- **保留 Project 的預設政策**：多一項設定；預設一律是全部允許，要嚴格時在 session 上切換。

## Consequences

- 預設的 `yolo` 下，安全邊界只剩 Worktree 與機器本身，而 Worktree 只避免檔案衝突，不是沙盒。Agent 可以讀寫 Worktree 以外的檔案、讀取 `~/.ssh` 與雲端憑證、連到任何網站、push 到任何分支（包括主分支）。`auto` 與 `manual` 只是讓人看得到、擋得下經過 ACP 的請求，不是沙盒：使用者自己允許過的工具、Agent 在自己沙盒中執行的指令都不經過 Runner。
- **Team Runner**：能派工到 Team Runner 的人，等於能在那台主機上執行任何指令，也讀得到 Runner 程序中的 Agent Credential。Team Runner 要放在專用的機器或 VM，只放這個團隊會用到的東西；INSTALL.md 要寫明。ADR-0005 的共用訂閱風險不變。
- prompt injection（CI 輸出、Issue 內容、網頁）在 `yolo` 下少了一道防線。ARCHITECTURE §5.2 把 CI 輸出當成資料標示的做法保留。
- Runner 的 `allow_commands` 指令分析、信任核准、竄改偵測，Server 的 Project 預設政策與 Needs You 的信任核准種類，Web 的 Project 政策設定都要刪除；三種模式、權限請求的 Needs You 與桌面通知保留（v0.1.0 完成規劃的 S1）。
- 取代 [ADR-0006](0006-runner-enforced-permission-policy.md)；修訂 [ADR-0005](0005-shared-subscription-on-team-runner.md)、[ADR-0009](0009-delegation-via-injected-mcp.md)、[ADR-0014](0014-interactive-terminal-through-runner.md)。
