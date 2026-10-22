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

**Verification**：
Task 進入 Review Gate 前，自動檢查非 `manual` 的 Acceptance Criterion 的階段。
_Avoid_: QA、Validation

### 執行

**Run**：
某個 Agent 為某個 Task 做的一次執行，擁有自己的 Worktree、分支與 ACP session。
_Avoid_: Job、Session、Execution

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

**Worktree**：
Run 專屬的 git worktree，是 Run 的檔案隔離邊界。
_Avoid_: Workspace、Sandbox、Checkout

### Agent

**Agent**：
透過 ACP 驅動的 coding agent CLI，例如 Claude Code、Codex、Gemini CLI、Grok Build。
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
PR 上的 review 留言或 CI 失敗自動送回原 Run，由 Agent 修正並 push。
_Avoid_: Auto-fix loop、Bounce-back

**Preview**：
Run 的 Worktree 中跑起來的 dev server，可以在 Orbis 內嵌瀏覽器中開啟，或分享給 Team。
_Avoid_: Deploy preview、Staging

**Needs You**：
等待某位 Member 處理的項目清單：權限請求、待核准的 Gate、停下來的 Run。
_Avoid_: Inbox、Pending queue

**Event**：
Run 過程中由 Runner 正規化後送到 Server 的一筆紀錄，例如訊息、tool call、diff、權限請求。
_Avoid_: Log、Message、Transcript entry
