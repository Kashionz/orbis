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

- **手動轉換**：看板上只能把 Task 在 Backlog 與 Ready 之間移動。拖到 Running 欄會打開派工對話框，派工成功才轉換。其他轉換都由系統觸發：派工、Runner 的 Event、Gate 的決定、GitHub webhook。合法的轉換表定義在 `packages/api-contract`，Server 的狀態機與 Web 共用同一份。
- **進入 Ready 的條件**：已指定 Repo、描述不為空或有連結的 Spec、至少一條 Acceptance Criterion。`depends_on` 中還有 Task 沒有 Done 時，不能派工。
- **Run 失敗，或在 Review Gate 被中止**：Task 回到 Ready，可以重新派工。
- **回合結束**：Agent 結束回合後，Runner 先送出 Run 的完整 diff（§10），再回報等待 Review Gate。Review Gate 期間 Run 不會結束，退回時在同一個 session 繼續。
- **核准之後**：Task 立刻進入 PR Open。Runner 結束 Agent 程序、push 分支，**push 成功後 Run 才算 `completed`**。push 失敗時 Run 不會是 `completed`，並加入 Needs You。
- **GitHub 觸發的轉換**：見 §11。

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

- **Local Runner**：Member 在 Electron 登入後自動完成 Pairing，Runner 綁定該 Member。流程見 §16.1。
- **Team Runner**：Admin 在 UI 產生 Team token，Runner 用這組 token 完成 Pairing。
- **派工規則**：
  - Run 選擇「在我的電腦跑」→ 只有派工者本人的 Local Runner 會領取（「我」是派工的人，不是 Task 的負責人）。
  - Run 選擇「Team Runner」→ 進入 Team 佇列。
  - Local Runner 離線時，Run 停在佇列中，**不會自動轉給 Team Runner**。
  - **改派**也遵守上面的規則：Dispatch 逾時或 Runner 離線過久時，Run 回到佇列重新派工；「在我的電腦跑」的 Run 只會再派給派工者本人的 Local Runner。
  - Runner 在心跳中回報是否接受新的 Dispatch（Desktop 的「暫停領取」）。不接受時，Server 不派工給它。
  - 每次連線後，Server 收到第一個 Heartbeat 才知道 Runner 是否接受派工，所以在那之前不派工；`agent_availability` 只記錄，不觸發派工。
- **Pairing token**：Local Runner 的 Pairing token 由已登入的 Member 取得，綁定本人；Team Runner 的由 Admin 以上產生。token 只能用一次，Server 只存 hash。
- **撤銷**：Member 可以撤銷自己的 Local Runner，Admin 以上可以撤銷任何 Runner。撤銷時立刻斷線。
- **Dispatch 協定**：每次 Dispatch 有唯一的 Dispatch ID；Runner 定時送心跳。過期 Dispatch 回報的結果會被拒絕。
- **版本相容**：協定帶版本號，不相容時 UI 提示更新，不會靜默失敗。
- **協定的 frame**：定義在 `crates/orbis-protocol`。Runner 連到 Server 的 WebSocket 端點 `/runner`，每個 frame 是一個以 `type` 區分種類的 JSON 物件。

  | 方向 | frame |
  |---|---|
  | Runner → Server | `hello`、`heartbeat`、`agent_availability`、`dispatch_accept`、`dispatch_reject`、`event`、`run_control_result` |
  | Server → Runner | `hello_ack`、`hello_rejected`、`dispatch_offer`、`run_control`、`event_ack` |

  - 連線後 Runner 先送 `hello`（協定版本與 Pairing token，或已配對的 Runner token）。Server 回 `hello_ack`（Runner ID、第一次 Pairing 時發的 Runner token、心跳間隔、各 Run 已收到的最後 seq），或回 `hello_rejected` 並附上原因。
  - Runner 收到 `hello_ack` 後，先送 `agent_availability`，接著依間隔送 `heartbeat`。
  - 分支名稱由 Server 產生，放在 `dispatch_offer` 中。Worktree 路徑由 Runner 依 §6.2 計算，建好後以 `worktree_ready` Event 回報。
  - 改派時，`dispatch_offer` 帶上該 Run 已收到的最後 seq，新的 Dispatch 從下一個 seq 接續。
  - 每個 `run_control`（取消、後續 prompt、回覆權限請求、Gate 結果、push 分支）都會收到一個 `run_control_result`，以 `control_id` 對應。Run 因此產生的後續變化仍以 Event 回報。
- **Runner 的本機目錄**（`~/.orbis/`）：
  - `runner.toml` 給人編輯：Server 網址、Runner 名稱、Worktree 根目錄、port 範圍、Repo 對應到本機 checkout（`[repos.<key>] path`）、額外的 ACP Agent（`[agents.<id>] command／args／env`）。
  - `runner/` 是狀態目錄：依 Server 網址分開保存的 Runner token、port 分配、信任核准紀錄、Event 暫存、Runner 代管安裝的 ACP adapter。
  - `--home` 或 `ORBIS_HOME` 覆寫整個目錄（測試用）；`ORBIS_RUNNER_STATE_DIR` 只覆寫狀態目錄（Desktop 代管的 Runner 用，不和手動啟動的 Runner 共用 Runner token）。
  - 已保存這個 Server 的 Runner token 時，Pairing token 會被忽略。
- **重新連線**：斷線後以指數退避重新連線（1 秒到 60 秒，加上 ±20% jitter）。`hello_ack` 的 `resume` 沒有列出、但 Runner 還在執行的 Run，Runner 會中止並清除暫存。Runner 重新啟動時，暫存中沒有結束的 Run 補上 `agent_crashed` 與 `failed`。
- **sidecar 的結束碼**：0＝正常結束；78＝Runner token 無效或已被撤銷，需要重新 Pairing（sidecar 模式下 Runner token 被撤銷時不改用 Pairing token）；76＝協定版本不相容，需要更新 Runner；其他非 0 視為當掉。
- **Server 的實作參數**：
  - Pairing token 的有效期限：Local Runner 10 分鐘（Desktop 登入後立刻使用），Team Runner 24 小時。
  - `dispatch_offer` 30 秒內沒有回覆就過期，Run 回到佇列重新派工。
  - 超過 3 個心跳間隔（預設間隔 15 秒）沒有 `heartbeat`，視為離線：這台 Runner 上進行中的 Dispatch 全部過期並改派。逾時之前重新連上，沿用原本的 Dispatch。
  - Runner 拒絕某個 Run 之後，60 秒內不再把同一個 Run 派給它；Runner 送出新的 `agent_availability` 時解除。
  - 派工與逾時每秒檢查一次。
  - `run_control` 送出前先存進 `run_controls`，收到 `run_control_result` 時記下結果。還沒有結果的指令，在 Runner 重新連上、或接受改派的 Dispatch 時補送（改派時換成新的 Dispatch ID），Server 重新啟動後也一樣。

### 6.2 Worktree 管理

- **路徑**（盡量短）：
  - Windows：`C:\ob\<repo>\<task-key>-<run-seq>`
  - macOS／Linux：`~/.orbis/wt/<repo>/<task-key>-<run-seq>`
  - git 跑在 WSL 時，Worktree 放在 WSL 的檔案系統內，不放在 `/mnt/c`。
- **來源 repo**：
  - Runner 預設把 Repo clone 到 `<Worktree 根目錄>/<repo>/_main`，Worktree 從這份 clone 開出。
  - Member 可以在 Runner 的本機設定中，把 Repo 對應到自己的 checkout（例如 `D:\code\web`）。有對應時，Worktree 從那份 checkout 開出，`copy` 也從那裡複製。
  - 沒有對應時 `copy` 不生效，因為 Runner 自己的 clone 中沒有 `.env` 這類檔案。
  - `ORBIS_ROOT_PATH` 是這份來源 repo 的路徑。
- **分支名稱**：由 Server 產生，格式是 `orbis/<task-key>-<slug>`。Child Run 的分支是 `orbis/<task-key>-<slug>--c<n>`。同一個 Task 的第 2 個以後的 Run（例如失敗後重新派工），分支加上 `-r<序號>`，例如 `orbis/ORB-12-login-fix-r2`，避免和前一個 Run 保留下來的分支衝突。
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
- **設定的信任核准**：
  - `.orbis/config.toml` 中的腳本第一次執行前要人工核准；檔案內容（hash）改變後要重新核准。
  - 核准以權限請求的形式加入 Needs You，只有 Admin 以上能回覆（§12.2）。
  - Runner 一律從 base commit 讀取 config，Agent 在 Worktree 中修改 config 不會生效。

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

[git]
commit_message = "{task_key}: {title}"     # push 前自動 commit 未提交的變更時使用的訊息
```

- **push 前的自動 commit**：Worktree 中還有未 commit 的變更時，Runner 在 push 前自動 commit。訊息格式可以用 `[git].commit_message` 設定，預設是 `<TASK-KEY>: <title>`。

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
  - 交給其他程式啟動的執行檔路徑超過 `MAX_PATH` 時，Runner 改用 `\\?\` 形式。例如狀態目錄很深時，Claude Code adapter 內附的 `claude.exe` 會透過 adapter 的 `CLAUDE_CODE_EXECUTABLE` 傳入。
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
| Claude Code | `@agentclientprotocol/claude-agent-acp` adapter | 版本鎖定（目前 0.94.0），由 Runner 以 npm 安裝在狀態目錄的 `agents/`，以 `node` 直接啟動；plan mode 與 bypassPermissions 有已知 bug，建立 session 後一律切回 `default` 模式 |
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
- **誰的 Needs You 清單會出現**：
  - 權限請求依「誰有權回覆」即時決定（見下方「誰可以回覆」）。Team 內所有未回覆、而且本人有權回覆的請求，都會出現在本人的清單。
  - Gate 與停下來的 Run 仍指派給特定的 Member（Task 負責人；沒有負責人時給派工者），清單中會濾掉本人不能核准的 Gate。
  - Project 禁止核准自己的 Task 時，Review Gate 該通知誰，留到之後的通知設計再決定。
- **`yolo` 的使用時機**：Team Runner 的容器中可以直接使用；Local Runner 要手動選擇，而且 UI 會顯示警告。
- **Child Run**：權限繼承父 Run，只能更嚴格，不能更寬鬆。
- **Phase 1 不做 OS 層級沙盒**。
- **誰可以回覆**：
  - Local Runner 上的權限請求，只有該 Runner 的擁有者能回覆。
  - Team Runner 上的權限請求，Project 中 Role 至少是 Member 的人都能回覆。
  - 設定的信任核准（§6.2）一律只有 Project 中 Admin 以上能回覆，不論 Runner 種類：Local Runner 上的 Run 也一樣，Runner 擁有者不是 Admin 時不能回覆。
- **派工時的選擇**：
  - 能派工的人都可以選 `manual` 或 `auto`，預設為 Project 的預設政策。
  - `yolo` 只能在「在我的電腦跑」時選，UI 會顯示警告。Team Runner 的 `yolo` 留到 Phase 2。
  - 修改 Project 的預設政策需要 Admin 以上（§12.2）。
- **已知落差**：Agent 自己的設定中允許的工具不會詢問 Runner，例如 Claude Code 的 `.claude/settings.json`。
  - Phase 1 接受這個落差。各 Agent Profile 在 AgentAvailability 中回報落差，派工對話框顯示警告。
  - `auto` 下，寫入 `.claude/settings.json`、`.claude/settings.local.json` 一律問人。
  - 每次啟動 session 前，Runner 比對 Worktree 中這兩個檔案與 base commit。有差異就停下來加入 Needs You，人允許後才啟動。
  - 完全攔截（由 Runner 代為執行檔案與指令操作）留到之後再做。

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
- **Project 可以要求**「Member 不能核准自己的 Task」。「自己的 Task」指 Task 的指派對象，所有種類的 Gate 都適用。
- **diff 的來源**：
  - Agent 結束回合、進入 Review Gate 之前，Runner 送出 Run 的完整 diff：從 base_commit 到 Worktree 目前的狀態，包含未 commit 的變更。
  - 內容是每個檔案的完整新舊內容，大檔放 blob（§14）。
  - Server 保存這份 diff，所以 Runner 離線時仍然可以 review，重播時也看得到。
- **行內留言**存在獨立的資料表中，每則一筆（之後的 @mention 與通知會用到）。退回時打包成 prompt 送回 Agent。

---

## 11. GitHub 整合

- **GitHub App**：
  - 讀寫 Issues、接收 webhook（issues、pull_request、pull_request_review、check_suite、check_run）。
  - Team Runner push 時使用 installation token。
- **Local Runner push**：使用 Member 自己的 git 憑證。
- **Issues 雙向同步**：
  - 同步欄位：title、body（對應 Task 描述）、state、assignee、labels。衝突時以最後寫入者為準。
  - Agent 專用的欄位只存在 Orbis，Issue 上只放一則狀態摘要留言，並且持續更新。
  - **同步範圍**：
    - 有 Repo 的 Task 自動建立對應的 Issue。Project 可以關閉「自動建立 Issue」，預設開啟。
    - Draft Task 確認、進入 Backlog 之後才建立 Issue。
    - GitHub 上新開的 Issue 不會自動變成 Task，要在 Orbis 中匯入，因為同一個 repo 可能登記在多個 Project。
  - **狀態對應**：
    - Task 轉 Done → 關閉 Issue；Task 離開 Done → 重新打開 Issue。
    - 在 GitHub 上關閉 Issue → Task 轉 Done，並記錄關閉原因：取自 GitHub 的 `state_reason`，值為 `completed` 或 `not_planned`。UI 以不同標記區分這兩種 Done。
    - Task 有進行中的 Run 時，拒絕上一條的轉換：把 Issue 重新打開，並在狀態摘要留言中說明。
    - 重新打開 Issue → Done 的 Task 回到 Backlog，清空關閉原因。
  - **誰的修改算數**：只有 Project Member，或對 repo 有 write 以上權限（admin、maintain、write）的人，在 GitHub 上對 Issue 的修改才會同步回 Orbis。其他人的修改會被改回 Task 的值，並在狀態摘要留言中說明。Feedback Loop 判斷「有寫入權限的人類」也使用同一套檢查。
  - **同一個 Issue 對應到多個 Task**：同一個 GitHub repo 可以登記在多個 Project，所以一個 Issue 可能對應到不同 Project 的 Task；同一個 Project 的 Repo 中最多對應一個 Task。
    - 每個 Task 各有一則狀態摘要留言。
    - Issue 關閉時，這些 Task 都會轉 Done。其中任一個 Task 有進行中的 Run 時，依上面的規則拒絕：重新打開 Issue，所有 Task 都不轉換。
    - title 與 body 經由 Issue 在這些 Task 之間同步：任一個 Task 的修改先寫到 Issue，再同步到其他 Task。
  - **GitHub App 的安裝狀態**：訂閱 `installation` 與 `installation_repositories` 兩個 webhook，即時更新 Repo 的 installation id。UI 依此提示哪些 Repo 還沒安裝 GitHub App。
    - 登記 Repo 時，如果 App 已安裝，就從 GitHub 讀取 default branch；還沒安裝時，用輸入值，沒有輸入就用 `main`。
- **PR 與 Task**：PR merge → Task 轉 Done，關閉原因為 `completed`；PR 沒有 merge 就關閉 → Task 退回 Review Gate。
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

- Project 可以覆寫個別 Member 的 Role，但不能覆寫成 Owner。
- 建立與修改 Project、登記 Repo、設定 Project 的 Role 覆寫與政策：Admin 以上。
- 只有 Owner 能指派或移除 Owner；不能移除或降級最後一位 Owner。
- 新增 Member 時，先以 GitHub login 查出數字 user id 再保存，之後一律以 user id 比對，因為 login 可以改名。
- 權限檢查只在 Server 端做；UI 只負責隱藏沒有權限的操作。

### 12.3 通知與 @mention

- **通知管道**：App 內的通知中心，加上 Electron 的桌面通知。發送層要設計成可以擴充管道的介面（email、Slack 留到之後）。
  - Electron 的桌面通知目前只涵蓋 Needs You：Desktop 每 5 秒輪詢 Needs You 清單，出現新項目時發出原生通知（§16.1）。
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
- **Phase 1 的即時更新**：Needs You 的數量、桌面通知與看板都以輪詢取得（每 5 秒），之後再換成推送。即時推送只用於 Run 的 Event。
  - Web 的 WebSocket 是 `/api/ws`，以 session cookie 認證，而且 Origin 必須是 Web 的 origin。訊息定義在 `packages/api-contract` 的 `ws.ts`。
  - Web 送 `subscribe_run { runId, afterSeq }`，Server 先從資料庫重播 `afterSeq` 之後的 Event，再接上即時串流，只送連續的 seq，不漏也不重。不再需要時送 `unsubscribe_run`。
  - Server 以 `run_events { runId, events }` 批次送出：重播時一則最多 500 筆，即時推送時通常一則一筆。
  - 每條連線最多訂閱 50 個 Run，超過時回 `limit_exceeded`。其他錯誤：訊息格式不對（`invalid_message`）、Run 不存在或不屬於這個 Team（`not_found`）、沒有權限（`forbidden`）。
  - 訂閱期間每 30 秒重新檢查 session 與權限。session 失效時以 close code 4401 關閉連線；沒有權限時停止推送該 Run。

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
  - Runner 以 HTTP `PUT` 上傳 blob，以 Runner token 認證，Server 驗證 SHA-256 與大小。
    - 路徑是 `PUT /api/runner/blobs/<blob_id>?run_id=<Run>&sha256=<hex>`，body 是內容本身，`Content-Type` 是 media type。`blob_id` 由 Runner 產生。
    - Runner 只能把 blob 掛在自己正在執行（或剛執行完）的 Run 上。單一 blob 最大 64 MiB，讀取 body 時就檢查，超過回 413。
    - 同一個 `blob_id` 重送相同內容視為成功，可以安全地重試；內容不同回 409。
    - Web 以 `GET /api/blobs/<blob_id>` 下載，需要能查看該 Run。只有圖片直接顯示，其他內容一律以附件下載；過期回 410。
  - 上傳成功後，Runner 才送出參照它的 Event。
  - 到期的 blob 會被清除（Server 每小時檢查一次），但 **`run_events` 不刪**：Run 永遠可以完整重播，到期的內容顯示為已過期。
  - Review 用的完整 diff（§10）也存在 `run_events` 中。**超過 90 天的 Run，review diff 中放在 blob 的大檔案無法顯示**，只剩檔案清單與內嵌的小檔案。
- **斷線處理**：Runner 斷線時，Event 先暫存在本機，重新連上後以 seq 補送。UI 可以從 Event 重播整個 Run。
  - Server 以 `event_ack` 回報每個 Run 已連續保存的最大 seq，Runner 據此清除本機暫存。
- **過期 Dispatch**：Runner 送出的 `event` frame 帶有 Dispatch ID。不屬於該 Run 目前 Dispatch 的 Event，Server 一律拒絕。存進 `run_events` 的只有 run_id、seq、ts 與 Event 內容，不含 Dispatch ID。
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
  - **Runner sidecar**：Electron 以子程序啟動 Runner，兩者以 stdio 溝通。協定定義在 `crates/orbis-protocol`。
    - Runner 的 stdout 每行一個 JSON 狀態，包括連線狀態、執行中的 Run、是否暫停領取。
    - stdin 每行一個 JSON 指令：暫停領取、恢復、關閉。
    - log 一律走 stderr。
    - stdin 關閉也視為關閉指令，所以 Electron 當掉時 Runner 會自己結束。
  - Electron 把 Server 的 API origin 交給 Runner，Runner 直接連 `<server>/runner`。
    - 取得方式：Desktop 用 Web 的 origin 呼叫 `/api/health`，回應中的 `apiOrigin` 是 Server 設定的公開網址。開發時這個請求經過 Vite 的 `/api` proxy；正式部署時兩者通常是同一個 origin。
    - 使用者只要填一個網址。回應沒有 `apiOrigin` 時，退回使用 Web 的 origin。
  - **登入與登出**：
    - 偵測到 Web UI 登入後，Electron 取得 Local Runner 的 Pairing token 並啟動 Runner。
    - 登出時，Web UI 先呼叫 Desktop 的 bridge（`beforeLogout()`）。不是在 Desktop 中執行時沒有 bridge，直接登出。
    - 如果還有 Run 執行中，Desktop 先詢問使用者；使用者取消時不登出。
    - 確認後，先撤銷這台 Local Runner，再停止 Runner、清除本機狀態，最後 Web UI 才真正登出。
    - Server 端也會撤銷：Pairing 時記下取得 Pairing token 的 session。登出或清除過期 session 時，Server 會撤銷由這個 session 配對的 Local Runner。所以 Desktop 當掉、或 session 自然過期時，Runner 也不會一直保持配對。
      - 撤銷時立刻斷線，Runner 上進行中的 Run 回到佇列；這個 session 取得、還沒使用的 Pairing token 也一併失效。
      - 過期的 session 每小時清除一次。
- **Team Runner**：以 Docker image 發布。

### 16.1 Desktop 殼

Desktop 只是 Web UI 的外殼（[ADR-0008](adr/0008-electron-desktop-shell.md)），另外代管 Local Runner、顯示系統匣與桌面通知。

- **Server URL**：
  - 第一次啟動時由使用者輸入 Web UI 的 origin，Desktop 以 `GET /api/health` 確認後存在本機設定中。
  - Runner 也連到同一個 origin 的 `/runner`。
- **安全設定**：
  - 主視窗啟用 `contextIsolation` 與 `sandbox`，不啟用 `nodeIntegration`。
  - preload 只暴露最小的 bridge：版本、用編輯器開啟 Worktree、在終端機開啟 Worktree。main 程序只接受來自 Server origin 主 frame 的呼叫。
  - 導覽只允許 Server origin 與 GitHub OAuth 的登入頁，其他 http(s) 連結用外部瀏覽器開啟，不開新視窗。
- **登入與 Pairing**：
  - main 程序監看 Server 的 session cookie，有變化時以 `/api/auth/me` 確認登入狀態。
  - 登入的人是某個 Team 的 Member 時，向 Server 取得 Local Runner 的 Pairing token，以環境變數交給 sidecar（不放在命令列上）。
  - Runner 完成 Pairing 後自己保存 Runner token，之後重新啟動都用它。
  - 登出時，Server 撤銷這個 session 配對的 Local Runner。Desktop 在 cookie 消失時停止 sidecar，並刪除 Runner 存在本機的狀態目錄。
- **Runner sidecar**：
  - 開發模式使用 `cargo build` 的產物，打包模式使用內建的執行檔。Desktop 代管的 Runner 使用自己的狀態目錄，不和手動執行的 Runner 共用 Runner token。
  - 以 `--sidecar` 啟動，透過 stdio 溝通：
    - stdout 每行一個狀態 JSON：連線中、已連線、離線，執行中的 Run 數，是否暫停領取。
    - stdin 每行一個指令：`pause_claiming`、`resume_claiming`、`shutdown`。
    - log 一律走 stderr，Desktop 寫到有大小上限、會輪替的 log 檔。
  - 當掉時以指數退避重啟（1 秒起、上限 60 秒，連續正常運作 60 秒後重置）。
  - 以「需要重新 Pairing」的結束碼結束時不重啟，而是重新取得 Pairing token。
  - **結束 App 時**：Desktop 送出 `shutdown` 並關閉 stdin，Runner 結束自己的 Run（§6.4）後退出。stdin EOF 也視為 shutdown，所以 Desktop 當掉時 Runner 也會自行結束。Runner 逾時沒有結束，Desktop 就強制結束整個程序樹：Windows 用 `taskkill /T`，macOS／Linux 用 process group。
- **系統匣**：
  - 顯示 Runner 狀態（連線中、已連線與執行中的 Run 數、離線）與 Needs You 的數量。
  - 提供「顯示視窗」「暫停領取新 Run」「開啟 Runner log」。暫停領取存在本機設定中，Runner 以 Heartbeat 告訴 Server 不要再派工。
  - 關閉主視窗只是縮到系統匣，結束 App 要用系統匣或選單。
- **桌面通知**：
  - 登入後每 5 秒輪詢 Needs You 清單。第一次輪詢只建立基準，之後新出現的項目各發一次原生通知。
  - 點擊通知後顯示主視窗，並前往對應的 Task 頁。
- **開啟本機工具**：
  - Run 頁面可以用設定的編輯器或終端機開啟 Worktree，兩者都提供預設選項與自訂指令（`{path}` 會換成 Worktree 路徑）。
  - Desktop 只接受 Worktree 根目錄（§6.2）底下 `<repo>/<Worktree>` 這一層、而且確實存在的目錄，並解析 symlink 確認沒有跳出根目錄。
  - 執行檔一律以絕對路徑啟動，不在目前目錄（Worktree）中搜尋。Worktree 的內容可能是 Agent 寫的。
  - Windows 上的 `.cmd` shim 經由 `cmd.exe` 執行，參數由 Desktop 自己加引號。

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
