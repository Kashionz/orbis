# Orbis

Orbis 是給 2–10 人小團隊用的專案管理加 Agent Workspace：Task 是派給 coding agent 的工作單，從 spec 到 PR merge 的整個生命週期都在同一處完成。

## Language

### 組織

**Team**：
使用 Orbis 的一組成員，擁有共同的 Project、Team Runner 與 Credential。
_Avoid_: Organization、Workspace

**Member**：
Team 中的一個人，以 GitHub 帳號登入。
_Avoid_: User、Account

**Role**：
Member 在 Team 中的權限等級：Owner、Admin、Member、Viewer 其中之一。Project 可以覆寫。
_Avoid_: Permission level

**Project**：
一組相關 Repo 與 Task 的集合，擁有自己的看板與政策設定。
_Avoid_: Workspace、Board

**Repo**：
登記在 Project 底下的一個 GitHub repository，或本機 git repository（本機 Repo）。
_Avoid_: Repository、Codebase

**本機 Repo**：
`kind` 為 `local` 的 Repo：只有名稱，路徑由各 Runner 的 `runner.toml` 對應，只能派到有對應的 Local Runner。核准後由 Runner 合併到本機 checkout 的基準分支（本機合併），不開 PR、不同步 Issues。可以單向連接到 GitHub，改成 GitHub Repo（ADR-0013）。
_Avoid_: Offline repo、Private repo、Local project

### 工作

**Task**：
指派給 Member、可交由 Agent 執行的一件工作，只對應一個 Repo（可以先不指定，這時只能停在 Backlog），有唯一的 Task Key（例如 `ORB-12`）。
_Avoid_: Issue、Ticket、Card

**Draft Task**：
由 Agent 提出、尚未經人確認的 Task；確認後才進入 Backlog。
_Avoid_: Suggestion、Proposed issue

**Spec**：
描述要做什麼的文件。小 Task 的 Spec 就是 Task 描述；大功能的 Spec 是 Repo 中的 markdown 檔，可以連結多個 Task。
_Avoid_: PRD、Requirement doc

**Acceptance Criterion**：
Task 上一條可判定的完成條件，類型為 `command`、`agent`、`browser` 或 `manual`。
_Avoid_: AC、Definition of done、Checklist item

**Gate**：
Task 生命週期中需要人核准才能前進的關卡：Plan Gate（核准 plan）與 Review Gate（核准 diff）。
_Avoid_: Approval step、Checkpoint

**本機合併**：
本機 Repo 的 Review Gate 核准後，Runner 把 Run 的分支合併到本機 checkout 的基準分支（squash 或 merge commit，依 Project 設定），Task 直接轉 Done。工作目錄有未 commit 的變更或衝突時不合併，Run 停下等人處理。
_Avoid_: Local PR、Auto merge

**結束（沒有變更）**：
Review Gate 的 diff 為空時取代核准的決定：Task 轉 Done，不 push、不開 PR，Run 結束。只回答問題的 Task，或 Agent 沒有做事時都會遇到；後者應該退回。
_Avoid_: 略過、Skip、空核准

**Verification**：
Task 進入 Review Gate 前，自動檢查非 `manual` 的 Acceptance Criterion 的階段。
_Avoid_: QA、Validation

### 執行

**Run**：
某個 Agent 為某個 Task 做的一次執行，擁有自己的 Worktree、分支與 ACP session。
_Avoid_: Job、Session、Execution

**主 Run**：
推動 Task 生命週期的 Run：人派工的 Run，以及 Feedback Loop 接續的 Run。Child Run、判定 Verification 與 @agent 的 `consult` Run 都不會改變 Task 的狀態。
_Avoid_: Root run、Main job

**Child Run**：
由另一個 Run 透過 Delegation 產生的 Run。
_Avoid_: Sub-agent、Subtask

**Delegation**：
一個 Run 把工作交給另一個 Agent 產生 Child Run 的行為。模式是 `consult`（唯讀諮詢）或 `branch`（在子分支上修改）。
_Avoid_: Handoff、Spawn

**Dispatch**：
Server 把一個待執行的 Run 交給某個 Runner 的一次指派，有唯一的 Dispatch ID。
_Avoid_: Job assignment、Lease

**Runner**：
執行 Run 的 daemon：管理 Worktree、啟動 Agent、回報事件。分為 Local Runner 與 Team Runner。
_Avoid_: Worker、Agent host、Daemon

**Local Runner**：
跑在 Member 自己電腦上的 Runner，綁定該 Member，只領取該 Member 選擇「在我的電腦跑」的 Run。
_Avoid_: Desktop runner

**Team Runner**：
跑在團隊伺服器容器中的 Runner，領取團隊佇列中的 Run，使用 Team 共用的 Credential。
_Avoid_: Central runner、Cloud runner、Remote runner

**Pairing**：
把一個 Runner 綁定到 Member 或 Team 的過程。
_Avoid_: Registration

**Pairing token**：
Runner 第一次連上 Server 時用來完成 Pairing 的一次性憑證。Local Runner 的 Pairing token 由 Electron 登入時取得，Team Runner 的由 Admin 在 UI 產生。
_Avoid_: Registration token、Invite code

**Runner token**：
Pairing 完成後由 Server 發給 Runner 的長期憑證，Runner 存在本機，之後重新連線都用它證明身分。Server 只保存它的 hash。
_Avoid_: Session token、API key

**Heartbeat**：
Runner 定時送給 Server 的訊號，Server 據此判斷 Runner 是否在線、Dispatch 是否過期。
_Avoid_: Ping、Keepalive

**Worktree**：
Run 專屬的 git worktree，是 Run 的檔案隔離邊界。
_Avoid_: Workspace、Sandbox、Checkout

**排隊的訊息**：
Run 在回合中或等待權限回覆時，人傳給 Agent 的訊息先排隊，回合結束後才送出（多則合併成一則）；還沒送出前可以收回。也可以選擇中斷目前的回合後立即送出。
_Avoid_: Pending prompt、Draft message

**換 Agent**：
執行中把 Run 改由另一個 Agent 接手：留在同一個 Run 與 Worktree，用新的 Agent 開新的 session，並送出交接 prompt（ADR-0016）。只能換成同一台 Runner 上可以用的 Agent。
_Avoid_: Reassign、Agent swap

**交接 prompt**：
換 Agent 時 Runner 依固定格式組出、交給新 Agent 的第一個 prompt：Task 的規格與驗收條件、人送出的 prompt、Agent 每個回合最後的回覆、目前的計畫、diff 摘要、還沒處理的審查留言。不請舊的 Agent 寫摘要。
_Avoid_: Handoff summary、Context dump

**互動式終端機**：
在 Run 的 Worktree 中開的 shell，經由 Runner 通道顯示在工作區的終端機分頁。人自己下指令，不經過 Permission Policy；Local Runner 只限擁有者，Team Runner 只限 Admin 以上而且要 Team 設定打開（ADR-0014）。
_Avoid_: Remote shell、Console、SSH

### Agent

**Agent**：
透過 ACP 驅動的 coding agent CLI，例如 Claude Code、Codex、Antigravity、Grok Build。
_Avoid_: Model、Bot、Assistant

**Agent Profile**：
某個 Agent 的接入設定：啟動方式、認證方式、能力旗標與已知問題的修補。
_Avoid_: Adapter config、Driver

**Credential**：
讓 Agent 能呼叫模型的登入狀態或 API key，只存在 Runner 主機上。
_Avoid_: Token、Key、Secret

**Permission Policy**：
Runner 回覆 Agent 權限請求的規則，等級為 `manual`、`auto` 或 `yolo`。
_Avoid_: Permission mode、Sandbox mode

### 回饋與協作

**Feedback Loop**：
PR 上的 review 留言或 CI 失敗自動送回原 Run 的 session（開一個新的 Run 接續），由 Agent 修正並 push。
_Avoid_: Auto-fix loop、Bounce-back

**Preview**：
Run 的 Worktree 中跑起來的 dev server，可以在 Orbis 內嵌瀏覽器中開啟，或分享給 Team。
_Avoid_: Deploy preview、Staging

**Preview 網址**：
Server 為 Run 的 Preview 產生的子網域網址 `https://<run-id>.<Preview 網域>/`，流量經由 Runner 通道轉送，只有能查看該 Run 的人登入後才能開啟。
_Avoid_: Share link、Tunnel URL、Public URL

**預覽邀請**：
把一個 Run 的 Preview 分享給特定的人（GitHub 帳號或 email，可以不是 Team 的人）。對方登入並確認在名單上才能開，只看得到預覽頁面；各自有期限，可以撤銷。需要 Team 打開「允許對外分享預覽」（ADR-0015）。
_Avoid_: Public link、Guest access

**Preview 留言**：
在 Preview 畫面上的留言，附截圖、URL，以及在 Electron 中選取的元素的 CSS selector。和 diff 行內留言一起在 Review Gate 退回時送回 Agent。
_Avoid_: Visual comment、Annotation、Screenshot feedback

**Needs You**：
等待某位 Member 處理的項目清單：權限請求、待核准的 Gate、停下來的 Run、Child Run 等待人回答的問題。
_Avoid_: Inbox、Pending queue

**通知**：
送給某位 Member 的一則事件消息（Gate 等待核准、被 @mention 等），經由 Channel 送出：App 內的通知中心與桌面推送。每個人可以依事件類型關閉，或設定勿擾時段（只壓住桌面推送）。
_Avoid_: Alert、Notice

**Channel**：
通知的發送管道。Phase 1 是 `in_app`（通知中心）與 `desktop`（Electron 的桌面推送）。
_Avoid_: Transport、Notifier

**Task 留言**：
人在 Task 上留下的 markdown 留言，可以 @mention；@agent 的 `consult` Run 結束後，Agent 的回覆也貼成一則留言。
_Avoid_: Comment thread、Reply

**Task note**：
Agent（`update_task_note`）或 Feedback Loop 在 Task 上留下的進度或決策紀錄，帶來源 Run，只能由系統寫入。
_Avoid_: Log、Journal

**Event**：
Run 過程中由 Runner 正規化後送到 Server 的一筆紀錄，例如訊息、tool call、diff、權限請求。
_Avoid_: Log、Message、Transcript entry

### 介面（新工作區介面）

**工作區**：
Task 的主畫面（`/tasks/<Task Key>`）：左邊是選定 Run 的事件串流與輸入框，右邊是任務、差異、預覽、終端機四個分頁。`/runs/<id>` 與 `/runs/<id>/review` 開的是同一個工作區。
_Avoid_: Run 頁、Task 頁、Review 頁

**事件串流**：
工作區中依序顯示一個 Run 的 Event：人與 Agent 的訊息、思考、工具呼叫、計畫、驗收、權限請求與狀態變化。
_Avoid_: Chat、Log

**輸入框**：
工作區下方對 Run 送出文字的地方，連同模型、推理強度、Permission Policy 與 Runner 的選擇。依 Run 的狀態，送出代表退回計畫、退回審查、附意見再試或追加 prompt。
_Avoid_: Chat box、Prompt bar

**看板**：
一個 Project 的 Task 依狀態分組，可以切換列表與分欄，在待辦、就緒之間拖曳，拖到執行中即派工。
_Avoid_: Kanban、Task list

**執行紀錄**：
任務分頁中這個 Task 的 Run 與 Child Run 樹，點一個節點就在工作區切換到那個 Run。
_Avoid_: Run tree、Run history

**Task 分享**：
Task 層級的成員與角色，加上一般存取與 Task 邀請（ADR-0012）。Owner、Admin 永遠有完整權限；其他人在 Task 上的有效權限取 Task 角色與「一般存取限制後的 Role」中較高的一個。
_Avoid_: Permission sharing、ACL

**Task 角色**：
Member 在某個 Task 上的角色：擁有者（建立 Task 的人，可以轉移，能管理分享）、可操作（編輯、派工、核准關卡、傳訊息）、可檢視。可以把 Team Viewer 在這個 Task 上調高。
_Avoid_: Task permission、Collaborator role

**一般存取**：
Task 對不在 Task 成員中的人的限制：僅受邀成員（`invited`）、Team 可檢視（`team_view`）、Team 可操作（`team_edit`，預設）。
_Avoid_: Visibility、Link sharing

**Task 邀請**：
以 email 邀請還不是 Member 的人加入某個 Task：對方以 GitHub 登入、已驗證的 email 相符時以 Viewer 身分加入 Team，再取得邀請的 Task 角色。7 天後過期，可以撤銷。
_Avoid_: Team invite、Invite code

**模型目錄**：
每個 Agent 可以選的模型與它們的推理強度（可調整、固定、不支援），以及 Agent 是否已登入。輸入框的模型選單與設定的「代理」分頁共用。
_Avoid_: Model list、Model registry

**推理強度**：
送給模型的思考深度：快速、標準、深度。依模型可能可以調整、固定為某個等級，或不支援。
_Avoid_: Thinking budget、Depth

### 發布

**協定版本**：
Runner↔Server 協定的整數版本（`PROTOCOL_VERSION`），只在不相容的變更時遞增；Server 拒絕版本不同的 Runner，並說明要更新哪一邊。
_Avoid_: Wire version、Schema version

**API 版本**：
Server↔Web 與 Desktop↔Server 共用的 REST／WebSocket 契約的整數版本（`API_VERSION`）。Server 由 `/api/health` 回報，Web 與 Desktop 比對後提示要重新整理、更新 Desktop 還是更新 Server。
_Avoid_: Contract version、Server version

**Release**：
GitHub Releases 上以 tag `v<版本>` 建立的一次 Desktop 發布，附 Windows 與 macOS 的安裝檔、自動更新的描述檔與 Runner 的單獨執行檔。Desktop 從 public Releases 自動更新；draft 與 pre-release 不算。
_Avoid_: Build、Deploy、Version

### 測試

**Fake Agent**：
依劇本行動的 ACP agent（`crates/fake-agent`），只用於測試，不呼叫真實模型。
_Avoid_: Mock agent、Stub agent

**劇本**：
描述 Fake Agent 行為的 YAML 檔，由一串回合組成，每次 prompt 消耗一個回合。新的 Agent 行為先寫成劇本，再寫程式碼。
_Avoid_: Scenario、Fixture


## UI 顯示

程式碼、測試名稱、commit 訊息與文件一律用上面的標準名詞；UI 文字照新工作區介面的原型，依語言顯示下表的文字（字典在 `apps/web/src/i18n`）。同一語系內不中英夾雜，模型名稱、CLI 代號、GitHub、PR 編號等專有名詞除外。

| 名詞 | zh-TW 顯示 | en 顯示 |
|---|---|---|
| Team | 團隊 | Team |
| Member | 成員 | Member |
| Role | 角色 | Role |
| Owner／Admin／Member／Viewer（Role） | 擁有者／管理員／成員／檢視者 | Owner／Admin／Member／Viewer |
| Project | 專案 | Project |
| Repo | 儲存庫 | Repo |
| Task | 任務 | Task |
| Task Key | 任務編號 | Task key |
| Draft Task | 草稿任務 | Draft task |
| Spec | 規格 | Spec |
| Repo Spec | 儲存庫規格 | Repo spec |
| Acceptance Criterion | 驗收條件 | Acceptance criterion |
| Gate | 關卡 | Gate |
| Plan Gate | 計畫關卡 | Plan Gate |
| Review Gate | 審查關卡 | Review Gate |
| Verification | 驗收 | Verification |
| Run | 執行 | Run |
| Child Run | 子執行 | Child run |
| Delegation | 委派 | Delegation |
| Dispatch | 派工 | Dispatch |
| Runner | 執行器 | Runner |
| Local Runner | 本機執行器（Runner 種類顯示「本機」） | Local runner（Local） |
| Team Runner | 團隊執行器（Runner 種類顯示「團隊」） | Team runner（Team） |
| Pairing | 配對 | Pairing |
| Pairing token | 配對碼 | Pairing token |
| Worktree | 工作樹 | Worktree |
| Agent | 代理 | Agent |
| Credential | 憑證 | Credential |
| Permission Policy | 權限策略 | Permission policy |
| `manual`／`auto`／`yolo` | 逐一確認／自動／全部允許 | Manual／Auto／Allow all |
| Feedback Loop | 回饋循環 | Feedback loop |
| Preview | 預覽 | Preview |
| Needs You | 待我處理 | Needs you |
| 通知 | 通知 | Notifications |
| PR | 合併請求 | PR |
| 工作區 | 工作區 | Workspace |
| 事件串流 | 事件串流 | Event stream |
| 輸入框 | 輸入框 | Composer |
| 看板 | 看板 | Board |
| 執行紀錄 | 執行紀錄 | Runs |
| consult／branch（Delegation 的模式） | 諮詢（唯讀）／分支（子分支） | Consult (read-only)／Branch (child branch) |
| Done 的 `completed`／`not_planned` | 已完成／不處理 | Completed／Not planned |
| Task 分享 | 分享 | Share |
| 擁有者／可操作／可檢視（Task 角色） | 擁有者／可操作／可檢視 | Owner／Can edit／Can view |
| 一般存取 `invited`／`team_view`／`team_edit` | 僅受邀成員／`<團隊>` 可檢視／`<團隊>` 可操作 | Only people invited／`<Team>` can view／`<Team>` can edit |
| Task 邀請 | 邀請 | Invite |
| 本機 Repo | 本機儲存庫 | Local repo |
| 本機合併 | 合併到本機 | Local merge |
| 排隊的訊息 | 排隊中的訊息 | Queued message |
| 換 Agent | 換代理 | Switch agent |
| 交接 prompt | 換代理的交接 | Agent handoff |
| 互動式終端機 | 終端機 | Terminal |
| 預覽邀請 | 邀請檢視預覽 | Preview invite |
| 模型目錄 | 模型 | Model |
| 推理強度 | 推理強度（快速／標準／深度） | Reasoning effort（Fast／Standard／Deep） |
