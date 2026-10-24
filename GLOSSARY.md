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
登記在 Project 底下的一個 GitHub repository。
_Avoid_: Repository、Codebase

### 工作

**Task**：
指派給 Member、可交由 Agent 執行的一件工作，只對應一個 Repo，有唯一的 Task Key（例如 `ORB-12`）。
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
