# 新工作區介面的後端開發規劃

新的 Web 工作區介面（`design_handoff_orbis_workspace` 原型，PR #88 與 U2 的 PR）已經把原型中的功能完整做進 UI。其中有一部分功能後端還沒有，目前的處理方式：

- **mock 模式**（MSW）：功能完整可用。
  - mock：`apps/web/src/mocks/prototype-features.ts`、`mocks/workspace.ts`
- **真實模式**：由 feature flag 停用，入口顯示「尚未開放」，不會假裝成功。
  - flag：`apps/web/src/lib/features.ts`
- **程式碼標記**：`TODO(backend, <代號>)`。暫定型別放在各 feature 目錄，不在 `@orbis/api-contract`。

這份文件列出每個缺口需要的後端工作、建議的軌、工作量與相依關係，作為之後派工的依據。工作量的單位：S 約半天、M 約 1–2 天、L 約 3–5 天。

## 缺口清單

| 代號 | 功能 | UI 位置 | 需要的 API／協定 | 軌 | 工作量 |
|---|---|---|---|---|---|
| `run-prompt` | 執行中傳訊息給 Agent | 輸入框 | 協定已有 RunControl `prompt`（source `user`）；缺 `POST /api/runs/:id/prompts`、Server 轉送與權限（`run.control`） | B | S |
| `board-summary` | 看板每列的最新 Run 狀態、Agent、驗收進度 | 看板的列表與分欄 | `GET /api/projects/:id/board`：Task＋`latestRun{id,status,gate,agent}`＋`acceptance{passed,failed,total}`。目前前端逐 Task 查詢（staleTime 30 秒，只查可見列） | B | S |
| `event-actor` | 使用者訊息的作者、權限請求由誰回覆 | 事件串流的頭像列、「已回覆」 | `prompt_submitted` 與 `permission_resolved` 加 `member_id`（協定＋Server 寫入） | A＋B＋契約 | S |
| `model-catalog` | 模型目錄：名稱、tag、推理強度能力、vendor、是否已登入 | 設定→代理、輸入框的模型與推理強度選單 | `GET /api/agent-catalog` → `[{agentId, tool, vendor, cliId, models:[{id,name,tag,effort}], signedIn}]`；Runner 的 AgentAvailability `details` 回報模型清單、推理強度能力與登入狀態。目前 tag、effort、vendor 用前端靜態表 | A＋B＋契約 | M |
| `reasoning-effort` | 推理強度（派工時與執行中） | 輸入框、派工 | `CreateRunInput.effort`（fast／std／deep）、Run 欄位、Agent Profile 把強度對應到各 CLI 的參數 | A＋B＋契約 | M |
| `run-model-switch` | 執行中切換模型或 Agent | 輸入框的模型選單、系統事件 | RunControl `set_model`（ACP `session/set_model`）；跨 Agent 要開新 session；新 Event `run_settings_changed` | A＋B＋契約 | M |
| `run-policy-switch` | 執行中切換權限策略 | 輸入框 | RunControl `set_permission_policy`；Runner 改用新政策並送 Event | A＋B＋契約 | S |
| `task-without-repo` | 不指定 Repo 建立 Task（停在 Backlog） | 新增任務的 Repo 選單 | `CreateTaskInput.repoId` 改成 nullable；ADR-0011（Repo 建立後不能更換）要改成允許「從未指定改成指定一次」 | B＋契約＋ADR | M |
| `desktop-notify-toggle` | 桌面通知總開關 | 設定→通知 | 在 `NotificationPreferences` 加欄位，或做成 Desktop 本機設定 | B 或 E | S |
| `runner-long-paths` | Windows 長路徑開關 | 設定→執行器 | `GET/PUT /api/runners/:runnerId/settings` → `{windowsLongPaths}`；協定推送 Runner 設定。Runner 目前已在 Windows 上固定開啟 `core.longpaths`（#84），開關主要用於關閉 | A＋B＋契約 | S–M |
| `reveal-in-explorer` | 在檔案總管開啟 Worktree | 輸入框上方的路徑選單 | Desktop bridge 加 `revealWorktree(path)`（`shell.openPath`，沿用既有的路徑檢查） | E | S |
| `member-email` | 個人選單與帳號頁的 email | 個人選單、設定→帳號 | `/api/auth/me` 加 `email`（需要 GitHub 的 `user:email` scope） | B | S |
| `agent-relogin` | 代理重新登入 | 設定→代理 | `POST /api/agents/:agentId/relogin`；Server 請 Runner 執行該 Agent 的登入流程（Local Runner 經 Desktop 開瀏覽器，沿用 `orbis-runner login`） | A＋E＋B | M |
| `preview-share` | 預覽「分享給團隊」 | 預覽分頁 | 目前 `shareUrl` 只給自己用；分享給團隊需要權限與有效期 | B＋E | S |
| `task-sharing` | Task 層級的成員與角色（owner／edit／view），以及一般存取（invited／team-view／team-edit） | 工作區標題列的分享按鈕與頭像、分享卡 | `GET /api/tasks/:taskId/share`；`POST …/share/members`；`PATCH/DELETE …/share/members/:memberId`；`PUT …/share/general`。權限要接到 §12.2，Task 角色和 Team／Project Role 的關係需要新的 ADR | B＋契約＋ADR | L |
| `task-invites` | 以 email 邀請還不是 Member 的人，以及撤銷 | 分享卡 | `DELETE /api/tasks/:taskId/share/invites/:email`；寄信管道；接受邀請後成為 Member 的流程 | B | M（寄信另計） |
| `terminal` | 右側面板的互動式終端機 | 右側面板的終端機分頁 | Runner 在 Worktree 中開 PTY（ConPTY），以 WebSocket 傳輸輸入輸出；權限與 Permission Policy 的關係需要設計（終端機輸入等同人自己執行指令）。目前終端機分頁只在 mock 模式可用 | A＋B＋契約＋ADR | L |
| `agent-default-model`（選做） | 各代理預設模型的跨裝置同步 | 設定→代理 | 個人偏好 API；目前存在 localStorage，真實模式也能用 | B | S |

最終清單以 U2 PR 的報告為準。U2 若有新增的缺口，合併時補進這張表。

## 建議的順序

依照「使用者天天會碰到、工作量小」排序，同一批次內可以平行：

1. **第一批**（約 2–3 天）：
   - **項目**：`run-prompt`、`board-summary`、`event-actor`、`member-email`、`reveal-in-explorer`、`desktop-notify-toggle`。
   - **理由**：大多只動 Server 或 Desktop，對契約的影響小，做完可以直接拿掉對應的 feature flag。
2. **第二批**（約 3–5 天）：
   - **項目**：`model-catalog`、`reasoning-effort`、`run-model-switch`、`run-policy-switch`、`runner-long-paths`。
   - **做法**：協定與契約集中在一個契約 PR（同 W5–7 的做法），A 軌負責 Runner 回報與套用，B 軌負責 API。
3. **第三批**（約 1–2 週，各自需要 ADR）：
   - **項目**：`task-without-repo`、`agent-relogin`、`preview-share`、`task-sharing`／`task-invites`、`terminal`。
   - **做法**：先寫 ADR，請使用者決定權限模型與安全邊界，再派工。

## 每一項完成時

- 拿掉 `apps/web/src/lib/features.ts` 中對應的 flag，刪掉 `TODO(backend, <代號>)` 與暫定型別，改用 `@orbis/api-contract` 的型別。
- mock 改成和真實 API 相同的資料形狀，或刪除。
- 補 Server 測試（Testcontainers 的 Postgres）與完整系統 e2e。
- ARCHITECTURE 與 GLOSSARY 在同一個 PR 更新。
