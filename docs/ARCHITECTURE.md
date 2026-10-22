# Orbis 架構設計

本文件是 Orbis 設計的唯一依據。名詞以 [GLOSSARY.md](../GLOSSARY.md) 為準；重大取捨的理由在 [adr/](adr/)；時程與分軌在 [PLAN.md](PLAN.md)。

---

## 1. 產品定位

- **使用者**：2–10 人的小團隊，作為內部工具使用。
- **核心迴圈**：Task（Spec 與 Acceptance Criterion）→ 派給 Agent，在隔離的 Worktree 中執行 → Verification → Review Gate → PR → merge 後 Task 自動轉為 Done。
- **差異化**（市場缺口，參考 Conductor、Superconductor、AQ、Nimbalyst、Nuphos、Orca）：
  1. PM 與 Agent 真正串成完整的 Task 生命週期，而不只是「從 issue 啟動 agent」。
  2. Windows 是一等公民（三平台都支援，Windows 是主要測試平台）。
  3. Review 體驗：diff 行內留言回給 Agent、在 Preview 上留言回給 Agent、PR 的 Feedback Loop。
  4. 多 Agent 協作：一個 Agent 可以把工作分派給其他 Agent（Delegation）；best-of-N 留到 Phase 2。

---

## 2. 系統拓樸

```
┌────────────── Server（Docker Compose）──────────────┐
│ Hono API + WebSocket  ·  PostgreSQL  ·  Blob 儲存    │
│ GitHub App webhook  ·  Yjs 同步  ·  Preview 反向代理  │
└───────▲───────────────────▲───────────────▲──────────┘
        │ HTTPS/WS          │ WS（Runner 主動連入）│
   ┌────┴────┐     ┌────────┴────────┐ ┌────┴─────────────┐
   │ Web UI  │     │ Local Runner    │ │ Team Runner      │
   │ 瀏覽器   │     │ （Electron 代管）│ │ （伺服器容器）    │
   │ Electron│     │ Member 自己的電腦│ │ 共用 Credential   │
   └─────────┘     └────────┬────────┘ └────┬─────────────┘
                            │ ACP over stdio │
                   Claude Code / Codex / Gemini CLI / Grok Build
```

- **Runner 對稱架構**（[ADR-0001](adr/0001-symmetric-runner-reverse-connection.md)）：Local Runner 與 Team Runner 是**同一個執行檔**，差別只在部署位置與 Pairing 對象。
- **反向連線**：Runner 一律主動連到 Server 的 WebSocket，Server 永遠不連進 Runner，因此 NAT 與防火牆不是問題。Preview 流量也走這條通道（§13）。
- **所有 UI 都只連 Server**：瀏覽器與 Electron 看到的是同一個 Web UI。

---

## 3. 元件與技術棧

| 元件 | 路徑 | 技術 |
|---|---|---|
| Protocol | `crates/orbis-protocol` | Rust、`serde`、`ts-rs`（產生 TS 型別到 `packages/protocol`） |
| Runner | `crates/runner` | Rust、tokio、`agent-client-protocol`（ACP v1）、`portable-pty`、git CLI |
| Fake Agent | `crates/fake-agent` | Rust，依 YAML 劇本行動的 ACP agent，只用於測試 |
| Server | `apps/server` | Node.js、TypeScript、Hono、Drizzle ORM、PostgreSQL、`ws`、Yjs（`y-websocket` 協定） |
| Web UI | `apps/web` | React、Vite、TanStack Router 與 Query、Monaco（diff）、xterm.js、TipTap 與 Yjs |
| Desktop | `apps/desktop` | Electron、electron-builder、electron-updater；Runner 以 sidecar 子程序執行 |
| GitHub | `packages/github` | GitHub App（Octokit）、webhook 處理、Issues 同步、PR Feedback Loop |
| Generated types | `packages/protocol` | 由 `ts-rs` 產生，**不可手改** |
| API contract | `packages/api-contract` | Server↔Web 的 zod schema，以及 TS 版的名稱常數（`names.ts`） |

- **Monorepo**：TypeScript 用 pnpm workspaces，Rust 用 cargo workspace。
- **協定的唯一定義來源是 Rust**（[ADR-0003](adr/0003-rust-runner-protocol-source-of-truth.md)）。CI 會檢查產生出來的 TS 型別是否與 Rust 一致。
- **Server 與 Web 之間**：REST 加 WebSocket 推送，request／response 用 zod 驗證。
- **名稱集中**：產品名稱、設定檔名、環境變數前綴都集中定義在一個常數中，Rust 與 TS 各一份，並由測試檢查兩者一致。

---

## 4. 領域模型

```
Team 1─* Member（Role）
Team 1─* Project 1─* Repo
Project 1─* Task *─1 Repo
Task 1─* AcceptanceCriterion
Task *─0..1 RepoSpec（repo 內的 markdown spec，可以被多個 Task 連結）
Task *─* Task（depends_on）
Task 1─* Run 1─* Run（Child Run，深度 ≤ 2）
Run 1─* Event
Run 1─* Dispatch
Runner *─1 Member（Local）| Team（Team Runner）
Runner 1─* AgentAvailability（這台 Runner 能跑哪些 Agent，以及各 Credential 的並行上限）
```

- **Task Key**：`<Project 前綴>-<流水號>`，例如 `ORB-12`。
- **Run 的必要欄位**：agent、model、Permission Policy、worktree_path、branch、base_commit、parent_run_id、delegation_mode、status、用量。
- **best-of-N 預留**：一個 Task 本來就可以有多個平行的 Run。Phase 1 的資料模型就支援，UI 留到 Phase 2。

---

## 5. Task 生命週期

```
Backlog → Ready → Planning → [Plan Gate] → Running → Verifying → [Review Gate] → PR Open → Done
                                   ↑            │           │              │
                                   └── 退回 ────┴─ 失敗重試 ─┘              └─ Feedback Loop 回到 Running
```

| 狀態 | 進入條件 | 說明 |
|---|---|---|
| Backlog | 新建，或 Draft Task 被確認 | |
| Ready | Spec 與 Acceptance Criterion 齊備 | 可以派工 |
| Planning | 派工後 | Agent 以 plan 模式產出 plan |
| Plan Gate | plan 產出 | 人工核准；可以依 Project 或 Task 關閉，關閉時直接進入 Running |
| Running | plan 核准 | Agent 修改 Worktree |
| Verifying | Agent 回報完成 | 自動檢查 `command`、`agent`、`browser` 類型的條件 |
| Review Gate | Verification 全數通過 | 人工 review diff；行內留言可以退回 Running（**同一個 Worktree、同一個 session**） |
| PR Open | Review Gate 通過 | 自動 push 並開 PR |
| Done | PR merge（webhook） | 自動轉換 |

### 5.1 Acceptance Criterion 類型

| 類型 | 判定方式 |
|---|---|
| `command` | 在 Worktree 執行指令，exit code 為 0 就算通過（指令來自 Task，或 `.orbis/config.toml` 的 `verify`） |
| `agent` | 另開一個獨立的 `consult` Run（唯讀），讀 diff 與 Spec 後逐條判定，並附上證據 |
| `browser` | Agent 透過 Playwright MCP 操作 Preview，附上截圖與操作紀錄作為證據（§13） |
| `manual` | 在 Review Gate 由人工打勾 |

- **失敗重試**：Verification 失敗時，自動把失敗原因送回原 Run 重試，**預設最多 3 次**，超過就停下並加入 Needs You。

### 5.2 Feedback Loop（PR 開出之後）

- **觸發來源**：
  - 對 repo 有寫入權限的**人類** review 留言。
  - CI check 失敗。
  - bot 留言預設不觸發，要在白名單中的 bot 才會觸發。
- **合併再送**：等 review 送出後才觸發，或最後一則留言之後 2 分鐘才觸發；同一批留言合併成一次送出。
- **次數上限**：每個 PR 自動修正最多 **5 次**，CI 與 review 分開計數。超過就停下並通知 Task 負責人。
- **紀錄**：每次自動修正都在 Task 與 PR 上留言，註明是哪個來源觸發。

---

## 6. Runner

### 6.1 Pairing 與 Dispatch

- **Local Runner**：Member 在 Electron 登入後自動完成 Pairing，Runner 綁定該 Member。
- **Team Runner**：Admin 在 UI 產生 Team token，Runner 用這組 token 完成 Pairing。
- **派工規則**：
  - Run 選擇「在我的電腦跑」→ 只有負責人的 Local Runner 會領取。
  - Run 選擇「Team Runner」→ 進入 Team 佇列。
  - Local Runner 離線時，Run 停在佇列中，**不會自動轉給 Team Runner**。
- **Dispatch 協定**：每次 Dispatch 有唯一的 Dispatch ID；Runner 定時送心跳。過期 Dispatch 回報的結果會被拒絕。
- **版本相容**：協定帶版本號，不相容時 UI 提示更新，不會靜默失敗。

### 6.2 Worktree 管理

- **路徑**（盡量短）：
  - Windows：`C:\ob\<repo>\<task-key>-<run-seq>`
  - macOS／Linux：`~/.orbis/wt/<repo>/<task-key>-<run-seq>`
  - git 跑在 WSL 時，Worktree 放在 WSL 的檔案系統內，不放在 `/mnt/c`。
- **分支名稱**：`orbis/<task-key>-<slug>`。Child Run 的分支是 `orbis/<task-key>-<slug>--c<n>`。
  - **注意**：分支名稱不可以用 `/c<n>` 當後綴，因為 git 不允許 `a` 與 `a/b` 兩個分支同時存在。
- **Base**：
  - Task 的 Run 從 Repo 的 base ref 開出，預設是 `origin/<default-branch>`。
  - `branch` 模式的 Child Run 從**父 Run 當下的 HEAD** 開出。
- **建立 Worktree 的流程**：
  1. 執行 `git fetch`。
  2. 執行 `git worktree add`。
  3. 依 `shared_dirs` 建立連結（Windows 優先用 junction，失敗才用 symlink）。
  4. 依 `copy` 複製檔案。
  5. 事先寫入各 Agent 的「信任此資料夾」設定。
  6. 執行 `setup`。
  7. 啟動 Agent（`wait_for_setup = true` 時，要等 setup 跑完才啟動）。
- **刪除保護**：
  - 分支上還有未合併的 commit 時，保留分支（UI 顯示為「保留的分支」）。
  - 拒絕刪除家目錄或 Worktree 根目錄以外的路徑。
  - `archive` hook 失敗時擋下刪除。
  - 父 Run 被中止或封存時，連同 Child Run 一起處理。
- **設定的信任核准**：`.orbis/config.toml` 中的腳本第一次執行前要人工核准；檔案內容（hash）改變後要重新核准。

### 6.3 `.orbis/config.toml`

```toml
[worktree]
setup = "pnpm install --frozen-lockfile"   # 建立 Worktree 後執行
archive = "pnpm run clean"                 # 刪除前執行，失敗會擋下刪除
wait_for_setup = true
shared_dirs = []                           # 例如 [".cache/huggingface"]；預設不共用 node_modules
copy = [".env", ".env.local"]              # 從主 checkout 複製（只限字面路徑）

[preview]
command = "pnpm dev --port $ORBIS_PORT"
ready_path = "/"

[verify]
commands = ["pnpm lint", "pnpm test"]

[permissions]
allow_commands = ["pnpm *", "git status", "git diff *"]

[delegation]
enabled = true
allowed_agents = ["claude-code", "codex", "gemini", "grok"]
```

- **注入的環境變數**：`ORBIS_ROOT_PATH`、`ORBIS_WORKTREE_PATH`、`ORBIS_PORT`（每個 Worktree 分到不同 port）、`ORBIS_RUN_ID`、`ORBIS_TASK_KEY`。
- **setup 腳本的執行方式**：
  - Windows：預設用 `cmd`；腳本以 `#!` 開頭而且有 Git Bash 時，改用 Git Bash。
  - macOS／Linux：用 `sh`。

### 6.4 程序與 Windows 規則

- Windows 上，每個 Run 的程序樹放在一個 **Job Object** 中，方便中止與清理；macOS／Linux 用 process group。
- **持續讀取** Agent 的 stdout，避免 backpressure 讓 session 卡住。
- **路徑處理**：
  - 一律正規化：統一磁碟代號大小寫、處理 WSL 的 `/mnt/<drive>` 路徑。
  - spawn 的參數自行加引號，以處理含空白的路徑（例如 `Program Files`）。
  - 透過 `.cmd` shim 解析 npm 安裝的 CLI。
- **長路徑**：Worktree 根目錄保持短路徑，並偵測 Git for Windows 的「path too long」錯誤，在 UI 上提示。
- **無人值守**：關閉 git 的互動式憑證提示（`GIT_TERMINAL_PROMPT=0` 與 `GCM_INTERACTIVE=never`）。

---

## 7. Agent 整合

- **介面**：ACP v1（[ADR-0002](adr/0002-acp-as-agent-interface.md)）。Runner 只有一個 `AcpAgentAdapter`，各 Agent 的差異寫在 Agent Profile 中：
  - 啟動指令與 Windows shim
  - 認證方式的對應
  - 從 `initialize` 讀出的能力旗標
  - 已知問題的修補（例如隱藏不支援的 slash command）
- **對內契約**：Runner 對內使用自己的正規化 Event 模型，不直接傳遞 ACP 的原始型別。
- **後備方案**：遇到 ACP 做不到的需求（例如 hooks、fork、精確的 plan mode 控制），再加一個 `ClaudeSdkAdapter`，對外仍然是同一個 `AgentAdapter` 介面。
- **Phase 1 正式支援的 Agent**：

| Agent | 接入方式 | 備註 |
|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` adapter | plan mode 與 bypassPermissions 有已知 bug |
| Codex | `codex-acp` adapter | `CODEX_PATH` 含空白時會失敗 |
| Gemini CLI | 原生 `gemini --acp` | 路徑檢查區分大小寫 |
| Grok Build | 原生 `grok agent stdio` | beta；需要 SuperGrok 系列訂閱 |

  registry 中其他支援 ACP 的 Agent 列為「實驗性」。
- **Credential**（[ADR-0005](adr/0005-shared-subscription-on-team-runner.md)、[ADR-0007](adr/0007-no-agent-credentials-on-server.md)）：
  - Local Runner 只沿用各 CLI 自己的登入狀態，Orbis 不讀取、不保存。
  - Team Runner **共用一個 Claude 訂閱**，Credential 存放在 Runner 主機的 Docker secret 中。設定頁會顯示條款風險警告。
- **並行與額度**：
  - 每組 Credential 的並行上限**預設 30**，超過的 Run 進佇列排隊。
  - 偵測到 rate limit 時，該 Run 暫停，等額度恢復後再繼續。**不會自動改用其他 Agent。**
  - UI 顯示各組 Credential 的用量與排隊數。

---

## 8. Permission Policy

Runner 一律以「會詢問」的模式啟動 Agent，再**由 Runner 依政策回覆 `session/request_permission`**（[ADR-0006](adr/0006-runner-enforced-permission-policy.md)）。不使用 Agent 的 bypass 旗標。

| 等級 | 自動允許 | 問人 | 一律拒絕 |
|---|---|---|---|
| `manual` | — | 全部 | 寫入主分支、刪除 Worktree 以外的檔案 |
| `auto`（預設） | 在 Worktree 內讀寫檔案、`allow_commands` 中的指令 | 白名單以外的指令、存取 Worktree 以外的路徑、`git push --force`、安裝全域套件 | 同上 |
| `yolo` | 全部 | — | 寫入主分支 |

- **問人時**：請求加入 Needs You，並發出桌面通知；等待期間 Run 暫停。
- **`yolo` 的使用時機**：Team Runner 的容器中可以直接使用；Local Runner 要手動選擇，而且 UI 會顯示警告。
- **Child Run**：權限繼承父 Run，只能更嚴格，不能更寬鬆。
- **Phase 1 不做 OS 層級沙盒**。

---

## 9. Delegation

Runner 在每個 ACP session 的 `session/new` 中注入 **Orbis MCP server**（stdio）。工具如下：

| 工具 | 說明 |
|---|---|
| `delegate(agent, prompt, mode)` | 產生 Child Run；`mode` 為 `consult` 或 `branch` |
| `get_run(run_id)` / `wait_run(run_id)` | 查詢 Child Run 的狀態，或阻塞等待它跑完並取得結果 |
| `list_runs()` | 列出目前 Run 的所有 Child Run |
| `merge_child(run_id)` | 把 `branch` 模式的子分支 merge 進父分支；有衝突時交給父 Agent 解決 |
| `ask_parent(question)` | Child Run 向父 Run 提問，阻塞等待回答 |
| `propose_tasks(spec, tasks[])` | 提出 Draft Task（含 Acceptance Criterion 與相依關係） |
| `update_task_note(task_id, note)` | 在 Task 上留下進度或決策紀錄 |

- **模式**：
  - `consult`：在父 Run 的 Worktree 中以唯讀模式執行。
  - `branch`：開出子 Worktree 與子分支。
  - `shared` 模式**不提供**。
- **防護規則**：
  - 深度最多 2 層。
  - 每個 Run 最多同時有 5 個 Child Run。
  - Child Run 計入並行上限。
  - Project 可以設定允許分派的 Agent，或直接關閉 Delegation。
- **UI**：Child Run 以樹狀結構顯示在 Task 下，每個節點標示 Agent、model、狀態與用量，可以單獨中止。
- **人也能觸發**：在留言中 @agent（例如 `@claude 幫我看這段`）會建立一個 `consult` Run（§12）。
- **權限限制**：Agent 不能直接修改 Task 的狀態、指派對象與 Acceptance Criterion。

---

## 10. Review

- **Diff review**：用 Monaco 顯示 diff，比較對象是 base_commit 與 Worktree 目前的狀態。行內留言可以打包送回 Agent，作為下一個 prompt。
- **Review Gate 的動作**：核准（接著自動 push 並開 PR）、退回（附上留言）、中止 Run。
- **Project 可以要求**「Member 不能核准自己的 Task」。

---

## 11. GitHub 整合

- **GitHub App**：
  - 讀寫 Issues、接收 webhook（issues、pull_request、pull_request_review、check_suite、check_run）。
  - Team Runner push 時使用 installation token。
- **Local Runner push**：使用 Member 自己的 git 憑證。
- **Issues 雙向同步**：
  - 同步欄位：title、body（對應 Task 描述）、state、assignee、labels。衝突時以最後寫入者為準。
  - Agent 專用的欄位只存在 Orbis，Issue 上只放一則狀態摘要留言，並且持續更新。
- **不串 GitHub Projects。**

---

## 12. 協作

### 12.1 即時共同編輯

- **範圍**：Task 描述、Acceptance Criterion，以及存在資料庫的 Spec。
- **技術**：Yjs、TipTap，經由 Server 的 WebSocket 同步；顯示其他人的游標與在線狀態。Yjs 文件的快照存在 Postgres。
- **Repo 內的 Spec**：在 UI 中共同編輯一份草稿，按下「提交到 repo」後才變成 commit。Agent 要修改時，以 PR 的形式提出，不直接覆蓋草稿。
- **不做**程式碼的共同編輯。

### 12.2 Role

| 能力 | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| 管理成員、Team Runner、Credential 的並行上限 | ✅ | ✅ | | |
| 修改 Permission Policy、核准 config 的信任 | ✅ | ✅ | | |
| 派工到 Team Runner | ✅ | ✅ | ✅（Project 可以關閉） | |
| 建立與編輯 Task、派工到自己的 Local Runner | ✅ | ✅ | ✅ | |
| 核准 Gate、開 PR | ✅ | ✅ | ✅（Project 可以禁止核准自己的 Task） | |
| 查看與留言 | ✅ | ✅ | ✅ | ✅ |

- Project 可以覆寫個別 Member 的 Role。
- 權限檢查只在 Server 端做；UI 只負責隱藏沒有權限的操作。

### 12.3 通知與 @mention

- **通知管道**：App 內的通知中心，加上 Electron 的桌面通知。發送層要設計成可以擴充管道的介面（email、Slack 留到之後）。
- **觸發通知的事件**：
  - 權限請求（Needs You）
  - Gate 等待核准
  - Verification 連續失敗 3 次
  - Feedback Loop 達到次數上限
  - 被 @mention
  - 被指派 Task
  - 自己的 Task 被 merge 或被退回
- **@mention 可以用在**：Task 留言、Spec 共同編輯、diff 行內留言。
- **@agent**：觸發一個 `consult` Run。
- **個人設定**：可以依事件類型關閉通知，也可以設定勿擾時段。

---

## 13. Preview 與瀏覽器

- **啟動**：Runner 依 `[preview].command` 用 `ORBIS_PORT` 啟動 dev server，並以 `ready_path` 判斷是否已就緒。
- **本機開啟**：Electron 用 WebContentsView 直接打開 `localhost:$ORBIS_PORT`。
- **分享給 Team**：Runner 把 Preview 的 HTTP 與 WebSocket 流量**經由既有的 Runner 通道**轉送到 Server，產生 `https://<server>/preview/<run-id>/`，限同 Team 登入後才能存取。
- **在 Preview 上留言**：在內嵌的瀏覽器中點選元素留言，自動附上截圖、selector 與 URL，送回 Agent 作為下一個 prompt。
- **Agent 操作瀏覽器**：Runner 額外注入 Playwright MCP（headless），連到同一個 Preview，用來判定 `browser` 類型的 Acceptance Criterion。UI 顯示截圖與操作紀錄。即時觀看 Agent 的瀏覽器畫面留到 Phase 2。

---

## 14. 資料與 Event 儲存

- Runner 把正規化後的 Event **即時串流**到 Server，存進 Postgres 的 `run_events` 表（JSONB，依 run_id 與 seq 排序）。
- **大型內容**（完整的檔案內容、截圖）另外存成 blob，Event 中只放參照；預設保存 **90 天**。
- **斷線處理**：Runner 斷線時，Event 先暫存在本機，重新連上後以 seq 補送。UI 可以從 Event 重播整個 Run。
- **遮蔽**：Event 送出前，Runner 先遮蔽看起來像 secret 的字串。

---

## 15. 安全與憑證

- **Server 的資料庫不存任何 Agent Credential。** Server 只知道各 Runner 能跑哪些 Agent，以及各 Credential 的並行上限。
- `.env` 這類檔案只在 Runner 本機複製，**不會上傳到 Server**。
- **登入方式**：GitHub OAuth；Runner 用 Pairing token；Preview 網址需要登入 session。

---

## 16. 部署與發布

- **Server**：用 Docker Compose（Postgres 加 Server）自架，Team Runner 也加在同一份 compose 檔中。託管部署的文件（Neon 搭配 Fly.io 或 Railway 等）留到 Phase 2。
- **Desktop**：
  - 用 electron-builder 打包，electron-updater 從 private GitHub Releases 自動更新。
  - Phase 1 不做 Windows 程式碼簽章。
  - Runner 執行檔隨 Electron 一起打包。
- **Team Runner**：以 Docker image 發布。

---

## 17. 測試策略

- **Fake Agent**（`crates/fake-agent`）：依 YAML 劇本送出訊息、tool call、diff、權限請求、plan、錯誤、rate limit。**所有整合測試都用它**，不呼叫真實模型。
- **Runner**：單元測試，加上使用真實 git worktree 與 Fake Agent 的整合測試。CI 在 Windows、macOS、Linux 三平台都跑。
- **Server**：用 Testcontainers 啟動真實的 Postgres 來測試。
- **Web**：用 Playwright 跑端到端測試，測試對象是接上 Fake Agent 的完整系統。
- **真實 Agent 煙霧測試**：Claude Code、Codex、Gemini、Grok 各跑一個小 Task；只在手動觸發或每晚定時跑。

---

## 18. 範圍

| Phase 1（約 10 週） | Phase 2 | 不做 |
|---|---|---|
| §1–§17 全部，但不包含右邊兩欄 | Team Runner 的容器隔離與 `yolo`、best-of-N 的 UI、即時觀看 Agent 的瀏覽器畫面、託管部署的文件、email／Slack 通知、`ClaudeSdkAdapter`（需要時才做） | 手機 App、Linear／Jira／Azure DevOps、GitHub Projects、OS 層級沙盒、Windows 程式碼簽章、跨 Repo 的 Task、`shared` Delegation 模式、程式碼的共同編輯 |

---

## 19. 待決事項

- **Preview 的路徑前綴問題**：`/preview/<run-id>/` 這種路徑式代理，會讓使用絕對路徑載入資源的前端 app 壞掉（例如 Vite 的 `base` 預設是 `/`）。
  - 選項一：改用子網域模式 `https://<run-id>.preview.<domain>`，需要 wildcard DNS 與 wildcard 憑證。
  - 選項二：要求專案在 config 中設定 `base`。
  - 要在 Track E 開始做 Preview 轉送之前決定。
- **Repo 可見度**：目前假設是 private，尚未確認。
- **共用訂閱的條款風險**：見 [ADR-0005](adr/0005-shared-subscription-on-team-runner.md)。
