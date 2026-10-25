# Orbis 架構設計

本文件是 Orbis 設計的唯一依據。名詞以 [GLOSSARY.md](../GLOSSARY.md) 為準；重大取捨的理由在 [adr/](adr/)；時程與分軌在 [PLAN.md](PLAN.md)。

---

## 1. 產品定位

- **使用者**：2–10 人的小團隊，作為內部工具使用。
- **核心迴圈**：Task（Spec 與 Acceptance Criterion）→ 派給 Agent，在隔離的 Worktree 中執行 → Verification → Review Gate → PR → merge 後 Task 自動轉為 Done。
- **差異化**（市場缺口，參考 Conductor、Superconductor、AQ、Nimbalyst、Nuphos、Orca）：
  1. PM 與 Agent 真正串成完整的 Task 生命週期，而不只是「從 issue 啟動 agent」。
  2. Windows 是一等公民（Windows 是主要測試平台）。目前以 Windows 與 macOS 為主：兩者都在 CI 驗證；Linux 的程式路徑保留，但暫時不在 CI 驗證。
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
                   Claude Code / Codex / Antigravity / Grok Build
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
| Web UI | `apps/web` | React、Vite、TanStack Router 與 Query、`diff`（行的增刪）、xterm.js、TipTap 與 Yjs |
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
Team 1─* Project 1─* Repo（GitHub Repo 或本機 Repo）
Project 1─* Task *─0..1 Repo（可以先不指定，補指定一次後不能再換）
Task 1─* TaskMember（Task 角色）*─1 Member
Task 1─* AcceptanceCriterion
Task *─0..1 RepoSpec（repo 內的 markdown spec，可以被多個 Task 連結）
Task *─* Task（depends_on）
Task 1─* Run 1─* Run（Child Run，深度 ≤ 2）
Run 1─* Event
Run 1─* Dispatch
Run 1─* AgentSegment（換 Agent 時依 Agent 分段的用量）
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
| Verifying | Agent 回報完成 | Server 送 `verify` 給 Runner，自動檢查 `command`、`agent`、`browser` 類型的條件（§5.1） |
| Review Gate | Verification 全數通過 | 人工 review diff；行內留言與 Preview 留言可以退回 Running（**同一個 Worktree、同一個 session**）；`manual` 條件全部打勾才能核准 |
| PR Open | Review Gate 通過 | 自動 push 並開 PR |
| Done | PR merge（webhook）、Review Gate 結束（沒有變更），或本機 Repo 的本機合併完成 | 自動轉換 |

- **手動轉換**：看板上只能把 Task 在 Backlog 與 Ready 之間移動。拖到 Running 欄會打開派工對話框，派工成功才轉換。其他轉換都由系統觸發：派工、Runner 的 Event、Gate 的決定、GitHub webhook。合法的轉換表定義在 `packages/api-contract`，Server 的狀態機與 Web 共用同一份。
- **進入 Ready 的條件**：已指定 Repo、描述不為空或有連結的 Spec、至少一條 Acceptance Criterion。`depends_on` 中還有 Task 沒有 Done 時，不能派工。
  - **不指定 Repo 的 Task**（[ADR-0011](adr/0011-one-repo-per-task.md) 的修訂）：建立時可以不指定 Repo，這種 Task 只能停在 Backlog（移到 Ready 回 409 `repo_required`），也不同步到 GitHub Issues。之後可以補指定一次，指定之後不能再換（`repo_already_set`）。
- **Run 失敗，或在 Review Gate 被中止**：Task 回到 Ready，可以重新派工。
- **回合結束**：Agent 結束回合後，Runner 先送出 Run 的完整 diff（§10），再回報等待 Review Gate。Review Gate 期間 Run 不會結束，退回時在同一個 session 繼續。
- **核准之後**：Task 立刻進入 PR Open。Runner 結束 Agent 程序、push 分支，**push 成功後 Run 才算 `completed`**。push 失敗時 Run 不會是 `completed`，並加入 Needs You。
- **本機 Repo 核准之後**（[ADR-0013](adr/0013-local-repo-and-connect-to-github.md)）：Server 送 RunControl `merge_local`，Runner 結束 Agent、自動 commit 未提交的變更，把 Run 的分支合併到本機 checkout 的基準分支（`local_merged` Event），Task 直接轉 Done（trigger `local_merge`，關閉原因 `completed`），接著封存 Worktree。
  - 基準分支沒有在 checkout 中簽出：在暫時的 worktree 中合併。已簽出且工作目錄乾淨：直接在 checkout 中合併。
  - 工作目錄有未 commit 的變更或合併衝突：不合併，Run 停下（Needs You 的 `reasonCode` 為 `local_merge_blocked`，`detail` 是 git 的輸出）。Runner 保留這個 Run；人處理好本機 checkout 後在待我處理按「重試」（`POST /api/runs/<run-id>/merge-local`，權限同核准 Review Gate），Server 以 Project 目前的設定重送 `merge_local`。
  - 合併方式是 Project 設定：squash（預設）或 merge commit。checkout 有 `origin` 時，Project 可以設定合併後 push 基準分支（預設關閉）；push 失敗不影響合併。
- **停下來的 Run**：Needs You 的 `stopped_run` 以代碼表示原因（`verification_limit`、`push_failed`、`pr_open_failed`、`local_merge_blocked`），附第幾輪（只有 `verification_limit`）與原始的錯誤訊息；給人看的文字由 UI 依代碼在地化。
- **diff 為空時**（Review Gate 送審的那份 diff 沒有任何檔案變更）：沒有東西可以 push，不能核准，改為**結束（沒有變更）**，也可以退回或中止。
  - Task 轉 Done，關閉原因是 `completed`（同步到 Issue 時一樣以 `completed` 關閉）；不 push、不開 PR。
  - Server 送 RunControl `cancel` 結束 Run（`canceled`），Worktree 與分支和中止一樣保留。
  - 權限與 `manual` 條件的要求都和核准相同。Gate 的決定記為核准，並標示為結束（沒有變更）。
  - Runner 不猜 Agent 是否出錯：只回答問題、本來就不需要改檔的 Task 也走這條路；Agent 把錯誤當成回覆時（§7），人看 Review Gate 上 Agent 最後的回覆（`final_message`）再決定退回。
- **GitHub 觸發的轉換**：見 §11。

### 5.1 Acceptance Criterion 類型

| 類型 | 判定方式 |
|---|---|
| `command` | 在 Worktree 執行指令，exit code 為 0 就算通過（指令來自 Task，或 `.orbis/config.toml` 的 `verify`） |
| `agent` | 另開一個獨立的 `consult` Run（唯讀），讀 diff 與 Spec 後逐條判定，並附上證據 |
| `browser` | Agent 透過 Playwright MCP 操作 Preview，附上截圖與操作紀錄作為證據（§13） |
| `manual` | 在 Review Gate 由人工打勾 |

- **流程**：主 Run 的 Agent 結束回合（`awaiting_gate`，review）後，沒有 `command`、`agent`、`browser` 類型的條件時直接進入 Review Gate；有的話 Server 送 RunControl `verify`，列出這一輪要檢查的條件。
  - Runner 回報 `verifying`，逐條執行。`command` 在 Worktree 執行；`agent`、`browser` 以 Orbis MCP 的 `delegate`（`purpose = verification`）請 Server 建立 `consult` Child Run 判定，`browser` 另外注入 Playwright MCP。
  - **`command` 的指令信任**：Task 上的指令 Member 就能改，卻在派工者的 Runner 執行。所以 Runner 先比對 Repo 設定檔（base commit）的 `[verify].commands` 與 `allow_commands`：在清單內直接執行；不在清單內照 Permission Policy 問人（`manual`、`auto` 都要問，`yolo` 自動允許），同一個 Run 中同一個指令只問一次。條件沒有指定指令時執行 `[verify].commands` 本身，不需要問。
  - **判定用的 Child Run**：`agent` 與 `browser` 類型各由一個 Child Run 一起判定（Agent 是 `verify` 指定的 judge，沒有指定時與被驗證的 Run 相同）。它以 Orbis MCP 的 `report_verdict` 逐條回報，只接受指派給它的條件；Child Run 結束時沒有回報的條件記為 `error`。
  - **`browser` 的瀏覽器**：Runner 管理的 Playwright MCP（`@playwright/mcp`，鎖定版本，第一次使用時安裝；`runner.toml` 的 `[browser_judge]` 可以換成別的指令）以 headless、isolated 啟動，`--allowed-origins` 只允許這個 Run 的 Preview（這只是盡力過濾，不處理 redirect，不是安全邊界）。判定用的 Child Run 在目前頁面上操作、讀取與截圖的工具自動允許，`browser_navigate` 只在網址的 origin 就是 Preview 時自動允許；執行任意程式碼（`browser_evaluate`、`browser_run_code`）、上傳本機檔案、開新分頁、安裝瀏覽器等其他工具照 Permission Policy 問人。截圖存成 blob，作為每條 `browser` 條件的證據。Preview 沒有在執行時記為 `error`。
  - 每條條件一筆 `verification_result` Event（`passed`、`failed`，或無法判定的 `error`，附證據），全部結束送 `verification_completed`，再回到 `awaiting_gate`（review）。
  - 結果與證據存在 `verifications` 與 `verification_results`，最新一次也寫回 Acceptance Criterion。
- **失敗重試**：Verification 失敗時，Server 自動把失敗原因以 `prompt` 送回原 Run 重試，第一輪之後**預設最多重試 3 次**（Project 可以設定，所以最多 4 輪），超過就停在 Verifying，加入 Needs You 並通知。`error`（無法判定）視為失敗。人可以選擇：
  - 附上意見再試一次（次數重新計算）。
  - 略過失敗，進入 Review Gate（Review 時看得到失敗的結果）。
  - 中止 Run，Task 回到 Ready。
- **`manual`**：在 Review Gate 由人打勾，全部打勾後才能核准。打勾必須是這個 Review Gate 建立之後做的：每次進入 Review Gate 都要針對這一版的修改重新打勾；Runner 回報的結果不能改到 `manual` 條件。
- Verification 結束後 Runner 會再送一次 `awaiting_gate`（review），Server 不把它當成新的回合結束（Run 之前的狀態是 `verifying`）。

### 5.2 Feedback Loop（PR 開出之後）

- **觸發來源**：只處理以 GitHub App 開出、有對應 Task 而且還開著的 PR。
  - 對 repo 有寫入權限的**人類** review 留言（與 §11「誰的修改算數」同一套檢查）。`commented` 與 `changes_requested` 的 review 會觸發；`approved` 的 review 一律不觸發，就算附了留言。PR 對話串的留言也算。
  - CI check 失敗：結論是 `failure` 或 `timed_out`（`cancelled`、`skipped`、`neutral`、`action_required` 不算）。
    - 只採用 PR 目前 head commit 的結果。
    - 等這個 commit 的 check suite 都完成，才把失敗的 check 合併成一次修正。沒有 check run 的 suite 不等，例如安裝了但沒在跑 check 的 App。
    - 同一個 check run 只觸發一次。
  - bot 留言預設不觸發，要在 Project 的白名單中才會觸發。GitHub App 自己的留言一律不觸發。
- **合併再送**：
  - 有內容、`changes_requested` 或兩則以上行內留言的 review，在送出時立刻觸發，同一份 review 的留言合併成一批。
  - 零散的留言在最後一則之後 2 分鐘才觸發，期間的留言合併成一批。零散的留言是只有一則行內留言的 review（GitHub 的「Add single comment」也會產生一份 review），以及 PR 對話串的留言。
  - 零散的留言還在等時送出了 review，就一起送出。
  - 同一個 PR 同時只有一次自動修正。修正還沒 push 時，新的回饋先暫存，修正 push 或 Run 沒有 push 就結束之後再送。review 與 CI 都在等時，先送 review。PR 有了新的 commit 之後，舊 commit 的 CI 結果作廢。
- **已知風險：CI 輸出的 prompt injection**：
  - check run 的 output 與 log 由建立它的 App 決定，這些內容會放進修正 prompt。
  - Phase 1 不設 CI App 的白名單，理由是只有 repo 的 admin 能把 App 裝到 repo 上，而且 CI 失敗就應該觸發。
  - 緩解：output 與 log 放在 code block 中當資料，並限制長度；prompt 中註明它們是 CI 產生的資料，不是給 Agent 的指示。
- **修正 Run**：Server 開一個新的主 Run（`origin = feedback_loop`），派給前一個 Run 所在的 Runner，沿用同一個分支與 Worktree，並以前一個 Run 的 session id 接續。Task PR Open → Running；修正照常經過 Verifying，通過後直接 push（不經過 Review Gate），Task 回到 PR Open。Run 沒有 push 就結束時，Task 也回到 PR Open。前一個 Run 的 Runner 不在線上時不開 Run。
- **次數上限**：每個 PR 自動修正最多 **5 次**，CI 與 review 分開計數。超過就停下並通知 Task 負責人。
  - 開成 Run 的修正才計入次數，之後 Run 失敗也算；Server 開不成 Run 的不算。
  - 第一次超過上限時，在 PR 上說明並通知負責人；之後同一個來源再觸發只記 log。
- **紀錄**：每次自動修正都在 Task（Task note）與 PR 上留下紀錄，註明是哪個來源觸發。
  - PR 上的紀錄留言列出觸發的留言或 check、這是第幾次；修正 push 後在同一則留言附上新的 commit，Run 沒有 push 就結束時也在同一則留言說明。
  - Task note 連到修正的 Run 與 PR 上的紀錄留言。開不成 Run 時，PR 與 Task 上都說明原因。
- **送回原 Run 的 session**：PR 開出後原 Run 已經 `completed`，所以每次修正都開一個**新的 Run**（`origin = feedback_loop`，以 `resumes_run_id` 連到前一個 Run）。
  - 派回前一個 Run 的 Runner，沿用同一個 Worktree 與分支。`dispatch_offer` 的 `continuation` 帶上前一個 Run 回報的 ACP session id（`agent_session` Event），Runner 以 `session/resume`（或 `session/load`）恢復；Agent 不支援或恢復失敗時開新的 session，並附上 Task 與目前 diff 的摘要。
  - **對齊遠端分支**：沿用 Worktree 時，Runner 在 `git fetch` 之後比較本機分支與 `origin/<branch>`（有人可能直接 push 到 PR 分支）。遠端是本機的後代時 `git merge --ff-only` 把本機分支 fast-forward 到遠端；兩邊分岔（或工作目錄有變更而無法 fast-forward）時不動本機，在修正 Run 的第一個 prompt 中說明分岔的 commit 數並請 Agent 先整合（例如 `git merge origin/<branch>`）。Agent 沒有整合時 `push_branch` 會以 non-fast-forward 失敗，錯誤訊息附上同樣的提示。Runner 不會替人合併或解衝突。
  - 修正後經過 Verifying，通過就直接 push（不經過 Review Gate，PR 上的人類 review 就是 Gate），Task 回到 PR Open。

---

## 6. Runner

### 6.1 Pairing 與 Dispatch

- **Local Runner**：Member 在 Electron 登入後自動完成 Pairing，Runner 綁定該 Member。流程見 §16.1。
- **Team Runner**：Admin 在 UI 產生 Team token，Runner 用這組 token 完成 Pairing。
- **派工規則**：
  - Run 選擇「在我的電腦跑」→ 只有派工者本人的 Local Runner 會領取（「我」是派工的人，不是 Task 的負責人）。
  - Run 選擇「Team Runner」→ 進入 Team 佇列。
  - Local Runner 離線時，Run 停在佇列中，**不會自動轉給 Team Runner**。派工對話框在 Runner 離線時仍然可以派工：Agent 沿用那台 Runner 最後回報的可用性，對話框提示 Run 會排隊、Runner 上線後才開始。
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
  | Runner → Server | `hello`、`heartbeat`、`agent_availability`、`dispatch_accept`、`dispatch_reject`、`event`、`run_control_result`、`tool_call`、`preview_response`、`terminal_output`、`terminal_exited`、`repo_spec_commit_result` |
  | Server → Runner | `hello_ack`、`hello_rejected`、`dispatch_offer`、`run_control`、`event_ack`、`tool_result`、`preview_open`、`terminal_open`、`terminal_input`、`terminal_resize`、`terminal_close`、`repo_spec_commit` |
  | 雙向 | `preview_window`、`preview_end`、`preview_reset`、`preview_ws_close` |

  - 協定版本 2（W5–7）新增 `tool_call`／`tool_result`（Orbis MCP 工具呼叫，§9）與 `preview_*`（Preview 通道，§13）。Preview 的資料（HTTP body、WebSocket 訊息）走 WebSocket binary 訊息：`[kind u8][stream_id u32 big-endian][payload]`，以 credit 控制背壓。
    - 單一訊息的 payload 最多 64 KiB。更大的 WebSocket 訊息切成多段，前面各段用 `ws_fragment`，最後一段用 `ws_text` 或 `ws_binary`；組回後最多 16 MiB，超過以 close code 1009 關閉。
    - 初始 credit：Server→Runner 方向固定 256 KiB；Runner→Server 方向由 `preview_open` 的 `window` 指定。
    - `worktree_ready` 帶 `preview_port`（沒有設定 `[preview]` 時缺少），Server 據此顯示 Preview 是「沒有設定」還是「啟動中」。
  - `run_control` 的動作：取消、後續 prompt（帶來源，例如 Review Gate 退回、Verification 重試、Feedback Loop）、回覆權限請求、Gate 結果、push 分支、`verify`（§5.1）、`archive`（§6.2 的封存）、`restart_preview`。
  - 協定版本 3（新工作區介面的後端缺口）：
    - `run_control` 新增 `withdraw_prompt`、`set_session_config`、`set_permission_policy`、`switch_agent`、`merge_local`（§5、§7）；`prompt` 加 `delivery`（`queue`／`interrupt`）。
    - Event 新增 `prompt_queued`、`prompt_withdrawn`、`run_settings_changed`、`agent_switched`、`local_merged`；`prompt_submitted` 與 `permission_resolved` 帶觸發它的 `control_id`，Server 據此填入 API Event 的 `actorMemberId`（Run 的第一個 prompt 的作者是派工的人）。
    - `agent_availability` 的 `models` 改成帶顯示名稱、標記與推理強度能力的物件，另帶 Agent 的顯示名稱、廠商、CLI 代號、登入狀態、登入方式（§7），以及 `runner.toml` 對應到本機 checkout 的 Repo key（`mapped_repos`，不含路徑）。
    - `dispatch_offer` 加 `effort`；`repo` 改成以 `kind` 區分 `github`（帶 clone URL）與 `local`（只有名稱），本機 Repo 在 `runner.toml` 找不到對應時以 `repo_unavailable` 拒絕。
    - 終端機的 frame 見 §6.5；`repo_spec_commit` 見 §12.1。

  - 連線後 Runner 先送 `hello`（協定版本與 Pairing token，或已配對的 Runner token）。Server 回 `hello_ack`（Runner ID、第一次 Pairing 時發的 Runner token、心跳間隔、各 Run 已收到的最後 seq、Runner 的種類 `runner_kind`），或回 `hello_rejected` 並附上原因。
    - `runner_kind`（`local`／`team`，協定版本 3 的選填欄位）讓 Runner 決定依種類而定的預設值，例如終端機的 `allow_terminal`（§6.5）；缺少時（舊的 Server）Runner 採用較嚴格的預設值。
  - Runner 收到 `hello_ack` 後，先送 `agent_availability`，接著依間隔送 `heartbeat`。
  - 分支名稱由 Server 產生，放在 `dispatch_offer` 中。Worktree 路徑由 Runner 依 §6.2 計算，建好後以 `worktree_ready` Event 回報。
  - 改派時，`dispatch_offer` 帶上該 Run 已收到的最後 seq，新的 Dispatch 從下一個 seq 接續。
  - 每個 `run_control`（取消、後續 prompt、回覆權限請求、Gate 結果、push 分支）都會收到一個 `run_control_result`，以 `control_id` 對應。Run 因此產生的後續變化仍以 Event 回報。
- **本機 Repo 的派工**（[ADR-0013](adr/0013-local-repo-and-connect-to-github.md)）：本機 Repo 只派給 `runner.toml` 有對應這個 Repo 名稱的 Local Runner（依 `agent_availability` 的 `mapped_repos` 判斷），Team Runner 不能選；派工對話框以 `repo_not_mapped` 標示不能派。Team 的其他人在自己的 `runner.toml` 設了同名對應，也可以派到自己的電腦。
- **Runner 的本機目錄**（`~/.orbis/`）：
  - `runner.toml` 給人編輯：Server 網址、Runner 名稱、Worktree 根目錄、port 範圍、Repo 對應到本機 checkout（`[repos.<key>] path`）、額外的 ACP Agent（`[agents.<id>] command／args／env`）。
  - `runner/` 是狀態目錄：依 Server 網址分開保存的 Runner token、port 分配、信任核准紀錄、Event 暫存、Runner 代管安裝的 ACP adapter。
  - `--home` 或 `ORBIS_HOME` 覆寫整個目錄（測試用）；`ORBIS_RUNNER_STATE_DIR` 只覆寫狀態目錄（Desktop 代管的 Runner 用，不和手動啟動的 Runner 共用 Runner token）。
  - 已保存這個 Server 的 Runner token 時，Pairing token 會被忽略。
- **重新連線**：斷線後以指數退避重新連線（1 秒到 60 秒，加上 ±20% jitter）。`hello_ack` 的 `resume` 沒有列出、但 Runner 還在執行的 Run，Runner 會中止並清除暫存。Runner 重新啟動時，暫存中沒有結束的 Run 補上 `agent_crashed` 與 `failed`。
  - **休眠與喚醒**：Runner 每次送 Heartbeat 時同時送 WebSocket Ping。超過 3 個心跳間隔（不低於 10 秒）沒有收到 Server 的任何訊息（含 Pong），或兩次 Heartbeat 之間系統時間跳了超過 2 個間隔（休眠喚醒、調時）而且接下來一個間隔內 Server 沒有回應 Ping，Runner 就自己關閉連線、依退避重連。喚醒後網路介面換了或 Server 早已因心跳逾時關閉時，半開的 TCP 連線送資料不會立刻失敗，單靠送 Heartbeat 失敗來發現要等很久。重連後 Outbox 補送沒有 ack 的 Event。
- **sidecar 的結束碼**：0＝正常結束；78＝Runner token 無效或已被撤銷，需要重新 Pairing（sidecar 模式下 Runner token 被撤銷時不改用 Pairing token）；76＝協定版本不相容，需要更新 Runner 或 Server（`hello_rejected` 的訊息會說是哪一邊，見 §16「版本相容」）；其他非 0 視為當掉。
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
  - **本機 Repo**：只依 `runner.toml` 的 `[repos.<名稱>]` 找 checkout，不 clone、不 fetch remote；Worktree 從基準分支（`base_ref` 就是基準分支本身）開出。
- **分支名稱**：由 Server 產生，格式是 `orbis/<task-key>-<slug>`。Child Run 的分支是 `orbis/<task-key>-<slug>--c<n>`。同一個 Task 的第 2 個以後的 Run（例如失敗後重新派工），分支加上 `-r<序號>`，例如 `orbis/ORB-12-login-fix-r2`，避免和前一個 Run 保留下來的分支衝突。
  - slug 取自 Task 標題：NFKC 正規化後保留字母與數字（含中文等 Unicode 字母，不做音譯），其他字元換成 `-`，最多 40 個字元；全是符號時用 `task`。所以分支名稱不會有 git 不允許的字元。
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
- **封存**（RunControl `archive`）：Server 在 Run 結束後送出，這時 Run 已不在 Runner 的記憶體中，Runner 依本機記下的 Worktree 紀錄（路徑、Repo、分支、base commit、讀設定檔的 commit）重建資訊後刪除。
  - **Server 送出的時機**：Task 轉 Done（PR merge、Issue 關閉）時，對該 Task 所有已 `completed` 的主 Run（人派工的 Run 與 Feedback Loop 接續的 Run，沿用同一個 Worktree）各送一次；Task 刪除時對在線上的 Runner 直接送一次（Run 隨 Task 刪除，不保留紀錄）。對象是 Run 最後一個 completed 的 Dispatch 與它的 Runner，不會改派；Runner 離線時留在 `run_controls`，重新連上後補送。
  - **不封存**：失敗或中止的 Run（包括 Review Gate 結束（沒有變更）後以 `cancel` 結束的 Run），Worktree 與分支保留給人檢查；重新派工用新的 Worktree。UI 上手動封存與保留期限留到 Phase 2。
  - Run 還在執行時拒絕（`invalid_state`），要先取消；還有執行中的 Run 沿用同一個 Worktree（Feedback Loop）時也拒絕。
  - `archive` hook 只用紀錄中那個 commit 的設定檔，而且只在這份設定檔已「永遠允許」時執行：Run 期間的「允許這次」已經失效，Run 結束後也沒有人可以問。沒有核准時回 `rejected`（`failed`），Worktree 不刪。沒有 hook 時直接刪。
  - `branch` 模式的 Child Run 一起刪；`consult` 模式的 Child Run 沒有自己的 Worktree。Worktree 已經不在時視為完成，重送的 `archive` 不會失敗。
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
allowed_agents = ["claude-code", "codex", "antigravity", "grok"]

[git]
commit_message = "{task_key}: {title}"     # push 前自動 commit 未提交的變更時使用的訊息
```

- **push 前的自動 commit**：Worktree 中還有未 commit 的變更時，Runner 在 push 前自動 commit。訊息格式可以用 `[git].commit_message` 設定，預設是 `<TASK-KEY>: <title>`。

- **注入的環境變數**：`ORBIS_ROOT_PATH`、`ORBIS_WORKTREE_PATH`、`ORBIS_PORT`（每個 Worktree 分到不同 port）、`ORBIS_RUN_ID`、`ORBIS_TASK_KEY`。
- **腳本的執行方式**（setup、archive、preview 相同）：
  - Windows：預設用 `cmd`；腳本以 `#!` 開頭時依 shebang 選：含 `pwsh` 或 `powershell`（例如 `#!pwsh`、`#!/usr/bin/env pwsh`）用 PowerShell（`pwsh -NoProfile -NonInteractive -Command`，沒有 pwsh 時用 Windows PowerShell 5.1），其他（`bash`、`sh`）用 Git Bash。
  - macOS／Linux：預設用 `sh`；shebang 含 `pwsh` 而且有安裝時用 pwsh。
  - **注入的變數在三種 shell 都能用**：腳本中引用上面 5 個注入變數時，`$ORBIS_PORT`、`${ORBIS_PORT}`、`%ORBIS_PORT%`、`$env:ORBIS_PORT` 任何一種寫法都可以，Runner 在交給 shell 前把它們改寫成該 shell 原生的寫法（cmd 用 `%NAME%`、PowerShell 用 `${env:NAME}`、bash／sh 用 `${NAME}`）。只改寫這 5 個變數，其他 `$`、`%` 原樣交給 shell；所以同一份 `config.toml` 的 `pnpm dev --port $ORBIS_PORT` 在 Windows 的 cmd 也會展開。

### 6.4 程序與 Windows 規則

- Windows 上，每個 Run 的程序樹放在一個 **Job Object** 中，方便中止與清理；macOS／Linux 用 process group。
- **持續讀取** Agent 的 stdout，避免 backpressure 讓 session 卡住。
- **路徑處理**：
  - 一律正規化：統一磁碟代號大小寫、處理 WSL 的 `/mnt/<drive>` 路徑。
  - spawn 的參數自行加引號，以處理含空白的路徑（例如 `Program Files`）。
  - 透過 `.cmd` shim 解析 npm 安裝的 CLI。
- **長路徑**：Worktree 根目錄保持短路徑；Runner 執行 git 時一律加 `-c core.longpaths=true`，Repo 內超過 260 字元的路徑也能 checkout、diff 與刪除（Runner 自己的檔案操作用 Rust 標準函式庫，長路徑會自動用 `\\?\` 形式）。仍然遇到 Git for Windows 的「path too long」錯誤（例如 Agent 或 setup 用的其他工具）時，以 `path_too_long` 回報並在 UI 上提示。
  - 交給其他程式啟動的執行檔路徑超過 `MAX_PATH` 時，Runner 改用 `\\?\` 形式。例如狀態目錄很深時，Claude Code adapter 內附的 `claude.exe` 會透過 adapter 的 `CLAUDE_CODE_EXECUTABLE` 傳入。
- **路徑含空白或非 ASCII 字元**（例如中文使用者名稱）：Runner home、狀態目錄、Worktree 根目錄、Repo 路徑、Agent 啟動指令都可以；整合測試的暫存目錄一律含空白，另有一組含中文的完整 Run 測試。
- **刪除重試**：防毒軟體或索引服務掃描時會短暫鎖住剛寫入的檔案，刪除 Worktree 會以「被另一個程序使用」失敗。Runner 以退避重試（0.2、0.5、1、2、4 秒，合計約 8 秒）：前兩次 `git worktree remove --force`，之後直接刪目錄再 `git worktree prune`；仍失敗才回報錯誤並說明可能被鎖住。
- **WSL**：
  - Windows 上的 Runner 需要 Git for Windows。啟動時執行 `git --exec-path`，不是磁碟代號開頭（例如 WSL 的 git 或 `wsl git` 的包裝回 `/usr/lib/git-core`）就以明確的錯誤拒絕啟動。
  - `runner.toml` 中對應的 checkout 或 Worktree 根目錄在 `\\wsl$\…`、`\\wsl.localhost\…` 時，建立 Worktree 以明確的錯誤拒絕：請把 Repo clone 到 Windows 磁碟，或改在 WSL 中執行 Runner（Linux 版，Worktree 放在 WSL 檔案系統內、不放 `/mnt/<drive>`）。Windows 這邊經由 9P 存取 WSL 檔案系統很慢，junction 與 `core.longpaths` 也不適用。
- **port**：Preview 的 port 從 `runner.toml` 的 `port_range`（預設 41000–41999）中挑，分配時實際 bind IPv4 與 IPv6 的 loopback 確認沒被占用；Windows 保留的範圍（Hyper-V、WSL 等，`netsh int ipv4 show excludedportrange protocol=tcp`）bind 會被拒絕，所以會被跳過。範圍用完時的錯誤訊息列出和範圍重疊的保留範圍並提示改 `port_range`。預設範圍不和 Windows、macOS 的 ephemeral 範圍（49152–65535）重疊；Linux 的 ephemeral 範圍（32768–60999）包含它，Linux 上要改 `port_range`（Linux 不在 Phase 1 驗證）。
- **無人值守**：關閉 git 的互動式憑證提示（`GIT_TERMINAL_PROMPT=0` 與 `GCM_INTERACTIVE=never`）。

### 6.5 互動式終端機

（[ADR-0014](adr/0014-interactive-terminal-through-runner.md)）

- Runner 在 Run 的 Worktree 中開 PTY（`portable-pty`，Windows 用 ConPTY），輸入輸出經由 Runner 通道到 Server，再經由專用的 WebSocket（`/api/terminals/<terminal-id>/ws`）到 Web 的終端機分頁（xterm.js）。
- **frame**：Server→Runner `terminal_open { terminal_id, run_id, cols, rows }`、`terminal_input`、`terminal_resize`、`terminal_close`；Runner→Server `terminal_output`、`terminal_exited { code, reason }`。資料以 base64 傳送，單一 frame 解碼後最多 64 KiB；沒有 credit 背壓，Runner 送出時排在 Event、control 與 Heartbeat 之後。每個 `terminal_open` 最後恰好有一個 `terminal_exited`（開不起來時也是，`reason` 說明原因）。
- **誰能用**：Local Runner 只限那台 Runner 的擁有者（和權限回覆的規則相同）；Team Runner 只限 Admin 以上，而且 Team 設定「允許 Team Runner 的終端機」預設關閉。Server 把 `terminal_id` 綁定到開啟者的 session，只轉送那個人的輸入；Runner 只接受自己開過的 `terminal_id`。
- **Runner 端的開關**：`runner.toml` 的 `allow_terminal`，Team Runner 預設 `false`、Local Runner 預設 `true`（種類取自 `hello_ack` 的 `runner_kind`，缺少時視為 `false`）。不允許時 `terminal_open` 回 `terminal_exited`（`reason = disabled`）。Team Runner 要同時打開 Team 設定與這個開關才能開終端機。
- 終端機是人自己下指令，不經過 Permission Policy。Server 只記錄誰在什麼時候開、關（`terminal_sessions`），不記錄按鍵與輸出。
- Worktree 存在期間都能用（Run 結束後也可以，Runner 依本機的 Worktree 紀錄找到路徑）；閒置 30 分鐘自動關閉；每個 Run 最多同時 3 個（`terminal_limit`）。Worktree 已封存時回 `worktree_archived`。
- WebSocket 關閉即關閉終端機，不支援重新接上。
- shell：Windows 預設 PowerShell，其他平台用 `$SHELL`；Runner 設定可以覆寫。

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
| Claude Code | `@agentclientprotocol/claude-agent-acp` adapter | 版本鎖定（目前 0.94.0），由 Runner 以 npm 安裝在狀態目錄的 `agents/`，以 `node` 直接啟動；plan mode 與 bypassPermissions 有已知 bug，建立 session 後一律切回 `default` 模式；預設不載入使用者全域設定（§8） |
| Codex | `@agentclientprotocol/codex-acp` adapter（內附相容的 `@openai/codex`） | 版本鎖定（目前 2.2.2），由 Runner 代管安裝、以 `node` 啟動；session 一律用 `read-only` 模式（修改檔案與連網先問），Codex 在自己沙盒中執行的唯讀指令不經過 Runner；`CODEX_PATH` 含空白時會失敗，Runner 只在內附執行檔路徑過長時才設定；需要先 `codex login` |
| Antigravity | Google 官方的 `agy_acp_server`（ACP Registry 的 `antigravity-acp`） | 只以 binary 發佈：Runner 從 `dl.google.com` 下載鎖定版本（目前 1.4.3）的 zip，比對寫死的 sha256（網路中斷時最多重試 3 次，sha256 不符不重試），解到狀態目錄的 `agents/` 後直接啟動；不使用第三方轉接程式。建立 session 後切到 `default` 模式（沒有就不啟動）；沒有 plan 模式。不沿用 agy CLI 的登入，第一次要執行 `orbis-runner login antigravity`（見下方）。取代 2026-06-18 停止個人方案的 Gemini CLI |
| Grok Build | 原生 `grok agent stdio --no-leader` | 使用者自己安裝；偵測版本，低於測過的最低版本（目前 1.0.52）時回報無法使用；不共用 leader 程序；beta；需要 SuperGrok 系列訂閱 |

  registry 中其他支援 ACP 的 Agent 列為「實驗性」。
- **實機驗證**（2026-10-24，Windows，使用者自己的帳號；`dev_dispatch` 扮演 Server，Task 是建立檔案 → Review Gate 退回一次 → 核准 → push）：
  - Claude Code、Grok Build：完整通過。
  - Codex：ACP 連線、session 建立與錯誤回報已確認。完整 Task 沒有跑完，原因是使用者的 `~/.codex/config.toml` 指定了 ChatGPT 帳號不支援的模型。
  - Gemini CLI（已由 Antigravity 取代）：ACP 連線與錯誤回報已確認，沒有 API key 時以 `agent_start_failed` 讓 Run 轉為 `failed`。
  - Delegation：Claude Code 經 Orbis MCP `delegate` 給 Codex（consult）→ `wait_run` 拿到 Child Run 的 `final_message`，整條流程通過。
  - Antigravity（agy_acp_server 1.4.3）：完整通過。`orbis-runner login antigravity` 下載官方 binary、比對 sha256，經瀏覽器以 Google 帳號登入；Task 中 session mode 已是 `default`（不需要切換），執行指令（`git status`）會送權限請求、經過 Permission Policy。能力：`loadSession`、`session/resume`、圖片；MCP 只宣告 http 與 sse。使用者的帳號被判定為 `free-tier`，Google 回了隱私聲明（資料處理條款依帳號方案而定）。
  - Antigravity 的 Delegation：`initialize` 雖然沒有宣告 stdio MCP，Orbis MCP bridge（stdio）仍能注入；Antigravity 經 `delegate` 給 Claude Code（consult）→ `wait_run` 拿到 Child Run 的 `final_message`，整條流程通過。它的工具標題是 `<server>_<工具>`（例如 `orbis_delegate`），實機時沒有被認成產品自己的 MCP 工具而去問人；已補上這個格式（判定用瀏覽器工具的 `playwright_browser_<名稱>` 也一樣）。
- **Agent 把錯誤當成回覆**（已處理，[#73](https://github.com/Kashionz/orbis/issues/73)）：Agent 回報模型錯誤（例如帳號不支援的模型）時，可能把錯誤當成一般回覆，並以 `end_turn` 結束回合。實機中 Codex 會這樣。
  - Runner 不猜錯誤，照常送出 diff（是空的）並進入 Review Gate。
  - Review Gate 的 diff 為空時，Server／UI 不送 `push_branch`。人在 Gate 上看 Agent 最後的回覆，選結束（沒有變更）或退回（§5）。
- **已知落差**：
  - Antigravity 會載入使用者全域的 MCP server 設定（`~/.gemini/config/mcp_config.json`，實機確認），其中的工具不經過 Runner，列在它的 Permission Policy 落差中。
  - Antigravity 的 rate limit 格式（目前沿用 Gemini API 的 `RESOURCE_EXHAUSTED`），以及是否仍讀取 Repo 的 `.gemini/`，還沒有在實機遇到，待確認。
- **由 Runner 代為登入**：Agent Profile 指定了認證方式的 Agent（目前只有 Antigravity，預設 `oauth-personal`）用 `orbis-runner login <agent>` 登入。
  - 這個子指令啟動 Agent、以指定的方式（`--method` 可以改）呼叫 `authenticate`，由 Agent 自己開瀏覽器並保存認證（Antigravity 存在 `~/.gemini/antigravity-acp/`），Runner 不讀也不存認證內容；10 分鐘內沒有完成就放棄。
  - 登入成功後，Runner 在狀態目錄記一個只有時間的標記（`agents/<agent>.login`）。沒有標記時，AgentAvailability 回報這個 Agent 無法使用（原因是要執行的登入指令），派工也以 `agent_unavailable` 拒絕。否則沒登入的 Agent 會被當成可用，Web 的派工對話框可能預設選到它。在其他 ACP client（例如 Zed）登入過的人也要再執行一次。
  - 之後 Run 遇到 ACP `auth_required`（例如認證過期）時，以 `agent_start_failed` 結束並提示登入指令，同時清掉標記，重送的 AgentAvailability 改成無法使用。
  - 其他 Agent 用自己的 CLI 登入。
  - **重新登入**：Agent Profile 提供登入方式（AgentAvailability 的 `login_hint`）：`runner`＝Desktop 在那台電腦上執行 `<Runner> login <agent>`；`cli`＝顯示在終端機要執行的指令。Team Runner 無法遠端互動登入，只顯示要在伺服器上執行的指令（限 Admin 以上）。
- **執行中傳訊息**：Run 在回合中或等待權限回覆時，人送出的訊息（RunControl `prompt`，`delivery = queue`）先排隊（`prompt_queued`），回合結束後 Runner 不進入 Gate，直接以排隊的訊息開始下一個回合，多則依序以空行合併成一則（每則各送一筆帶自己 `control_id` 的 `prompt_submitted`）。還在排隊的訊息可以收回（`withdraw_prompt`、`prompt_withdrawn`）。`interrupt` 先 `session/cancel` 目前的回合，回合結束後立即送出。Gate 等待時不用這條路，改用 Gate 的退回。
- **模型目錄與推理強度**：ACP 沒有 `session/set_model`，模型與推理強度屬於 `session/set_config_option` 的選項（類別 `model`、`thought_level`）。
  - Agent Profile 內建一份靜態清單：模型 id、顯示名稱、標記、推理強度能力（可調整／固定為某個等級／不支援），以及快速、標準、深度各自對應的 config option 值。Runner 記下每個 Agent 最近一次真實 session 回傳的 config option，之後回報以那一份為準（`source = session`），存在 Runner home。
  - Server 彙整目前 Member 可用的 Runner 回報的 AgentAvailability，提供模型目錄 API。
  - 派工時可以指定推理強度（`dispatch_offer` 的 `effort`），Runner 在 session 建立後以 config option 套用。
- **執行中切換設定**：模型與推理強度（`set_session_config`）在下一個回合開始前生效；Permission Policy（`set_permission_policy`）立即生效，從下一個權限請求開始套用。生效時 Runner 送 `run_settings_changed`，Agent 不支援的項目列在 `not_applied`。
- **換 Agent**（[ADR-0016](adr/0016-agent-switch-handoff.md)）：`switch_agent` 只在回合之間生效（回合中送出時等回合結束），只能換成同一台 Runner 上可以用的 Agent。Run id 與 Worktree 不變，Runner 結束舊的 session，以新的 Agent 開新的 session、依新 Agent 的 Agent Profile 重新套用 session mode，送出交接 prompt（來源 `handoff`）並送 `agent_switched`。用量與費用依 Agent 分段記錄：`agent_switched` 之後的 `usage` 是新的一段從 0 開始的累計值。Child Run 不受影響。
  - 交接 prompt 依序是：Task 的規格與驗收條件、人送出的所有 prompt、Agent 每個回合最後的回覆、目前的計畫、diff 摘要（改了哪些檔案、各增減幾行）、還沒處理的審查留言。規格、驗收條件與審查留言由 Server 放在 `switch_agent` 的 `handoff` 中，其他由 Runner 從 Event 與 Worktree 組出。不請舊的 Agent 寫摘要。
- **能力旗標與版本**：Runner 啟動後在背景對每個可用的 Agent 跑一次 `initialize`（不建立 session），把能力旗標與版本放進 AgentAvailability；無法啟動的 Agent 回報無法使用。Runner 代管、還沒安裝的 adapter 在第一次派工後更新。內容改變（能力旗標、並行數）時重送一次完整清單。
- **使用者全域設定**：Claude Code 見 §8。Codex（`~/.codex`）、Antigravity（`~/.gemini/antigravity-acp/settings.json`、`~/.gemini/config/mcp_config.json`）、Grok Build（`~/.grok`）沒有在 ACP 中關閉使用者設定的選項，它們設定中允許的工具不會詢問 Runner，列在各自的 Permission Policy 落差中。
- **Credential**（[ADR-0005](adr/0005-shared-subscription-on-team-runner.md)、[ADR-0007](adr/0007-no-agent-credentials-on-server.md)）：
  - Local Runner 只沿用各 CLI 自己的登入狀態，Orbis 不讀取、不保存。
  - Team Runner **共用一個 Claude 訂閱**，Credential 存放在 Runner 主機的 Docker secret 中。設定頁會顯示條款風險警告。
- **並行與額度**：
  - 每組 Credential 的並行上限**預設 30**，超過的 Run 進佇列排隊。
  - 偵測到 rate limit 時，該 Run 暫停，等額度恢復後在同一個 session 繼續。**不會自動改用其他 Agent。**
    - 恢復前，同一組 Credential 的新 Dispatch 一律以 `rate_limited` 拒絕（Server 本來就不會派，這是 Runner 端的保護），AgentAvailability 中使用這組 Credential 的 Agent 回報無法使用，原因寫上預計恢復的時間。
    - 各 Agent 的格式：Claude Code 以 `usage_update` 的 `_meta["_claude/rateLimit"]`（`status` 為 `rejected`、`resetsAt`）回報，回合本身可能照常結束；Codex 的回合以錯誤結束，`codexErrorInfo` 是 `usageLimitExceeded`／`rateLimitExceeded`；Antigravity（沿用 Gemini API 的格式，待實機確認）與其他 Agent 從錯誤訊息辨識（`RESOURCE_EXHAUSTED`、quota、429、rate limit），恢復時間從「retry in …」之類的文字讀出。讀不出恢復時間時等 60 秒。
  - UI 顯示各組 Credential 的用量與排隊數。
  - Server 依 Credential 排隊：派工時選定 Credential（放在 `dispatch_offer`），佔用名額的是 `dispatched` 到 `awaiting_gate`、`rate_limited` 的 Run（含 Child Run）。有效上限＝Admin 在 Server 的覆寫 ?? Runner 回報。
  - 一組 Credential 回報 rate limit 後，到恢復時間之前不派新的 Run 給它；Agent 沒有提供恢復時間時暫停 5 分鐘。
  - 沒有 Credential 的 Agent 不受 Server 的並行上限限制，由 Runner 自己控管。

---

## 8. Permission Policy

Runner 一律以「會詢問」的模式啟動 Agent，再**由 Runner 依政策回覆 `session/request_permission`**（[ADR-0006](adr/0006-runner-enforced-permission-policy.md)）。不使用 Agent 的 bypass 旗標。

| 等級 | 自動允許 | 問人 | 一律拒絕 |
|---|---|---|---|
| `manual` | — | 全部 | 寫入主分支、刪除 Worktree 以外的檔案 |
| `auto`（預設） | 在 Worktree 內讀寫檔案、`allow_commands` 中的指令 | 白名單以外的指令、存取 Worktree 以外的路徑、`git push --force`、安裝全域套件 | 同上 |
| `yolo` | 全部 | — | 寫入主分支 |

- **指令的判斷**（`auto`）：
  - 複合指令每一段都要符合規則；出現指令替換、變數展開、glob、子 shell 等字面分析無法掌握的語法時一律問人。
  - 每個引數都當成可能的路徑檢查（含 `--key=值` 與短參數直接接值的 `-f<值>`），用會解開 symlink／junction 的方式判斷是否在 Worktree 內；Worktree 內指向外面的連結視為在外面。
  - 會執行其他程式、寫檔或改寫 commit 的參數，即使符合 `allow_commands` 也一律問人，例如 `rg --pre`、`git grep -O`、`git diff/log/show --output`、`git -c`、`git commit -F/--template/--author/--amend`、`find -exec/-delete`、`pnpm exec/dlx`、`npx`、`xargs`。
  - **`allow_commands` 不是沙箱**：允許 `pnpm test`、`cargo test` 這類指令，本來就會執行 Agent 寫的程式碼（測試、package.json 的 script、build script）。白名單只減少詢問，不能限制 Agent 能做的事。
- **轉給人的選項**：選項名稱一律用 Orbis 的文字（依 kind）。Agent 自己的「永遠允許／永遠拒絕」會寫進 Agent 的設定檔、讓之後的請求不再經過 Runner，有對應的「這次」選項時不轉給人。
- **問人時**：請求加入 Needs You，並發出桌面通知；等待期間 Run 暫停。
- **誰的 Needs You 清單會出現**：
  - 權限請求依「誰有權回覆」即時決定（見下方「誰可以回覆」）。Team 內所有未回覆、而且本人有權回覆的請求，都會出現在本人的清單。
  - Gate 與停下來的 Run 仍指派給特定的 Member（Task 負責人；沒有負責人時給派工者），清單中會濾掉本人不能核准的 Gate。
  - Project 禁止核准自己的 Task、而且負責人在這個 Project 的有效 Role 是 Member 時，負責人不能核准，Gate 的 Needs You 不指派給特定的人：清單依授權即時計算，Project 中所有能核准的人都看得到，也都會收到通知。Plan Gate 與 Review Gate 都一樣。
- **`yolo` 的使用時機**：Team Runner 的容器中可以直接使用；Local Runner 要手動選擇，而且 UI 會顯示警告。
- **Child Run**：權限繼承父 Run，只能更嚴格，不能更寬鬆。
- **Phase 1 不做 OS 層級沙盒**。
- **誰可以回覆**：
  - Local Runner 上的權限請求，只有該 Runner 的擁有者能回覆。
  - Team Runner 上的權限請求，Project 中 Role 至少是 Member 的人都能回覆。
  - 設定的信任核准（§6.2）一律只有 Project 中 Admin 以上能回覆，不論 Runner 種類：Local Runner 上的 Run 也一樣，Runner 擁有者不是 Admin 時不能回覆。
- **執行中切換**：Run 執行中也可以換 Permission Policy（RunControl `set_permission_policy`），規則和派工時能不能選這個策略相同；從下一個權限請求開始套用。
- **派工時的選擇**：
  - 能派工的人都可以選 `manual` 或 `auto`，預設為 Project 的預設政策。
  - `yolo` 只能在「在我的電腦跑」時選，UI 會顯示警告。Team Runner 的 `yolo` 留到 Phase 2。
  - 修改 Project 的預設政策需要 Admin 以上（§12.2）。
- **使用者全域的 Agent 設定**：Claude Code 在 Run 中預設只載入 Repo 的 project／local 設定，不載入使用者全域的 `~/.claude/settings.json`（Runner 在 `session/new` 傳 claude-agent-acp 的 `settingSources`）。使用者自己的 allow 規則、plugin 與它帶的 MCP、hooks 都不會出現在 Run 中；登入不受影響。需要時可以在 runner.toml 的 `[agents.claude-code]` 設 `user_settings = true` 打開，AgentAvailability 的落差說明會跟著改變。其他 Agent 的使用者全域設定見 §7 的 Agent Profile。
- **已知落差**：Agent 自己的設定中允許的工具不會詢問 Runner，例如 Claude Code 的 `.claude/settings.json`。
  - Phase 1 接受這個落差。各 Agent Profile 在 AgentAvailability 中回報落差，派工對話框顯示警告。
  - 受保護的 Agent 設定由各 Agent Profile 列出：Claude Code 的 `.claude/settings.json`、`.claude/settings.local.json` 與 `.mcp.json`，Codex 的 `.codex/`、Antigravity 的 `.agents/` 與 `.gemini/`、Grok Build 的 `.grok/`（整個目錄）。這些位置不接受連結（symlink／junction）：Runner 不跟著連結讀，出現連結時只能還原或停止 Run。
  - `auto` 下，寫入這些設定一律問人。
  - 每次啟動 session 前，Runner 比對 Worktree 中這些設定與 base commit。有差異就停下來加入 Needs You，人允許後才啟動。
  - Agent Profile 指定的 session mode（例如 Claude Code 的 `default`、Codex 的 `read-only`）不存在於 Agent 回報的模式清單時，Agent 不啟動（避免停在會自動核准的模式）。
  - session 進行中，每個 tool call 結束與每個權限請求進來時也比對一次（經權限請求允許、明確寫入這些檔案的 tool call 除外）。發現 Agent 自己改了設定檔時，中止這個回合並問人：接受變更就繼續；選擇還原時，Runner 先結束 Agent 的程序樹、把檔案還原成已接受的內容，再重新啟動 Agent（Agent 可能已把新規則載入記憶體），以 `session/resume` 或 `session/load` 接續原本的 session，不支援時開新的 session 並附上原本的 prompt。
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
| `answer_child(run_id, question_id, answer)` | 父 Agent 回答 Child Run 的問題 |
| `propose_tasks(spec, tasks[])` | 提出 Draft Task（含 Acceptance Criterion 與相依關係） |
| `update_task_note(task_id, note)` | 在 Task 上留下進度或決策紀錄 |

- **工具呼叫的轉送**：Runner 把 Agent 的呼叫轉成 `tool_call` 送給 Server，Server 以 `tool_result` 回覆；防護規則一律以 Server 為準。斷線重連後 Runner 以同一個 `call_id` 重送，Server 依此去除重複。`wait_run`、`ask_parent` 在 Server 端阻塞到有結果為止；Server 關閉時中斷阻塞中的呼叫，不記下結果也不回覆，Runner 重新連上後以同一個 `call_id` 重送，Server 重新處理。
- **`ask_parent` 的回答**：父 Agent 在 `wait_run`、`get_run`、`list_runs` 的結果中看到待回答的問題，以 `answer_child` 回答。父 Run 的回合已經結束時，問題加入 Needs You，由人回答。
- **派工**：Child Run 一律派給父 Run 所在的 Runner；那台 Runner 沒有這個 Agent 時拒絕 `delegate`。
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
- **派給哪台 Runner**：Child Run 一律派給父 Run 所在的 Runner；那台 Runner 沒有這個 Agent 時拒絕 `delegate`。判定 Verification 的 `consult` Child Run 不受 Project 的 Delegation 設定限制，但仍受深度、數量與 Permission Policy 的限制。
- **父 Run 結束時**：還沒結束的 Child Run 一併取消；Child Run 的狀態不會改變 Task 的狀態。
- **ask_parent**：父 Run 的回合已經結束時，問題加入父 Run 負責人的 Needs You，由人回答。
- **權限限制**：Agent 不能直接修改 Task 的狀態、指派對象與 Acceptance Criterion。

---

## 10. Review

- **Diff review**：在工作區的差異分頁逐檔以行格顯示 diff，比較對象是 base_commit 與 Worktree 目前的狀態。點行號可以留行內留言，退回時打包送回 Agent，作為下一個 prompt。
- **Review Gate 的動作**：核准（接著自動 push 並開 PR）、退回（附上留言，包括 diff 行內留言與 Preview 留言，§13）、中止 Run。
  - diff 為空時沒有東西可以 push，核准改為**結束（沒有變更）**（§5）。
  - 差異分頁顯示說明與 Agent 最後的回覆（這份 diff 之前的 `final_message`），讓人判斷是本來就不需要改檔，還是 Agent 出了錯。
- **Project 可以要求**「Member 不能核准自己的 Task」。「自己的 Task」指 Task 的指派對象，所有種類的 Gate 都適用。
- **diff 的來源**：
  - Agent 結束回合、進入 Review Gate 之前，Runner 送出 Run 的完整 diff：從 base_commit 到 Worktree 目前的狀態，包含未 commit 的變更。
  - 內容是每個檔案的完整新舊內容，大檔放 blob（§14）。
  - Server 保存這份 diff，所以 Runner 離線時仍然可以 review，重播時也看得到。
- **行內留言**存在獨立的資料表中，每則一筆（之後的 @mention 與通知會用到）。退回時打包成 prompt 送回 Agent。
- **Preview 留言**（§13）和行內留言存在同一個資料表，種類是 `preview`，帶 URL、selector（一般瀏覽器中沒有）與截圖的 blob。URL 必須是這個 Run 的 Preview 網址，截圖必須是這個 Run 的 blob；沒有設定 Preview 網域時不接受 Preview 留言。退回時一起打包成 prompt，截圖以圖片附上。

---

## 11. GitHub 整合

- **GitHub App**：
  - 讀寫 Issues、接收 webhook（issues、pull_request、pull_request_review、check_suite、check_run）。
  - Team Runner push 時使用 installation token：**Phase 1 尚未實作**（`dispatch_offer` 沒有帶 token 的欄位）。Phase 1 的 Team Runner 以 Docker secret 給一個 GitHub token（fine-grained PAT 或機器帳號，只有 Contents 寫入權限），寫進容器 tmpfs 的 git credential store；installation token 的交換是 Phase 2 的項目。
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
    - **重新檢查**：漏掉 webhook 時（例如 App 在登記 Repo 之後才安裝，而本機收不到 webhook），Repo 設定頁可以重新向 GitHub 查詢安裝狀態。
      - 和登記 Repo 一樣，提出的人要是該 Project 的 Member，而且本人對 repo 有寫入權限；不符合時回應與「沒有安裝」相同，不改資料。
      - GitHub 上同名 repo 的 id 與登記時不同（刪掉後重建）時，不自動改綁。
      - App 確實沒有安裝時清掉 installation；repo 改名造成以名稱查不到時不清。
- **PR 與 Task**：PR merge → Task 轉 Done，關閉原因為 `completed`；PR 沒有 merge 就關閉 → Task 退回 Review Gate。
  - `pr_merged` webhook 記下 merge 的時間；API 的 Task 帶 PR 的號碼、網址、狀態、開出與 merge 的時間，事件串流依時間插入「開出合併請求」與「已合併」兩列。
- **本機 Repo**（[ADR-0013](adr/0013-local-repo-and-connect-to-github.md)）：沒有 GitHub 的 id 與 App 安裝狀態，不提供 Issues 同步與 Feedback Loop，相關 UI 隱藏；Repo Spec 直接 commit 到基準分支（§12.1）。
  - **連接到 GitHub**：Project 設定中的本機 Repo 填 owner 與 name，Server 確認 GitHub App 已安裝在那個 repo 上之後，`kind` 從 `local` 改成 `github`，只能單向（`manage_project`）。App 沒有安裝回 409 `repo_not_connected`（附安裝網址）；同一個 Project 已有這個 GitHub repo 回 409 `repo_exists`。
  - 前置條件：本機 checkout 的 `origin` 指向那個 GitHub repo，而且基準分支已 push。Orbis 不幫忙建立 GitHub repo（需要個人帳號的 `repo` scope，權限太大），畫面顯示可以照著執行的指令（例如 `gh repo create <name> --source . --push`）。
  - 之後以前的 Task 與 Run 照舊；新的 Run 核准後走 push 與開 PR；Issues 同步、Feedback Loop、Repo Spec 的 PR 從此啟用。連接時停在審查關卡的 Run，核准時依新的 `kind` 開 PR。
- **Member 的 email**：GitHub OAuth 請求 `user:email`，每次登入時以 `GET /user/emails` 取主要且已驗證的 email，寫進這個 GitHub 帳號所有的 Member 紀錄；沒有已驗證的 email 時為 null。已登入的人不強制登出，下次登入時補上。Task 邀請與預覽邀請以此比對。
- **不串 GitHub Projects。**

---

## 12. 協作

### 12.1 即時共同編輯

- **範圍**：Task 描述、Acceptance Criterion，以及存在資料庫的 Spec。
- **技術**：Yjs、TipTap，經由 Server 的 WebSocket 同步；顯示其他人的游標與在線狀態。Yjs 文件的快照存在 Postgres。
  - 第一次開啟時，Server 以資料庫中的內容（Task 描述、Acceptance Criterion 的描述）建立文件並立刻保存。修改後 debounce 1 秒寫回快照，並把文件轉成 markdown 回寫描述（Task 描述照常同步到 GitHub）。描述被 REST 或 GitHub 改掉時，Server 以新的內容取代文件。
  - 在線狀態中的 `memberId` 由 Server 填入；一條連線不能使用別人的 client id。
- **Repo 內的 Spec**：在 UI 中共同編輯一份草稿，按下「提交到 repo」後才變成 commit。Agent 要修改時，以 PR 的形式提出，不直接覆蓋草稿。
  - **提交到 repo**：
    - 從 default branch 開新的分支，以 GitHub App 身分 commit 草稿（`Co-authored-by` 提交者），再開 PR。提交者要能在該 Project 編輯 Task。只能提交 repo 內 `.github/` 以外的 `.md` 檔。
    - 同一份 Spec 已經有開著的 PR 時，在同一個分支上再 commit 一次並沿用 PR。內容沒變時不 commit。
    - repo 中的檔案在上一次提交之後被別人改過時照常開 PR，但在 PR 與回應中警告會覆蓋那些修改。
  - **版本**：Repo Spec 有一個整數版本，從 Orbis 提交的 PR 每 merge 一次 +1，並記錄 merge commit。PR 沒有 merge 就關閉時，版本不變。
  - **本機 Repo**：沒有 PR，「提交到 repo」直接 commit 到基準分支，版本在 commit 時 +1（內容沒變時不 commit）。Server 碰不到本機 checkout，所以把內容交給提交者自己、`runner.toml` 有對應這個 Repo 的 Local Runner（frame `repo_spec_commit`／`repo_spec_commit_result`），commit 的位置規則和本機合併相同（§5）；那台 Runner 不在線時回 409 `runner_offline`。
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
  - API 回傳的 Project 帶有目前登入者在這個 Project 的有效 Role（有覆寫時用覆寫），Web UI 依它隱藏操作，實際權限以 Server 為準。
- 建立與修改 Project、登記 Repo、設定 Project 的 Role 覆寫與政策：Admin 以上。
- 只有 Owner 能指派或移除 Owner；不能移除或降級最後一位 Owner。
- 新增 Member 時，先以 GitHub login 查出數字 user id 再保存，之後一律以 user id 比對，因為 login 可以改名。
- 權限檢查只在 Server 端做；UI 只負責隱藏沒有權限的操作。
- **Task 分享**（[ADR-0012](adr/0012-task-sharing-and-invites.md)）：Task 上另有一層成員與一般存取。
  - **Task 角色**：擁有者（建立 Task 的人，可以轉移）、可操作、可檢視。「可操作」的人在這個 Task 上可以編輯、派工、核准關卡、送 prompt，所以可以把 Team Viewer 在這個 Task 上調高；「可檢視」只能看。
  - **一般存取**：`invited`（僅受邀成員）、`team_view`（Team 可檢視）、`team_edit`（Team 可操作，預設，和沒有 Task 分享時相同）。限制時，不在 Task 成員中的人在這個 Task 上的權限降到對應的程度（`invited` 時看不到）。
  - **有效權限**：Owner、Admin 永遠完整，不受 Task 分享影響（避免 Task 被鎖住）；其他人取「Task 角色」與「一般存取限制後的 Team／Project Role」中較高的一個。Admin 層級的能力（權限策略、設定信任、Team Runner、Project 設定）不受 Task 角色影響。
  - `authorize()` 需要 Task 的能力（`edit_task`、`dispatch_*`、`approve_gate`、`view`）時一併傳入 Task；看板、待我處理、搜尋等列表濾掉看不到的 Task。API 的 Task 帶目前登入者在這個 Task 的有效權限（`viewerAccess`），Web UI 依它隱藏操作。
  - 管理分享：Task 的擁有者、Admin 以上。
  - **Task 邀請**：以 email 邀請還不是 Member 的人。邀請產生一條連結（只在建立時回傳一次，Server 只存 hash），有設定 SMTP（`<前綴>_SMTP_URL`、`<前綴>_SMTP_FROM`）時也寄信。對方以 GitHub 登入、已驗證的 email 等於受邀的 email 時（登入時 GitHub 帳號主要且已驗證的 email 存在 session 與這個帳號所有的 Member 紀錄中，還不是 Member 的人以 session 的比對），以 Viewer 身分加入 Team，再取得邀請時選的 Task 角色；不符時回 `invite_email_mismatch`。邀請 7 天後過期，可以撤銷。email 已經是某位 Member 的已驗證 email 時直接加進 Task，不產生邀請。

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
- **@agent**：觸發一個 `consult` Run，prompt 帶入留言與 Task 的上下文；Run 結束後 Agent 最後的回覆貼回成 Task 留言（作者是那個 Run）。
  - diff 行內留言讀被 review 的 Run 的 Worktree；Task 留言讀 Task 最近一個保留 Worktree 的主 Run。只有那個 Run 在 Team Runner 或留言者自己的 Local Runner 上時才沿用；否則派到留言者自己的 Local Runner，從 base ref 開唯讀 Worktree。不會在別人的電腦上替留言者跑 Agent，Run 一律記在留言者名下。
  - 留言者要能派工（Viewer 的 @agent 只記錄）；Repo Spec 草稿中的 @agent 只記錄（沒有 Task）。
- **@member**：通知被提及的人（同一個 Team 的 Member）。留言修改、共同編輯文件存檔時，只有新出現的 mention 才處理。共同編輯文件中只處理由 client 加入的 mention 節點（記錄加入的人與當時的目標），由描述重建的節點不算。
- **個人設定**：可以依事件類型關閉通知，也可以設定勿擾時段。
  - 依事件類型關閉時，App 內與桌面都不送。
  - 勿擾時段只抑制桌面推送，App 內照常記錄，結束後也不補推。
- **送達**：Web 經由 `/api/ws` 的 `notification` 訊息即時收到 App 內的通知（不需要訂閱，送到該 Member 的所有連線）；Electron 每 5 秒輪詢桌面通知 feed（已套用個人設定與勿擾時段）。
- **Phase 1 的即時更新**：Needs You 的數量、桌面通知與看板都以輪詢取得（每 5 秒），之後再換成推送。即時推送只用於 Run 的 Event 與 App 內的通知。
  - Web 的 WebSocket 是 `/api/ws`，以 session cookie 認證，而且 Origin 必須是 Web 的 origin。訊息定義在 `packages/api-contract` 的 `ws.ts`。
  - Server 以 `notification { notification }` 推送新的 App 內通知。
  - Web 送 `subscribe_run { runId, afterSeq }`，Server 先從資料庫重播 `afterSeq` 之後的 Event，再接上即時串流，只送連續的 seq，不漏也不重。不再需要時送 `unsubscribe_run`。
  - Server 以 `run_events { runId, events }` 批次送出：重播時一則最多 500 筆，即時推送時通常一則一筆。
  - 每條連線最多訂閱 50 個 Run，超過時回 `limit_exceeded`。其他錯誤：訊息格式不對（`invalid_message`）、Run 不存在或不屬於這個 Team（`not_found`）、沒有權限（`forbidden`）。
  - 訂閱期間每 30 秒重新檢查 session 與權限。session 失效時以 close code 4401 關閉連線；沒有權限時停止推送該 Run。

---

## 13. Preview 與瀏覽器

- **啟動與生命週期**：
  - Runner 依 `[preview].command` 用 `ORBIS_PORT` 啟動 dev server。執行方式與 setup 相同（§6.3），也注入相同的環境變數。程序樹放進 Run 的 Job Object 或 process group（§6.4）。
  - setup 成功後啟動，和 Agent 並行；沒有 setup 時，信任核准（§6.2）後啟動。dev server 持續到 Run 結束（包括等待 Review Gate 的期間），Run 結束或 Runner 關閉時一併結束整個程序樹。
  - 就緒判斷：每 500 毫秒對 `localhost:$ORBIS_PORT` 加上 `ready_path` 送 `GET`，同時嘗試 IPv4 與 IPv6（dev server 可能只綁 `::1`），收到 2xx 或 3xx 就送出 `preview_ready` Event。300 秒內沒有就緒時，結束程序並回報。
  - dev server 自己結束、逾時或無法啟動時，送出 `preview_stopped` Event，附上原因與遮蔽過 secret 的輸出尾段。UI 可以要求重新啟動（`restart_preview`）。
- **本機開啟**：Electron 用 WebContentsView 直接打開 `localhost:$ORBIS_PORT`。
- **Preview 網址（分享給 Team）**：
  - 子網域式：`https://<run-id>.<Preview 網域>/`。Preview 網域由 Server 的 `ORBIS_PREVIEW_DOMAIN` 設定（例如 `preview.example.com`），scheme 和 Web UI 相同。沒有設定時不提供 Preview 網址，本機開啟不受影響。
  - 不用路徑式（`/preview/<run-id>/`）的原因：
    - 路徑式要求每個專案設定 base path（Vite 的 `base`、Next.js 的 `basePath`）並處理寫死的絕對路徑。
    - 而且 Agent 寫的程式會在 Orbis 的 origin 上執行，可以用看的人的身分呼叫 Orbis API。
    - 子網域式讓每個 Run 是獨立的 origin，框架不需要任何設定。
  - **部署需求**：
    - wildcard DNS（`*.<Preview 網域>` 指向 Server）。
    - wildcard TLS 憑證（Let's Encrypt 只能用 DNS-01 驗證）。
    - 反向代理把 wildcard host 原樣轉給 Server。
    - 開發與測試時用 `<run-id>.preview.localhost:<port>`，Chromium 會把 `*.localhost` 解析到本機，不需要 DNS。
  - Preview 網域建議和 Web UI 是 same-site（例如同一個網域底下的子網域），瀏覽器版本才能用 iframe 嵌入；否則只能在新分頁開啟。
- **登入保護（換票）**：
  - Orbis 的 session cookie 只屬於 Web UI 的 host，不會送到 Preview 網址，所以第一次開啟時要換票：
    1. Preview 網址沒有 preview cookie 時，頁面導覽轉到 Web UI 的 `/api/preview/<run-id>/authorize`。其他請求（含 WebSocket upgrade）回 401。
    2. authorize 確認 session，並確認登入的人能查看這個 Run（同 Team，含 Viewer），然後發一次性、60 秒有效的 ticket，再轉回 Preview 網址的 callback。callback 路徑以 `/__<product slug>/` 開頭，例如 `/__orbis/callback`。
    3. callback 設定 host-only、HttpOnly 的 preview cookie，再導回原本的路徑。
  - preview session 綁定 Orbis 的 session：登出或 session 過期後，最多 5 秒內失效。preview session 與 ticket 只存在 Server 的記憶體中，Server 重新啟動後使用者會自動重新換票。
  - Server 對寫入型 API 檢查 `Origin`，避免 same-site 的 Preview 頁面帶著 Orbis 的 cookie 送出請求。
- **分享給團隊**：複製 Preview 網址即可，Team 裡能查看這個 Run 的人登入後就能開。
- **預覽邀請**（[ADR-0015](adr/0015-preview-invites.md)）：把 Preview 分享給特定的人（可以是其他 Team 的人或不屬於任何 Team 的人）。
  - Team 設定「允許對外分享預覽」，預設關閉，由 Admin（`manage_team`）打開；打開後，對這個 Task 有操作權限（`edit_task`）的人可以邀請與撤銷。關閉時回 403 `preview_sharing_disabled`。
  - 以 GitHub 帳號（邀請時查出 GitHub user id 並保存，登入時以 id 比對）或 email（以登入者 session 中的已驗證 email 比對）指定。每位受邀者各自一條邀請連結（Orbis 主網址的 `/preview-invites/<token>`，有設定 SMTP 時也寄信，沒有時由邀請人複製連結）。
  - 受邀者從連結進入、以 GitHub 登入，Server 確認在名單上而且邀請有效才發 ticket、轉到預覽子網域（和上面的換票流程相同）。不在名單上的人拿到連結也打不開。
  - 期限：1 小時、24 小時（預設）、7 天，可以個別撤銷；預覽停止或 Worktree 封存後全部失效。受邀者只能看預覽頁面，不會因此加入 Team，也看不到 Task。
  - 預覽分頁顯示受邀名單、期限與最後一次開啟的時間。Preview 的存取判斷除了 Project 的 `view`，也接受有效的邀請。
- **轉送**（[ADR-0010](adr/0010-preview-through-runner-channel.md)）：
  - Runner 把 Preview 的 HTTP 與 WebSocket（含 HMR）流量**經由既有的 Runner 通道**多工轉送：Server 依 Host 把 Preview 網址的請求交給對應 Run 的 Runner，每個請求或 WebSocket 是一條 stream。控制用 JSON frame，資料用 binary 訊息，避免 base64 的膨脹。
  - **背壓**：雙向以 credit 控制，每條 stream 的初始 window 是 256 KiB，每個 chunk 最大 64 KiB。接收端把資料寫出去（Server 寫給瀏覽器、Runner 寫給 dev server）後才補 credit。Runner 送往 Server 時，Preview 的資料排在 Event、control 與 Heartbeat 之後，大檔案不會卡住它們。
  - 超過 64 KiB 的 WebSocket 訊息拆成多段：前面各段是 `ws_fragment`，最後一段是 `ws_text` 或 `ws_binary`，接收端組回一則訊息；單則訊息上限 16 MiB，超過時以 1009 關閉。分段先收在記憶體中，所以收到就補 credit。
  - Runner 把 `Host` 改寫成 `localhost:$ORBIS_PORT`，`X-Forwarded-Host` 一律由原本的 Host 設定；`Origin` 只有和原本的 Host 相同時才改寫成 `http://localhost:$ORBIS_PORT`。dev server 因此視為本機請求：Vite 的 `server.allowedHosts`、Next.js 的 `allowedDevOrigins` 都不必設定。
  - Server 轉送前移除 Orbis 自己的 cookie、請求帶來的 `X-Forwarded-*` 與 `/__<product slug>/` 路徑，加上 `X-Forwarded-Proto`；回應的 `Set-Cookie` 移除 `Domain` 屬性，避免寫到其他 Preview 或 Web UI 的 host。
  - **只接受同一個 Preview 網址發出的請求**：其他 Run 的 Preview 和這個 Preview 網址是 same-site，會帶著 SameSite=Lax 的 preview cookie。所以除了 GET／HEAD 的頁面導覽（`Sec-Fetch-Mode: navigate`，例如點連結、Web UI 的 iframe）之外，`Sec-Fetch-Site` 不是 `same-origin`，或 `Origin` 不是這個 Preview 網址的請求一律回 403；其他 method 的導覽（例如跨站的表單 POST）也必須來自這個 Preview 網址。WebSocket 不受 CORS 保護，`Origin` 必須是這個 Preview 網址。回應加上 `Content-Security-Policy: frame-ancestors`，只有 Web UI 與 Preview 自己可以嵌入。
  - Runner 只轉送給執行中、而且 Preview 正在執行的 Run，每個 Run 最多 256 條 stream。Runner 離線、Run 已結束或 Preview 沒有在執行時，頁面導覽顯示說明頁。
- **在 Preview 上留言（Preview 留言）**：
  - 在 Electron 內嵌的瀏覽器中點選元素留言，自動附上截圖、CSS selector 與 URL。
  - 一般瀏覽器中不能選取元素，只能附整頁截圖：以 `getDisplayMedia` 擷取目前的分頁，再裁成 Preview 的範圍；不支援或使用者拒絕時，改成貼上或上傳圖片。
  - Preview 留言和 diff 行內留言一樣先存成草稿，Review Gate 退回時一起打包成 prompt 送回 Agent（§10），截圖以圖片附上。
  - 留言的權限和 Review Gate 退回相同；看 Preview 的權限是能查看該 Run。
- **Agent 操作瀏覽器**：Runner 額外注入 Playwright MCP（headless，只允許連到這個 Preview，§5.1），連到同一個 Preview，用來判定 `browser` 類型的 Acceptance Criterion。UI 顯示截圖與操作紀錄。即時觀看 Agent 的瀏覽器畫面留到 Phase 2。

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
  - 同一個路徑也支援 `GET /api/runner/blobs/<blob_id>`：Runner 下載 blob（同樣以 Runner token 認證），例如 Review Gate 退回時附上的 Preview 截圖。只能下載掛在這台 Runner 正在執行的 Run 上的 blob，其他回 404，過期回 410。
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
- **寫入型 API 檢查 Origin**：帶 session cookie 的寫入請求（GET、HEAD、OPTIONS 以外）有 Origin header 時，必須是 Web 或 Server 自己的 origin，否則回 403。Preview 的子網域和 Web 是 same-site，Agent 寫的頁面送出的請求會帶上 SameSite=Lax 的 cookie，要靠這項檢查擋下。WebSocket（`/api/ws`、共同編輯）在 upgrade 時同樣檢查 Origin。

---

## 16. 部署與發布

- **Server**：用 Docker Compose（Postgres 加 Server）自架，Team Runner 也加在同一份 compose 檔中（`deploy/docker-compose.yml`，操作見 [INSTALL.md](INSTALL.md)）。託管部署的文件（Neon 搭配 Fly.io 或 Railway 等）留到 Phase 2。
  - **Web 由 Server 提供**：正式部署時 Server 以 `WEB_DIR` 設定提供 `vite build` 的輸出（目錄中的檔案照常回應，其他不是 `/api` 的路徑回 `index.html`），Web 與 API 在同一個 origin，`API_ORIGIN` 等於 `PUBLIC_URL`。開發時 Web 仍由 Vite 提供並 proxy `/api`。
  - **image**：`apps/server/Dockerfile`（Node 24，以 tsx 執行 Server，同時建置 Web）與 `crates/runner/Dockerfile`（Rust 編譯 orbis-runner，執行層是 Node 24 加 git，讓 Runner 能安裝 ACP adapter）。Phase 1 在部署機自己 `docker compose build`；CI 只有 Windows 與 macOS runner，建不了 Linux image，發佈到 registry（GHCR）留到 Phase 2。
  - **migration**：Server 啟動時執行（只有一個 Server 實例），不另開一次性 service。
  - **Postgres 連線中斷**：`pg.Pool` 掛有 `error` listener，資料庫重新啟動或閒置連線被中斷時只記 log 並重新連線，Server 不會 crash。
  - **設定**：`deploy/.env`（Postgres 密碼、公開網址、OAuth App、GitHub App）；compose 以它做變數代換，Server 容器以 `env_file` 讀它。
- **Desktop**：
  - 用 electron-builder 打包，electron-updater 從 **public** GitHub Releases 自動更新（repo 維持 public）。push tag `v<版本>` 時由 workflow 在 Windows、macOS 建置並建立成 **draft** Release，人工 publish 後 Desktop 才會抓到；tag 必須和 `apps/desktop/package.json` 的版本一致。安裝與發布步驟見 [DESKTOP.md](DESKTOP.md)。
  - **Windows**：NSIS one-click、per-user 安裝。自動下載更新，下載完成後詢問「立即重新啟動並更新」或「稍後」；稍後就在結束 App 時安裝。安裝前先停止 Runner sidecar（還有 Run 在跑時再確認一次）。Phase 1 不做程式碼簽章，SmartScreen 會警告。
  - **macOS**：出 dmg 與 zip（arm64、x64 各一組）。Phase 1 不簽章也不 notarize，所以**不自動更新**：偵測到新版時提示「開啟下載頁／略過這個版本／稍後」，由使用者手動下載覆蓋。略過的版本記在本機設定，自動檢查時不再提示。簽章與自動更新排在 Phase 2。
  - **檢查時機**：App 啟動 30 秒後第一次，之後每 6 小時；系統匣與「檔案」選單可以手動檢查（手動檢查會回報已是最新或失敗）。同一個版本每次啟動只主動提示一次。只看已 publish 的 Release，不看 draft 與 pre-release。
  - Runner 執行檔隨 Electron 一起打包（`resources/bin/`），也隨 App 一起更新；Release 另附 Runner 的單獨執行檔給 Team Runner 與手動執行使用。
  - App 圖示排在 Phase 2，Phase 1 用 Electron 的預設圖示。
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
- **Team Runner**：以 Docker image 發布，在 compose 中是 profile `team-runner`。
  - **Credential 一律以 Docker secret 傳入**（`deploy/secrets/`：Pairing token、GitHub token、Agent 的 Credential、Codex 的 auth.json），由容器的 entrypoint 讀進 Runner 程序的環境變數（Agent 子程序繼承）或 tmpfs，不放在環境變數設定、compose 檔或 image 中（ADR-0007）。
  - Runner 的本機目錄（Runner token、Worktree）在 volume 中；`runner.toml` 以唯讀方式掛入。以非 root 使用者執行。
  - Phase 1 不支援需要瀏覽器登入的 Antigravity 與要自行安裝 CLI 的 Grok Build。
- **版本相容**：各元件不一定同時更新，不相容時 UI 明說要更新哪一個，不靜默失敗。
  - 三種版本號：Runner↔Server 的**協定版本**（`crates/orbis-protocol` 的 `PROTOCOL_VERSION`）、Server↔Web 與 Desktop↔Server 共用的 **API 版本**（`packages/api-contract` 的 `API_VERSION`，不相容的 REST／WebSocket 變更才遞增），以及各套件自己的版本字串（只供顯示）。Server 的 `GET /api/health` 回報 `versions { server, api, protocol }`；沒有這個欄位的 Server 比 Phase 1 發布更早，一律視為過舊。
  - **Runner↔Server**：Hello 的協定版本不同時 Server 回 `hello_rejected { reason: version_mismatch }`，訊息指出要更新哪一邊（Runner 較舊→更新 Runner，由 Desktop 代管時更新 Desktop；Runner 較新→更新 Server）。Runner 印出訊息後以結束碼 76 結束，不重試。
  - **Desktop↔Server**：Desktop 在啟動、換 Server、sidecar 以 76 結束時，以及每 6 小時，拿自己編譯進去的 API 版本與內建 Runner 的協定版本（和 Desktop 同一個 commit）比對 `/api/health`，算出「Desktop 版本過舊，請更新 Desktop」「Server 版本過舊，請更新 Server」或兩者都要更新。結果顯示在系統匣（圖示轉為警告色），同一個問題只用對話框提示一次；要更新 Desktop 時，Windows 的對話框直接檢查更新，macOS 開 Releases 頁。
  - **Server↔Web**：Web 由 Server 提供，版本不同通常是瀏覽器快取了舊的 Web。Web 在載入、視窗取得焦點與每 10 分鐘比對 `/api/health`：Web 較舊時在頁面頂端提示「Web UI 有新版本，請重新整理」並附按鈕，Server 較舊時提示更新 Server。
  - **Desktop↔Web**：Web 可能比 Desktop 新。bridge 的新功能一律是選填欄位，舊版 Desktop 沒有時 Web 退回瀏覽器版本的做法（例如 Preview），不另外比對版本。

### 16.1 Desktop 殼

Desktop 只是 Web UI 的外殼（[ADR-0008](adr/0008-electron-desktop-shell.md)），另外代管 Local Runner、顯示系統匣與桌面通知。

- **Server URL**：
  - 第一次啟動時由使用者輸入 Web UI 的 origin，Desktop 以 `GET /api/health` 確認後存在本機設定中。
  - Runner 要連的 API origin 取自 `GET /api/health` 回報的 `apiOrigin`；回應沒有這個欄位時，退回 Web UI 的 origin。Desktop 在取得 Pairing token 時決定這個網址，sidecar 重新啟動也沿用同一個網址。
- **安全設定**：
  - 主視窗啟用 `contextIsolation` 與 `sandbox`，不啟用 `nodeIntegration`。
  - preload 只暴露最小的 bridge：版本、用編輯器開啟 Worktree、在終端機開啟 Worktree、登出前的 `beforeLogout()`、Preview 的內嵌瀏覽器。main 程序只接受來自 Server origin 主 frame 的呼叫。
- **Preview 的內嵌瀏覽器**（§13）：
  - Web UI 的 Preview 分頁經由 bridge 要求顯示某個 Run 的 Preview，並回報分頁的位置；Desktop 以 WebContentsView 疊在主視窗上。網址列、上一頁、重新整理、DevTools 由 Web UI 顯示，透過 bridge 操作。
  - 開哪個網址由 main 程序自己向 Server 查詢 Run 的 Preview 狀態後決定，Web UI 只給 Run ID：這台 Desktop 的 Local Runner 跑的 Run 開 `localhost:<port>`（只接受 loopback 與 Server 記錄的 port），其他 Run 開 Preview 網址。
  - 內嵌瀏覽器沒有 preload、啟用 sandbox，導覽只留在這個 Preview 的 origin 與換票用的 authorize，其他 http(s) 連結用外部瀏覽器開啟。內嵌瀏覽器使用獨立的 session（cookie 不分 port，Web UI 在 `localhost` 時，共用 session 會把 Orbis 的 session cookie 送到 dev server），也不允許任何權限請求；Preview 網址換票時，由 main 程序帶著 Web UI 的 session 請求 authorize，取得轉往的 callback 後才在內嵌瀏覽器中開啟。
  - 選取元素：在 isolated world 注入 overlay（頁面的 script 碰不到），滑鼠下的元素以外框標示，點擊選取、Esc 取消；選取期間攔下點擊。selector 依序用 id、`data-testid`、`tag:nth-of-type()` 路徑，取最短的唯一 selector。選取後保留外框截下 Preview 的畫面，回傳 selector、URL 與截圖給 Web UI 的留言框。
  - 導覽只允許 Server origin 與 GitHub OAuth 的登入頁，其他 http(s) 連結用外部瀏覽器開啟，不開新視窗。
- **登入與 Pairing**：
  - main 程序監看 Server 的 session cookie，有變化時以 `/api/auth/me` 確認登入狀態。
  - 登入的人是某個 Team 的 Member 時，向 Server 取得 Local Runner 的 Pairing token，以環境變數交給 sidecar（不放在命令列上）。
  - Runner 完成 Pairing 後自己保存 Runner token，之後重新啟動都用它。
  - **登出**：Web UI 送出登出前呼叫 bridge 的 `beforeLogout()`，Desktop 依 §16 的流程處理後才回傳放行。
    - 撤銷用的 Runner ID 是 sidecar 最後一次回報的值，存在本機設定中。從來沒有連上過時跳過撤銷。撤銷失敗時照樣放行，交給 Server 端撤銷。
    - 放行後 15 秒內，即使 cookie 還在也不重新 Pairing。這段時間過後 cookie 仍然存在，表示登出失敗，Desktop 會重新 Pairing。
    - 沒有經過 `beforeLogout()` 的登出（cookie 消失或 `/api/auth/me` 回 401）時，Desktop 也會停止 sidecar 並刪除本機狀態。
  - **換 Server**：先停止 sidecar 並刪除本機的 Runner 狀態，之後才改用新的 Server URL。
- **Runner sidecar**：
  - 開發模式使用 `cargo build` 的產物，打包模式使用內建的執行檔。Desktop 代管的 Runner 使用自己的狀態目錄，不和手動執行的 Runner 共用 Runner token。
  - 以 `--sidecar` 啟動，透過 stdio 溝通：
    - stdout 每行一個狀態 JSON：連線中、已連線、離線，執行中的 Run 數，是否暫停領取。
    - stdin 每行一個指令：`pause_claiming`、`resume_claiming`、`shutdown`。
    - log 一律走 stderr，Desktop 寫到有大小上限、會輪替的 log 檔。
  - 當掉時以指數退避重啟（1 秒起、上限 60 秒，連續正常運作 60 秒後重置）。
  - 以「需要重新 Pairing」的結束碼結束時不重啟，而是重新取得 Pairing token。
  - 以「協定版本不相容」的結束碼結束時也不重啟。Desktop 先向 `/api/health` 查版本，系統匣與視窗明說要更新 Desktop 還是 Server（§16「版本相容」）；查不到時才顯示籠統的「Runner 版本與 Server 不相容，請更新」。
  - **結束 App 時**：Desktop 送出 `shutdown` 並關閉 stdin，Runner 結束自己的 Run（§6.4）後退出。stdin EOF 也視為 shutdown，所以 Desktop 當掉時 Runner 也會自行結束。Runner 逾時沒有結束，Desktop 就強制結束整個程序樹：Windows 用 `taskkill /T`，macOS／Linux 用 process group。
- **系統匣**：
  - 顯示 Runner 狀態（連線中、已連線與執行中的 Run 數、離線）與 Needs You 的數量。
  - 提供「顯示視窗」「暫停領取新 Run」「檢查更新」「開啟 Runner log」。暫停領取存在本機設定中，Runner 以 Heartbeat 告訴 Server 不要再派工。更新的進度（下載中、已下載等結束時安裝、有新版本請手動下載）與版本不相容的提示也顯示在系統匣。
  - 關閉主視窗只是縮到系統匣，結束 App 要用系統匣或選單。
- **桌面通知**：
  - 登入後每 5 秒輪詢 Needs You 清單。第一次輪詢只建立基準，之後新出現的項目各發一次原生通知。
  - 點擊通知後顯示主視窗，並前往和 Web UI 的 Needs You 清單相同的位置：Review Gate 到工作區的差異分頁，Verification 超過重試上限到任務分頁的驗收紀錄，權限請求與其他項目到那個 Run 的工作區。
- **開啟本機工具**：
  - 工作區的 Worktree 路徑選單可以用設定的編輯器或終端機開啟 Worktree，兩者都提供預設選項與自訂指令（`{path}` 會換成 Worktree 路徑）。
  - Desktop 只接受 Worktree 根目錄（§6.2）底下 `<repo>/<Worktree>` 這一層、而且確實存在的目錄，並解析 symlink 確認沒有跳出根目錄。
  - 執行檔一律以絕對路徑啟動，不在目前目錄（Worktree）中搜尋。Worktree 的內容可能是 Agent 寫的。
  - Windows 上的 `.cmd` shim 經由 `cmd.exe` 執行，參數由 Desktop 自己加引號。

---

## 17. 測試策略

- **Fake Agent**（`crates/fake-agent`）：依 YAML 劇本送出訊息、tool call、diff、權限請求、plan、錯誤、rate limit。**所有整合測試都用它**，不呼叫真實模型。
- **Runner**：單元測試，加上使用真實 git worktree 與 Fake Agent 的整合測試。CI 在 Windows、macOS 都跑（Linux 暫時不在 CI 驗證）。
- **Server**：用真實的 Postgres 測試，每個測試檔各自建立獨立的 database。CI 在 Windows、macOS 安裝原生 Postgres（`TEST_DATABASE_URL`），本機沒有設定時用 Testcontainers。測試與完整系統 e2e 都不使用開發 DB。
- **Web**：用 Playwright 跑端到端測試，分兩層：mock 層以 MSW 假後端涵蓋每個畫面與狀態；**完整系統**層接上真實的 Server、Postgres、Local Runner 與 Fake Agent（`e2e:stack`），涵蓋 M2 的完成條件：M1 路徑、Plan Gate、Verification 失敗重試與超過上限的決定、空 diff 的結束、Feedback Loop（review 與 CI，webhook 以錄製的 fixture 送出）、Delegation（consult 與 branch 的 Child Run）、共同編輯、通知中心。Desktop 的完整系統 e2e 以 Electron 走 M1 路徑、Preview 的轉送與 Preview 留言（選取元素到 Agent 收到 prompt）。
  - `e2e:stack` 在 ready 之後接受 stdin 的 JSON 指令（例如把 PR head 的 CI 結果餵給程序內的 FakeGitHub），用法見 `apps/server/README.md`。
- **Desktop**：Playwright 的 Electron 模式接 fake Server；sidecar 用真實的 Runner，自動更新用本機的 fake feed 跑真實的 electron-updater（只下載與提示，不安裝）。打包只在 Release workflow 驗證（手動執行時只打包不發布）。
- **CI 的分層**：lint、typecheck、單元與整合測試、Playwright（Web、Desktop）在每個 PR 上 Windows、macOS 都跑；完整系統的 e2e 在 PR 上只跑 Windows，push 到 `main` 時兩個平台都跑。只改文件（`docs/**`、`*.md`，ARCHITECTURE.md 除外）時不跑 CI。
- **真實 Agent 煙霧測試**：Claude Code、Codex、Antigravity、Grok 各跑一個小 Task；只在使用者自己的電腦上手動或以 Windows 工作排程器每晚跑（`scripts/smoke-agents.ps1`，用法與排程設定見 [SMOKE-TEST.md](SMOKE-TEST.md)），不放進 GitHub Actions，Agent 憑證不離開那台電腦。
- **Windows 強化**（§6.4）的每一項都有自動測試：中文與空白路徑、長路徑、刪除重試、WSL 的拒絕、三種 shell 的腳本、連線看門狗、保留的 port（`crates/runner/tests/windows_hardening.rs`、`connection.rs`、`feedback_loop.rs` 與 `shell.rs`、`home.rs` 的單元測試）。

---

## 18. 範圍

| Phase 1（約 10 週） | Phase 2 | 不做 |
|---|---|---|
| §1–§17 全部，但不包含右邊兩欄 | Team Runner 的容器隔離與 `yolo`、best-of-N 的 UI、即時觀看 Agent 的瀏覽器畫面、託管部署的文件、macOS 程式碼簽章與自動更新、Desktop 的 App 圖示、email／Slack 通知、`ClaudeSdkAdapter`（需要時才做） | 手機 App、Linear／Jira／Azure DevOps、GitHub Projects、OS 層級沙盒、Windows 程式碼簽章、跨 Repo 的 Task、`shared` Delegation 模式、程式碼的共同編輯 |

---

## 19. 待決事項

- **Repo 可見度**：已決定維持 public（91 Integration Release），Desktop 從 public GitHub Releases 更新。
- **共用訂閱的條款風險**：見 [ADR-0005](adr/0005-shared-subscription-on-team-runner.md)。
