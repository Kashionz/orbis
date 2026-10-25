# 新工作區介面的後端開發規劃

新的 Web 工作區介面（`design_handoff_orbis_workspace` 原型，PR #88 與 #90）已經把原型中的功能完整做進 UI。其中有一部分功能當時後端還沒有，開發期間的處理方式：

- **mock 模式**（MSW）：功能完整可用。
- **真實模式**：由 feature flag（`apps/web/src/lib/features.ts`）停用，入口顯示「尚未開放」，不會假裝成功。
- **程式碼標記**：以「TODO(後端缺口代號)」的形式標註，暫定型別放在各 feature 目錄，不在 `@orbis/api-contract`。

這些缺口已經實作完成（契約 #92、#95、#96，Runner＋Desktop #97，Server＋Web 在第 1 波的 `feat/w1-server-web`）：flag、標記與暫定型別都已拿掉，mock 改成和真實 API 相同的形狀（`apps/web/src/mocks/workspace.ts`、`mocks/share.ts`、`mocks/backend.ts`）。

這份文件記錄每個缺口**已經決定**的做法（2026-10-25 與使用者逐項確認），作為派工的依據。worker 照這份文件實作；和這裡不同的取捨要先提出來，不要直接改。

工作量的單位：S 約半天、M 約 1–2 天、L 約 3–5 天。

## 總覽

| 代號 | 功能 | 軌 | 工作量 |
|---|---|---|---|
| `run-prompt` | 執行中傳訊息給 Agent（排隊或中斷） | A＋B | M |
| `event-actor` | 事件串流中 prompt 與權限回覆的作者 | A＋B | S |
| `task-pull-request` | 串流中的「開出合併請求／已合併」 | B | S |
| `stopped-run-reason` | 停下來的原因改成代碼 | B | S |
| `board-summary` | 看板摘要一次取得 | B | S |
| `member-email` | Member 的 email | B | S |
| `model-catalog` | 模型目錄 | A＋B | M |
| `run-settings` | 執行中切換模型、推理強度、權限策略 | A＋B | M |
| `dispatch-effort` | 派工時指定推理強度 | A＋B | S |
| `agent-switch`（新） | 執行中換 Agent 並接續作業 | A＋B | L |
| `task-without-repo` | 不指定 Repo 建立 Task | B | S |
| `local-repo`（新） | 本機 Repo：不經過 GitHub 走完整個流程 | A＋B | L |
| `repo-connect-github`（新） | 本機 Repo 改成 GitHub Repo | B | M |
| `agent-relogin` | Agent 重新登入 | A＋E＋B | M |
| `preview-share` | 預覽分享給團隊、邀請特定的人 | B＋E | M |
| `task-sharing` | Task 層級的成員、角色與一般存取 | B | L |
| `task-invites` | 以 email 邀請成為 Task 成員 | B | M |
| `terminal` | 互動式終端機 | A＋B | L |
| `reveal-in-explorer` | 在檔案總管開啟 Worktree | E | S |
| `desktop-notify-toggle` | 桌面通知總開關 | E | S |

**移出缺口清單**（不做後端）：
- `runner-long-paths`：Runner 在 Windows 上已固定開啟 `core.longpaths`（#84），關掉沒有實際用途。設定頁的開關改成只顯示「已開啟」，拿掉 flag 與 `TODO`。
- `agent-default-model`：各 Agent 的預設模型維持存在 localStorage。

## 各項的決定

每一項依序列出：行為、契約（協定、API、DB）、權限、錯誤情況、測試、完成條件。「完成條件」一律包含：拿掉對應的 flag、程式碼標記與暫定型別，改用 `@orbis/api-contract` 的型別。

### `run-prompt`：執行中傳訊息給 Agent

**現況**：Runner 只在 Plan Gate 與 Review Gate 等待時接受 `prompt`；回合中與等待權限回覆時一律以 `InvalidState` 拒絕（`crates/runner/src/run.rs` 的 `on_control_while_running`），也沒有排隊。Server 沒有對 Run 送 prompt 的 API。

**行為**：
- **排隊（預設）**：回合中或等待權限回覆時送出的訊息先排隊。回合結束時，Runner 不進入審查關卡，改用排隊的訊息直接開始下一個回合。排了多則時依序合併成一則（以空行分隔）。
- **收回**：還在排隊的訊息可以收回，收回後不送出。
- **中斷並傳送**：先 `session/cancel` 目前的回合，回合結束後立即送出這則訊息。
- 在 Gate 等待時送出的訊息，沿用現有的退回流程（Plan Gate 退回計畫、Review Gate 附意見再試），輸入框依狀態決定送出的意思（U2 的 Q2）。
- 事件串流顯示排隊中的訊息（「回合結束後送出」）與收回。

**契約**：
- 協定：`RunControlAction::Prompt` 加 `delivery: PromptDelivery`（`queue`｜`interrupt`，預設 `queue`）。新增 `RunControlAction::WithdrawPrompt { control_id }`。
- Event：新增 `prompt_queued { control_id, prompt }`、`prompt_withdrawn { control_id }`；排隊的訊息真正送出時仍是 `prompt_submitted`（帶 `control_id`，見 `event-actor`）。
- API：`POST /api/runs/:runId/prompts { text, delivery }` → `{ controlId }`；`DELETE /api/runs/:runId/prompts/:controlId`。

**權限**：`edit_task`（Member 以上，或 `task-sharing` 中「可操作」的人），和中止 Run 相同。

**錯誤**：Run 已結束 → 409 `run_finished`；收回已送出的訊息 → 409 `prompt_already_submitted`；Runner 離線 → 沿用 RunControl 的排隊與逾時。

**測試**：Fake Agent 劇本：長回合中排兩則 → 合併成一則送出；排隊後收回；中斷並傳送；等待權限回覆時排隊。Server：權限與 409。Playwright：輸入框在執行中的送出、排隊列與收回。

### `event-actor`：事件的作者

**現況**：`PromptSubmitted` 與 `PermissionResolved` 由 Runner 發出，沒有帶操作的人。Server 發 RunControl 時已記下 `run_controls.requested_by_member_id`。

**行為**：人的訊息標頭顯示頭像與名稱；已回覆的權限請求顯示「由 X 允許／拒絕」。Run 的第一則 prompt 的作者是派工的人（`runs.requested_by_member_id`）。

**契約**：
- 協定：`PromptSubmitted` 與 `PermissionResolved` 加 `control_id: Option<String>`，Runner 原樣帶回觸發它的 RunControl id。Server 自己產生的 prompt（Verification 重試等）也有 control id。
- Server 存 Event 時依 `control_id` 查出 `requested_by_member_id`，API 的 Event 多一個 `actorMemberId: string | null`。
- 不新增 `event-actors` API。

**測試**：Runner：兩個 Event 帶回 control id。Server：ingest 補上 actorMemberId；舊 Event（沒有 control id）為 null。

### `task-pull-request`：合併請求的事件

**現況**：PR 存在 `pull_requests` 表（`apps/server/src/db/schema/github.ts`），但 `Task` 的 API 沒有 PR 欄位，也沒有 PR 相關的 Event。

**行為**：事件串流依時間插入「開出合併請求 #N」與「已合併」兩列，連到 GitHub。

**契約**：`Task` 加 `pullRequest: { number, url, state, openedAt, mergedAt } | null`（`state`：`open`｜`closed`｜`merged`）。`openedAt` 取 `pull_requests.created_at`；`merged_at` 目前沒有，在 migration 0004 補上，由 `pr_merged` webhook 寫入。不新增協定的 Event。

**測試**：Server：開 PR、merge 之後 Task 的欄位；沒有 PR 時為 null。Playwright：串流中的兩列。

### `stopped-run-reason`：停下來的原因

**現況**：`NeedsYouStoppedRun.reason` 是 Server 寫死的中文字串（`runs/verification.ts`、`runs/run-control.ts`）。

**契約**：`NeedsYouStoppedRun` 改成：
- `reasonCode`：`verification_limit`｜`push_failed`｜`pr_open_failed`｜`local_merge_blocked`（見 `local-repo`）
- `attempt: number | null`：只有 `verification_limit` 有值
- `detail: string | null`：原始錯誤訊息，不翻譯，UI 以 `code` 字型顯示

拿掉 `reason`。待我處理與通知的文字改由 UI 依代碼在地化。

**測試**：Server：三種原因各自的 payload。Playwright：zh-TW 與 en 的顯示。

### `board-summary`：看板摘要

**現況**：真實模式逐 Task 查 `GET /api/tasks/:taskId/runs` 與 acceptance criteria（staleTime 30 秒）。

**契約**：`GET /api/projects/:projectId/board-summary` → `{ tasks: [{ taskId, latestRun: { id, status, gate, agent } | null, acceptance: { passed, failed, total } }] }`。`latestRun` 只算主 Run，不算 Child Run。

**即時更新**：沿用 ws 的 live update；Run 狀態、Verification 結果變化時讓這個 query 失效重抓。

**權限**：`view`（並套用 `task-sharing` 的限制：看不到的 Task 不出現）。

**完成條件**：前端拿掉逐 Task 查詢。

### `member-email`

**現況**：OAuth 沒有請求任何 scope；members 表沒有 email。

**行為**：
- GitHub OAuth 改成請求 `user:email`。
- 每次登入時用 `GET /user/emails` 取主要且已驗證的 email，寫進這個 GitHub 帳號所有的 Member 紀錄。
- 已登入的人不強制登出，下次登入時補上。

**契約**：members 加 `email`（nullable）。`MeResponse.member` 與成員清單加 `email: string | null`。

**用途**：個人選單、帳號頁；也是 `task-invites` 與 `preview-share` 用 email 比對的基礎。

**測試**：Server：登入時寫入、沒有已驗證 email 時為 null（FakeGitHub）。

### `model-catalog`：模型目錄

**現況**：Runner 回報的 `AgentInfo.models` 一律是空的；前端用靜態表補 tag、effort、vendor。ACP（`agent-client-protocol` 3.5.0，schema 1.12）沒有 `session/set_model`，模型與推理強度屬於 `session/set_config_option` 的選項（類別 `Model`、`ThoughtLevel`）。

**行為**：
- **基準**：Agent Profile 內建一份靜態清單：模型 id、顯示名稱、tag、推理強度能力（`adjustable`｜`fixed`｜`unsupported`），以及 fast／std／deep 對應的 config option 值。
- **校正**：Runner 記下每個 Agent 最近一次真實 session 回傳的 `config_options`（Model、ThoughtLevel 兩類），之後回報以這份為準，存在 Runner home。
- **登入狀態**：沿用現有的 `credential` 欄位。

**契約**：
- 協定：`AgentInfo.models` 從 `Vec<String>` 改成 `Vec<ModelInfo { id, name, tag, effort: EffortSupport, source: profile|session }>`。
- API：`GET /api/agent-catalog` → `[{ agentId, tool, vendor, cliId, models, signedIn }]`，彙整目前成員可用的 Runner。

**測試**：Runner：沒有 session 時回報 Profile 清單；Fake Agent 劇本回傳 config_options 後改回報 session 版本。

### `run-settings`：執行中切換模型、推理強度、權限策略

**行為**：
- **模型與推理強度**：下一個回合開始前生效。事件串流顯示「已切換為 X」。
- **權限策略**：立即生效，從下一個權限請求開始套用。
- 選單只列這個 Agent 的模型；換 Agent 見 `agent-switch`。

**契約**：
- 協定：新增 `RunControlAction::SetSessionConfig { model: Option<String>, effort: Option<Effort> }`（Runner 在回合之間以 `session/set_config_option` 套用）與 `RunControlAction::SetPermissionPolicy { policy }`（Runner 換掉 `offer.permission_policy`）。新增 Event `run_settings_changed { model, effort, permission_policy, control_id }`。
- API：`GET /api/runs/:runId/settings` → `{ initial, current, changes[] }`；`PATCH /api/runs/:runId/settings { model?, effort?, permissionPolicy? }`。

**權限**：模型與推理強度用 `edit_task`。權限策略和派工時能不能選這個策略用同一條規則（Project 允許的策略、`manage_permission_policy`）。

**錯誤**：Agent 不支援某個選項 → Runner 送 `run_settings_changed` 時標示未套用，API 回 422 `option_unsupported`；Run 已結束 → 409。

**測試**：Fake Agent 劇本：宣告 config options、收到 set_config_option、下一回合生效；不支援時的錯誤。Runner：權限策略切換後下一個請求依新策略判斷。

### `dispatch-effort`：派工時的推理強度

**契約**：`CreateRunInput.effort: "fast" | "std" | "deep" | null`；runs 加 `effort` 欄位；協定 `DispatchOffer.effort`。Runner 在 session 建立後以 config option 套用。和 `run-settings` 共用協定欄位。

### `agent-switch`：執行中換 Agent 並接續作業

ACP 的 session 綁在各家的 Agent 上，無法搬到另一個 Agent。「接續」的意思是：留在同一個 Run、同一個 Worktree，用新的 Agent 開新的 session，並交接脈絡。

**行為**：
- 只在回合之間生效。回合中選擇切換時，跟 `run-prompt` 的排隊一樣等回合結束。
- 只能換成同一台 Runner 上可以用的 Agent（Worktree 在那台電腦上）。
- Run id 與 Worktree 不變；`runs.agent` 改成目前的 Agent；費用與用量依 Agent 分段記錄。
- 權限策略依新 Agent 的 Agent Profile 重新套用 session mode。
- Child Run 不受影響。

**交接 prompt**：Runner 依 Run 的 Event 組出固定格式，依序是：
1. Task 的規格與驗收條件
2. 人送出的所有 prompt（依時間）
3. Agent 每個回合最後的回覆
4. 目前的計畫
5. diff 摘要：改了哪些檔案、各增減幾行（細節請新的 Agent 自己讀 Worktree）
6. 還沒處理的審查留言

不請舊的 Agent 寫摘要（會想換 Agent 時，舊的常常已經不能用）。

**契約**：
- 協定：`RunControlAction::SwitchAgent { agent, model: Option<String>, effort: Option<Effort> }`；Event `agent_switched { from, to, model, control_id }`。
- API：`POST /api/runs/:runId/switch-agent { agent, model?, effort? }`。
- DB：`run_agent_segments`（run_id、agent、model、started_at、ended_at、usage）。

**權限**：`edit_task`；換到的 Agent 也要符合派工的限制。

**錯誤**：目標 Agent 在這台 Runner 上不可用 → 422 `agent_unavailable`；Run 已結束 → 409。

**測試**：Runner：用兩個 Fake Agent 設定檔切換，第二個 session 收到的交接 prompt 內容固定（snapshot）；回合中切換時等回合結束。Server：segments 與費用。Playwright：模型選單跨 Agent 切換、串流的「已換成 X」。

### `task-without-repo`：不指定 Repo 的 Task

**現況**：`tasks.repo_id` 在 DB 與 `Task` 契約本來就可以是 null，只有 `CreateTaskInput.repoId` 是必填。「建立後不能更換」寫在契約註解，靠 `UpdateTaskInput` 沒有 repoId 欄位。

**行為**：
- 建立時可以不指定 Repo，這種 Task 只能停在待辦。
- 之後可以補指定一次（null → 某個 Repo），指定之後不能再換。
- 沒有 Repo 的 Task 不能移到就緒、不能派工、不同步到 GitHub Issues；補指定後才開始同步。

**契約**：`CreateTaskInput.repoId` 改成 nullable；`UpdateTaskInput` 加 `repoId`，只接受 null → 值。狀態機：沒有 Repo 時拒絕 backlog → ready。

**錯誤**：更換已指定的 Repo → 409 `repo_already_set`；沒有 Repo 時移到就緒 → 409 `repo_required`。

**文件**：修訂 ADR-0011，加上這一段。

### `local-repo`：本機 Repo

**現況**：沒有 GitHub App 時，建立 Repo、派工、Run、審查關卡、push 都能用（Runner 依 `runner.toml` 對應到本機 checkout，push 到它的 `origin`），但 Task 到不了 Done。Server 把 clone URL 寫死成 `https://github.com/<owner>/<name>.git`，Repo 名稱依 GitHub 規則檢查。登入只有 GitHub OAuth。

**範圍**：只做 Repo 這一層。登入仍用 GitHub OAuth（只用來確認身分）。

**行為**：
- **登記**：Repo 加 `kind`（`github`｜`local`）。本機 Repo 只有名稱，不檢查 GitHub 命名規則，沒有 GitHub 的 id。路徑沿用 `runner.toml` 的對應，Server 不保存路徑。
- **派工**：只能派到有對應這個 Repo 的 Local Runner。Team Runner 不能選，派工對話框不顯示。Team 的其他人在自己的 `runner.toml` 設了同名對應，也可以派到自己的電腦。
- **核准之後**：Runner 把 Run 的分支合併到本機 checkout 的基準分支，Task 直接轉為 Done，接著封存 Worktree。
  - 基準分支沒有在 checkout 中簽出 → 在暫時的 worktree 中合併。
  - 已簽出且工作目錄乾淨 → 直接在 checkout 中合併。
  - 工作目錄有未 commit 的變更 → 不合併，Run 停下，`reasonCode: local_merge_blocked`，放進待我處理；處理後按重試。
  - 合併方式是 Project 設定：squash（預設）或 merge commit。
  - checkout 有 `origin` 時，Project 設定可以選擇合併後 push 基準分支（預設關閉）。
- **不提供**：Issues 同步、Feedback Loop（PR 審查與 CI），相關 UI 隱藏。
- **Repo Spec**：改成直接 commit 到基準分支（走同一套合併），版本號在 commit 時增加。
- **照常運作**：Verification、預覽。

**契約**：
- DB：repos 加 `kind`；本機 Repo 的 `github_owner` 改為可以是 null（或改用 `name` 欄位），unique 改為 (project, kind, 名稱)。
- 協定：`DispatchOffer` 的 repo 改成 `{ kind: github, clone_url } | { kind: local, name }`；Runner 對本機 Repo 只依 `runner.toml` 找 checkout，找不到時拒絕派工。新增 `RunControlAction::MergeLocal { strategy, push_base }` 與 Event `local_merged { commit, base }`。
- 狀態機：`review_gate` → `done`（trigger `local_merge`）。
- API：`CreateRepoInput` 加 `kind`；Project 設定加 `localMergeStrategy`、`localPushBase`。

**錯誤**：沒有 Runner 對應這個 Repo → 派工選項不可用（沿用 dispatch-options 的 unavailable reason）；合併衝突 → Run 停下，`reasonCode: local_merge_blocked`，`detail` 是 git 的輸出。

**測試**：Runner：真實 git 的三種合併情況（未簽出、乾淨、髒）、squash 與 merge commit、push base。Server：狀態機與封存。完整系統 e2e：本機 Repo 從派工到 Done。

**文件**：新 ADR（本機 Repo 與連接到 GitHub）；GLOSSARY 的 Repo 定義改成「GitHub repository 或本機 git repository」；ARCHITECTURE §5 的 Done 條件加上「本機合併」，§6.2、§11 補本機 Repo。

### `repo-connect-github`：本機 Repo 改成 GitHub Repo

**行為**：
- Project 設定的本機 Repo 上按「連接到 GitHub」，填 owner 與 name。Server 確認 GitHub App 已安裝在那個 repo 上之後，`kind` 從 `local` 改成 `github`。只能單向。
- 前置條件：本機 checkout 的 `origin` 指向那個 GitHub repo，且基準分支已 push。Orbis 不幫忙建立 GitHub repo（需要個人帳號的 `repo` scope，權限太大），畫面顯示可照著執行的指令（例如 `gh repo create <name> --source . --push`）。
- 之後：以前的 Task 與 Run 照舊；新的 Run 核准後走 push 與開 PR；Issues 同步、Feedback Loop、Repo Spec 的 PR 從此啟用。
- 改的時候停在審查關卡的 Run，核准時依新的 `kind` 走開 PR。

**契約**：`POST /api/repos/:repoId/connect-github { owner, name }`。

**權限**：`manage_project`（Admin 以上）。

**錯誤**：App 沒有安裝 → 409 `repo_not_connected`（附 installUrl）；同一個 Project 已有這個 GitHub repo → 409 `repo_exists`。

### `agent-relogin`：Agent 重新登入

**現況**：`orbis-runner login <agent>` 只支援有 ACP `auth_method` 的 Agent（目前只有 Antigravity），Desktop 與 Server 都不會觸發它。

**行為**：
- **Local Runner**：設定頁按「重新登入」，由 Desktop 在那台電腦上執行 `orbis-runner login <agent>`，自動開瀏覽器。完成後 Runner 重新回報可用性。
- **Team Runner**：無法遠端互動登入，只顯示要在伺服器上執行的指令，限 Admin 以上。
- **自己處理登入的 Agent**（Claude Code、Codex 等）：顯示「在終端機執行 `<CLI> login`」，可以按一下用設定的終端機開啟。

**契約**：Desktop bridge 加 `loginAgent(agentId)`（回傳完成或錯誤）；Agent Profile 加 `login_hint`（指令文字）並透過 `AgentInfo` 回報。不新增 Server API。

**測試**：Runner：login 指令的成功與逾時（Fake Agent 劇本）。Desktop：bridge 呼叫 sidecar。

### `preview-share`：預覽分享

**現況**：Team 裡對 Project 有 `view` 的人都能開預覽網址（ticket 換 cookie，`apps/server/src/preview/`）。

**行為**：
- **分享給團隊**：複製預覽網址，拿掉 UI 的停用。不需要後端。
- **邀請特定的人**：
  - Team 設定「允許對外分享預覽」，預設關閉，由 Admin 打開。
  - 打開後，對這個 Task 有操作權限的人可以邀請。
  - 以 GitHub 帳號（邀請時查出 GitHub user id 並保存，登入時以 id 比對）或 email（以 `member-email` 存下的已驗證 email 比對）指定，可以是其他 Team 的人或不屬於任何 Team 的人。
  - 對方從邀請連結（Orbis 主網址的 `/preview-invites/<token>`）進入，用 GitHub 登入，Server 確認在名單上才發 ticket、轉到預覽子網域。不在名單上的人拿到連結也打不開。
  - 有設定 SMTP 就寄信，沒有就由邀請人複製連結。
  - 每位受邀者各自有期限：1 小時、24 小時（預設）、7 天，可以個別撤銷。預覽停止或 Worktree 封存後全部失效。
  - 受邀者只能看預覽頁面，不會因此加入 Team，也看不到 Task。
  - 預覽分頁顯示受邀名單、期限與最後一次開啟的時間。

**契約**：
- DB：`preview_invites`（run_id、github_user_id 或 email、expires_at、created_by、revoked_at、last_opened_at）；teams 加 `allow_external_preview`。
- API：`GET/POST /api/runs/:runId/preview-invites`、`DELETE /api/runs/:runId/preview-invites/:inviteId`、`GET /preview-invites/:token`（登入後換 ticket）。
- `preview/access.ts`：除了 Project `view`，也接受有效的邀請。

**權限**：建立與撤銷用 `edit_task`，且 Team 設定已打開；Team 設定用 `manage_team`。

**測試**：Server：名單內外、過期、撤銷、封存後失效、Team 設定關閉。完整系統 e2e：受邀者登入後開預覽。

**文件**：新 ADR（預覽邀請）；ARCHITECTURE §13 更新。

### `task-sharing`：Task 分享與權限

**現況**：權限只有 Team 角色（Owner > Admin > Member > Viewer）與 Project 覆寫（`project_member_roles`），沒有 Task 層級。

**權限模型**：
1. **Task 角色可以調高**：被分享為「可操作」的 Team Viewer，在這個 Task 上可以編輯、派工、核准關卡、送 prompt。「可檢視」只能看。
2. **一般存取可以限制**：`invited`（僅受邀成員）、`team_view`（Team 可檢視）、`team_edit`（Team 可操作，預設，和現在的行為一樣）。限制時，其他人在這個 Task 上的權限降到對應的程度。
3. **Owner、Admin 永遠有完整權限**，不受 Task 分享影響，避免 Task 被鎖住。
4. **Admin 層級的能力不受 Task 角色影響**：權限策略、設定信任、Team Runner、Project 設定。
5. **擁有者**是建立 Task 的人，可以轉移給別人。
6. Task 的有效權限 = Owner／Admin 時完整；否則取「Task 角色」與「一般存取限制後的 Team／Project 角色」中較高的一個。

**契約**：
- DB：`task_members`（task_id、member_id、role：owner｜edit｜view）、tasks 加 `general_access`。
- API：`GET /api/tasks/:taskId/share`；`POST /api/tasks/:taskId/share/members`；`PATCH/DELETE /api/tasks/:taskId/share/members/:memberId`；`PUT /api/tasks/:taskId/share/general`。
- `authorize()` 加 Task 這一層：需要 Task 的能力（edit_task、dispatch_*、approve_gate、view）時一併傳入 taskId。列表（看板、待我處理、搜尋）要過濾掉看不到的 Task。

**權限**：管理分享：Task 的擁有者、Admin 以上。

**測試**：Server：權限矩陣（Team 角色 × Task 角色 × 一般存取）的表格測試；列表過濾；Owner／Admin 不受限制。

**文件**：新 ADR（Task 分享與邀請）；ARCHITECTURE §12.2 更新。

### `task-invites`：以 email 邀請

**行為**：
- 邀請產生一條邀請連結，可以複製。有設定 SMTP（`ORBIS_SMTP_URL`、`ORBIS_SMTP_FROM`，前綴從名稱常數取得）時也寄信，沒有設定就只能複製連結。
- 對方用 GitHub 登入後，以 Viewer 身分加入 Team，再依邀請時選的角色取得 Task 角色（依賴 `task-sharing` 的「可以調高」）。
- 邀請 7 天後過期，可以撤銷。
- 用 `member-email` 存下的 email 比對：已經是 Member 的人直接加到 Task 上，不產生邀請。

**契約**：
- DB：`task_invites`（task_id、email、role、token_hash、expires_at、invited_by、accepted_at、revoked_at）。
- API：`POST /api/tasks/:taskId/share/invites { email, role }`、`DELETE /api/tasks/:taskId/share/invites/:inviteId`、`GET /invites/:token`（登入後接受）。
- 寄信：`apps/server` 新增 mailer 模組，SMTP 沒設定時為 no-op；`preview-share` 共用。

**測試**：Server：接受、過期、撤銷、已是 Member、SMTP 沒設定。完整系統 e2e：邀請 → 另一個 GitHub 帳號登入 → 看到 Task。

### `terminal`：互動式終端機

**現況**：沒有任何 PTY；Desktop 的「在終端機開啟」只是啟動外部終端機。

**行為**：
- Runner 在 Worktree 中開 PTY（`portable-pty`，Windows 用 ConPTY），輸入輸出經 Runner channel 到 Server，再經新的 WebSocket 到 Web 的終端機分頁（xterm.js）。
- **誰能用**：Local Runner 只限那台 Runner 的擁有者（和權限回覆的規則相同）；Team Runner 只限 Admin 以上，而且 Team 設定預設關閉（等於在共用機器上拿到 shell）。
- 終端機是人自己下指令，不經過權限策略。只記錄誰在什麼時候開、關終端機，不記錄按鍵與輸出。
- Worktree 存在期間都能用；閒置 30 分鐘自動關閉；每個 Run 最多同時 3 個。
- shell：Windows 預設 PowerShell，其他平台用 `$SHELL`；Runner 設定可以覆寫。

**契約**：
- 協定：Server → Runner `TerminalOpen { terminal_id, run_id, cols, rows }`、`TerminalInput { terminal_id, data }`、`TerminalResize`、`TerminalClose`；Runner → Server `TerminalOutput { terminal_id, data }`、`TerminalExited { terminal_id, code }`。資料以 base64 傳送。
- API：`POST /api/runs/:runId/terminals` → `{ terminalId, wsUrl }`；ws 路徑在 `ws-upgrade.ts` 新增；teams 加 `allow_team_runner_terminal`；`terminal_sessions`（run_id、member_id、opened_at、closed_at）。

**錯誤**：Worktree 已封存 → 409 `worktree_archived`；超過 3 個 → 409 `terminal_limit`；沒有權限 → 403。

**測試**：Runner：Windows（ConPTY）與 macOS 的真實 PTY，輸入指令看到輸出、閒置關閉、上限。Server：權限與 Team 設定。Playwright：分頁開啟、輸入、關閉。

**文件**：新 ADR（互動式終端機）；ARCHITECTURE 補一節。

### `reveal-in-explorer`

Desktop bridge 加 `revealWorktree(path)`，以 `shell.openPath` 開啟，沿用 `checkWorktreePath` 的路徑檢查（Worktree 根目錄底下兩層、realpath 比對）。測試：Desktop 的路徑檢查單元測試沿用。

### `desktop-notify-toggle`

做成 Desktop 本機的設定（每台電腦各自決定），存在 Desktop 的設定檔。關閉時 `NeedsYouPoller` 照常輪詢但不發原生通知。Desktop bridge 加 `getNotificationsEnabled`／`setNotificationsEnabled`。Web 版不顯示這個開關。不動 Server 的 `NotificationPreferences`。

## 契約 PR

所有協定、API、DB、ADR 的變更集中在一個契約 PR（同 W5–7 的做法），合併後兩個 worker 才開始：

- **協定 v3**（`crates/orbis-protocol`，`PROTOCOL_VERSION` 改成 3，重新產生 `packages/protocol`）：
  - RunControl：`Prompt.delivery`、`WithdrawPrompt`、`SetSessionConfig`、`SetPermissionPolicy`、`SwitchAgent`、`MergeLocal`
  - Event：`control_id`（PromptSubmitted、PermissionResolved）、`prompt_queued`、`prompt_withdrawn`、`run_settings_changed`、`agent_switched`、`local_merged`
  - `AgentInfo.models` 改成 `ModelInfo`、`login_hint`
  - `DispatchOffer`：`effort`、repo 的 `kind`
  - 終端機的六種訊息
- **`packages/api-contract`**：本文件列出的所有 API 與欄位。
- **migration 0004**：repos.kind、members.email、runs.effort、run_agent_segments、pull_requests.merged_at、task_members、tasks.general_access、task_invites、preview_invites、teams 的兩個設定、Project 的本機合併設定、terminal_sessions。
- **ADR**：
  - ADR-0012 Task 分享與邀請
  - ADR-0013 本機 Repo 與連接到 GitHub
  - ADR-0014 互動式終端機
  - ADR-0015 預覽邀請
  - ADR-0016 換 Agent 的交接
  - 修訂 ADR-0011（不指定 Repo 的 Task）
- **GLOSSARY**：本機 Repo、Task 分享、預覽邀請、交接 prompt、終端機等新名詞。
- **ARCHITECTURE**：§5、§6.2、§11、§12.2、§13 與新的終端機一節。
- **Fake Agent**：劇本支援 config options、長回合（給排隊與中斷用）、login。

契約 PR 的 CI 通過、協調者審完就合併；合併後把 ADR 清單給使用者。

## 分工

Agent 總數不超過 3 個（含協調者），每個 worker 一個獨立 Git worktree，用 Orca 派工。

1. **契約 worker**：做上面的契約 PR。
2. 契約合併後，兩個 worker 平行做完，不分批：
   - **Runner＋Desktop worker**（`crates/runner`、`crates/fake-agent`、`apps/desktop`）：排隊與中斷、`control_id`、模型目錄的 config_options、`run-settings`、`dispatch-effort`、`agent-switch` 與交接 prompt、本機合併、PTY 終端機、Desktop 的 `loginAgent`、`revealWorktree`、通知開關。
   - **Server＋Web worker**（`apps/server`、`packages/github`、`apps/web`）：所有 API、`authorize()` 的 Task 層、`task-sharing`、`task-invites`、`preview-share`、mailer、`board-summary`、`member-email`、`task-pull-request`、`stopped-run-reason`、`task-without-repo`、`local-repo` 與 `repo-connect-github` 的 Server 端；Web 拿掉 flag、接上真實 API。
3. 兩個 worker 都完成後，補完整系統 e2e（本機 Repo 到 Done、執行中傳訊息、換 Agent、終端機、Task 邀請、預覽邀請）。

## 全部完成之後

- `apps/web/src/lib/features.ts` 中這份文件列出的 flag 都拿掉；搜尋後端缺口的程式碼標記（`TODO(` 加上 `backend`）沒有結果。
- mock 改成和真實 API 相同的資料形狀，或刪除。
- M3 驗收：`docs/releases/v0.1.0.md` 的檢查清單改成新介面的步驟，在 Windows Sandbox 走完，通過後在當時的 main 打 v0.1.0。
