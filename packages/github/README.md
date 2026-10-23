# @orbis/github

GitHub 整合（D 軌）：GitHub App、webhook、Task 與 GitHub Issues 的雙向同步、Review Gate 核准後開 PR、PR merge 後 Task 轉 Done、PR 的 Feedback Loop、Repo Spec 提交到 repo。設計依據是 [ARCHITECTURE §5、§11、§12.1、§15](../../docs/ARCHITECTURE.md) 與 [ADR-0004](../../docs/adr/0004-self-built-task-model-with-issues-sync.md)。

## GitHub App

### 權限

| 權限 | 等級 | 用途 |
|---|---|---|
| Issues | Read & write | Issues 雙向同步、狀態摘要留言 |
| Pull requests | Read & write | 開 PR、讀取 review（D2） |
| Contents | Read & write | Team Runner 以 installation token push 分支；D2 的「提交 Spec 到 repo」 |
| Checks | Read | D2：讀取 CI 結果 |
| Actions | Read | D2：讀取 GitHub Actions 的 job log，擷取 CI 失敗的段落。沒有這個權限時，Feedback Loop 退回只用 annotations 與 check 的 output |
| Metadata | Read | 所有 App 都需要 |

### 訂閱的 webhook 事件

`issues`、`issue_comment`、`pull_request`、`pull_request_review`、`pull_request_review_comment`、`check_suite`、`check_run`。

- `installation`、`installation_repositories` 不需要訂閱，App 一律會收到。
- `issues`：Issues 雙向同步。
- `issue_comment`：Issue 上狀態摘要留言被刪除時重建；PR 上新的留言是 Feedback Loop 的回饋。
- `pull_request`：`closed`、`reopened` 更新 Task 或 Repo Spec 的 PR；`synchronize` 記下 PR 目前的 head commit。
- `pull_request_review`、`check_suite`、`check_run`：Feedback Loop 的觸發來源。
- `pull_request_review_comment` 有訂閱但不處理：它在所屬的 review 之後才送到，review 送出時已經讀過留言。
- `installation`、`installation_repositories`：App 的安裝狀態。

完整的 manifest 由 [`src/manifest.ts`](src/manifest.ts) 產生，因為產品名稱只能從名稱常數取得，所以不放靜態的 JSON 檔。

### 建立與安裝

1. **建立 App**（manifest 流程）：

   ```sh
   pnpm --filter @orbis/github app:create --webhook-url <webhook 網址> [--public-url <Server 對外網址>] [--org <組織>]
   ```

   - 用瀏覽器開啟印出的 `http://localhost:4401/`，按下按鈕到 GitHub 確認建立。
   - 完成後 App ID、private key、webhook secret、slug 會寫進 repo 根目錄的 `.env`（不會被 commit）。
   - 正式部署時，webhook 網址是 `<Server 對外網址>/api/webhooks/github`。開發時可以用 [smee.io](https://smee.io) 的 channel。
2. **安裝 App**：到 `https://github.com/apps/<slug>/installations/new`，選擇要讓 Orbis 管理的 repo。
3. **在 Project 登記 Repo**：Server 呼叫 `inspectRepo(owner, name, requesterMemberId)`，確認 App 已安裝並讀取 default branch 與 repo id。
   - 提出請求的 Member 本人（以 GitHub 帳號）必須對 repo 有寫入權限，否則回應與「沒有安裝」相同。
   - 這是因為同一個 App 可能安裝在不同 Team 的 repo 上。
   - Server 登記 Repo 時只能使用這裡回傳的 installation 與 repo id。
4. **安裝狀態的即時更新**：`installation`（created、deleted、suspend、unsuspend）與 `installation_repositories` 事件會更新 Repo 的 installation。
   - 已知 repo id 的 Repo 直接更新。payload 沒有列出 repo 時（例如 unsuspend），向 GitHub 查詢這個 installation 能存取的 repo。
   - App 安裝之前登記的 Repo 還不知道 repo id，以 owner/name 比對。為了避免別的 Team 先登記同名的 repo，只在安裝 App 的人是該 Project 的 Member、而且對 repo 有寫入權限時才綁定，並補上 repo id 與 default branch。

### 環境變數

這四個變數都沒設定時，GitHub 整合停用（`loadGitHubAppConfig` 回傳 null）。只設定一部分會啟動失敗。

| 變數 | 說明 |
|---|---|
| `ORBIS_GITHUB_APP_ID` | App ID（數字） |
| `ORBIS_GITHUB_APP_PRIVATE_KEY` | App 的 private key（PEM）；在 `.env` 中可以用 `\n` 表示換行 |
| `ORBIS_GITHUB_WEBHOOK_SECRET` | webhook secret |
| `ORBIS_GITHUB_APP_SLUG` | App 的 slug（`https://github.com/apps/<slug>`），用來組安裝連結、辨認 App 自己的 bot 帳號 |

`.env.example` 是根目錄的檔案，由整合階段補上這四個變數。

## Server 的接法

```ts
import { API_ROUTES } from "@orbis/api-contract";
import { createGitHubIntegration, createGitHubWebhookRoutes, loadGitHubAppConfig } from "@orbis/github";

const config = loadGitHubAppConfig(process.env);
if (config) {
  const github = createGitHubIntegration({
    config, domain, store, notifier, logger, taskUrl,
    // 選填：沒有提供時 Feedback Loop 停用、commitRepoSpec 回傳 disabled
    feedback: { store: feedbackStore, runs: feedbackRuns, botAllowlist },
    repoSpecs: { store: repoSpecStore, getRepoSpec, recordRepoSpecMerged },
  });
  app.route(API_ROUTES.githubWebhook, createGitHubWebhookRoutes(github));
  const feedbackTimer = github.startFeedbackTimer(); // 關閉時 feedbackTimer.stop()
}
```

這個套件只提供 webhook 的路由。匯入 Issue 的端點由 Server 依 `API_ROUTES`（`repoImportableIssues`、`repoImportIssues`）提供，登入與 Role 檢查、錯誤格式和其他端點一致，內部呼叫 `listImportableIssues`、`importIssues`。實際的掛載在 `apps/server/src/routes/github.ts`。

### Server 呼叫這個套件

| 時機 | 呼叫 |
|---|---|
| Task 建立或修改之後：title、描述、狀態、關閉原因、負責人、labels、Acceptance Criterion 的結果、Run 狀態。Draft Task 確認、進入 Backlog 之前不要呼叫 | `github.onTaskChanged(taskId, { actorMemberId })`：`actorMemberId` 是做出修改的 Member，系統觸發的修改不用傳 |
| Runner 回報 `branch_pushed`（Review Gate 核准之後） | `github.onBranchPushed({ taskId, runId, branch, commitSha })` |
| Project 新增 Repo | `github.inspectRepo(owner, name, requesterMemberId)` |
| Member 從 Issue 匯入 Task（`API_ROUTES.repoImportableIssues`、`repoImportIssues`） | `github.listImportableIssues(repoId)`、`github.importIssues({ repoId, issueNumbers, importedByMemberId })`；Repo 沒有安裝 App 時丟出 `RepoNotConnectedError` |
| Team Runner 要 push | `github.getInstallationTokenForRepo(repoId)`：只限該 repo、只有 contents 寫入權限 |
| Repo 設定頁的「重新檢查安裝狀態」 | `github.refreshRepoInstallation(repoId, requesterMemberId)` |
| 「提交到 repo」 | `github.commitRepoSpec({ repoSpecId, markdown, requesterMemberId, message? })`：`markdown` 是共同編輯草稿的內容 |
| Server 啟動、關閉 | `github.startFeedbackTimer()` 與它回傳的 `stop()`：每 15 秒送出到期的 Feedback Loop 批次 |
| Feedback Loop 的 Run 沒有 push 就結束（失敗、中止） | `github.onFeedbackRunEnded({ runId })`。push 成功時照常是 `onBranchPushed` |

Review Gate 核准時由 Server 把 Task 轉成 `pr_open`（ARCHITECTURE §5），這個套件只負責之後開 PR；開 PR 失敗時回傳 `{ ok: false }` 並通知 Task 負責人，Task 維持 `pr_open`。

由這個套件透過 `DomainService` 發起的寫入，Server 不需要再呼叫 `onTaskChanged`。就算呼叫了，也只會多打 API，不會造成重複寫入。

### 這個套件需要 Server 提供

定義在 [`src/ports.ts`](src/ports.ts)：

- **`DomainService`**：讀取 Task、Repo、Member、Acceptance Criterion、最近的 Run；從 Issue 建立 Task；寫回 Task 欄位；要求狀態轉換；判斷 Member 能不能編輯 Task（`canEditTasks`，Viewer 不行）；Project 是否開啟「自動建立 Issue」（`autoCreateIssues`）；以 owner/name 找 Repo（`listReposByFullName`，安裝事件用）。狀態轉換會檢查進行中的 Run 與狀態機，不合法時回傳原因。需要的轉換如下：
  - 任何非 Done 狀態轉 `done`：Issue 被關閉、PR merge。`cause.doneReason` 是要記錄的關閉原因（PR merge 一律是 `completed`）。
  - `done` 轉 `backlog`：Issue 重新打開。Server 清空關閉原因。
  - Task 已經是 Done 時，GitHub 上改了關閉原因，會以 `updateTaskFields(taskId, { doneReason })` 寫回。
  - `pr_open` 轉 `review_gate`：PR 沒有 merge 就被關閉。
  - `review_gate` 轉 `pr_open`：PR 重新打開。
- **`GitHubStore`**：Issue 對應與同步快照、webhook delivery 去重、PR 對應。資料表在 `apps/server/src/db/schema/github.ts`。同一個 Repo 中一個 Issue 只能對應一個 Task，違反時 `saveIssueLink` 丟出 `IssueAlreadyLinkedError`（兩人同時匯入時，後到的一方回傳 `already_linked`）。Drizzle 的實作要通過 `@orbis/github/testing/store-contract` 的契約測試。
- **`Notifier`**：PR merge、PR 沒有 merge 就被關閉、開 PR 失敗時通知 Task 負責人；沒有負責人時通知建立者。
- **`taskUrl(task)`**：Task 在 Web UI 上的網址。
- **`feedback`**（選填）：
  - `store: FeedbackStore`：待送批次與自動修正紀錄，Drizzle 的實作要通過 `describeFeedbackStoreContract`。
  - `runs: FeedbackRunPort`：`requestFix` 開一個新的 Run 修正回饋。新的 Run 的 origin 是 `feedback_loop`，連到 `previousRunId`，使用同一個 Runner、分支與 Worktree，resume 原本的 session。Task 轉回 Running，修正經過 Verifying，通過後直接 push、不經過 Review Gate。
  - `botAllowlist(projectId)`：Project 的 bot 白名單。
  - `addTaskNote({ taskId, runId, body, url })`：寫一筆 `source = feedback_loop` 的 Task note。
- **`repoSpecs`**（選填）：
  - `store: RepoSpecStore`：Spec PR 的對應，要通過 `describeRepoSpecStoreContract`。
  - `getRepoSpec`。
  - `recordRepoSpecMerged`：merge 後版本 +1，以原子操作遞增。

## 同步規則

- **欄位**：title、body（Task 描述）、state、assignee、labels（ARCHITECTURE §11）。
- **state**：Task 是 Done 時 Issue 關閉，其他狀態都是 open。關閉原因與 Issue 的 `state_reason` 對應（`completed`、`not_planned`），一起當成 state 欄位同步。
  - 在 GitHub 上關閉 Issue，Task 轉 Done 並記錄關閉原因。以 `duplicate` 關閉視為 `not_planned`。Task 有進行中的 Run 時拒絕，把 Issue 重新打開並在摘要留言說明。
  - 在 GitHub 上重新打開 Issue，已 Done 的 Task 回到 Backlog。
- **assignee**：寫到 GitHub 時，assignees 設成 `[負責人]`；從 GitHub 讀回時，取第一個屬於 Team 的 assignee，沒有就是 null。
- **範圍**：有 Repo 的 Task 自動建立對應的 Issue。Project 關閉「自動建立 Issue」時不建立新的 Issue，已經對應的 Issue（包括匯入的）照常同步。GitHub 上新開的 Issue 不會自動變成 Task，要透過「匯入」。
- **衝突**：依各欄位與上次同步的快照比較，判斷哪一邊改過。兩邊都改了同一欄位時，以最後寫入者為準：比較 Issue 的 `updated_at` 與 Task 的 `updatedAt`。
- **回音**：
  - App 自己的寫入造成的 webhook，以 sender（`<slug>[bot]`）辨認並略過。
  - payload 與快照相同時不寫入。
  - 比該欄位上次同步還舊的 payload（晚到的 webhook）不套用。
- **修改者的權限**：只套用能編輯 Task 的 Project Member，或對 repo 有寫入權限（admin、maintain、write）的人在 GitHub 上的修改。其他人的修改會被改回 Task 的值，並在摘要留言說明。
- **同一個 Issue 對應到不同 Project 的 Task**（同一個 repo 登記在多個 Project）：
  - 每個 Task 各有一則狀態摘要留言。
  - GitHub 上的修改套用到所有對應的 Task，各自以該 Project 檢查修改者的權限。
  - Task 寫到 Issue 的 title、body、state 也會同步到其他 Task（App 自己的寫入造成的 webhook 被當成回音略過，所以不等 webhook）。labels 與負責人各 Project 自己管理。
  - 同步到其他 Task 前，用與 GitHub 上的修改相同的規則檢查做出修改的人（`onTaskChanged` 的 `actorMemberId`，PR merge 時是 merge 的人）：他在對方 Project 也要能編輯 Task，或對 repo 有寫入權限。沒有權限、或沒有傳入做出修改的人時，對方 Task 維持原狀（沒有權限時在它的摘要留言說明）。
  - 另一個 Task 不能跟著轉換狀態時（例如有進行中的 Run），維持原狀並在它的摘要留言說明，不把 Issue 改回來。
- **欄位歸屬**：只套用這個 action 改到的欄位。
  - `edited` 依 payload 的 `changes`；`labeled`／`unlabeled` 只看 labels；`assigned`／`unassigned` 只看 assignee；`closed`／`reopened` 只看 state。
  - payload 中其他與快照不同的欄位不能算在這位 sender 頭上，不套用，等它們自己的 webhook。
- **狀態摘要留言**：每個 Issue 只有一則，以 `<!-- orbis:summary -->` 標記。以 `not_planned` 關閉的 Task 顯示為「Done（不處理）」。內容沒變時不呼叫 API，留言被刪除時會重建。
- **webhook 去重**：
  - 以 `X-GitHub-Delivery` 去重。
  - 處理失敗回 500 並放掉處理權，讓 GitHub 的 redelivery 可以重新處理。
  - 處理中的紀錄超過 5 分鐘沒完成，視為處理者已經掛掉。

## 開 PR

- 以 App 身分開 PR，head 是 Run 的分支，base 是 Repo 的 default branch，標題是 `<Task Key> <title>`。
- body 包含：
  - Task 連結
  - Spec 摘要：Task 描述的前 1500 字，有 Repo 內的 Spec 檔時附上連結
  - Acceptance Criterion 的結果
  - 有對應 Issue 時加上 `Closes #N`
- 同一個分支已經有開著的 PR 時沿用它。
- `pull_request.closed`：
  - merged：Task 轉 Done，通知負責人。
  - 沒有 merge：退回 Review Gate，通知負責人。
- `pull_request.reopened`：回到 PR Open。
- 沒有 merge 的關閉與重開，和 Issue 一樣只採用能編輯 Task 的 Member 或對 repo 有寫入權限的人（GitHub 上 triage 角色也能關閉、重開 PR）。其他人的操作不改 Task 狀態，只記錄 PR 狀態並通知負責人。

## Feedback Loop

規則見 ARCHITECTURE §5.2，程式在 `src/feedback/`。

- **過濾**（`trigger.ts`）：
  - 人類：用 `senderCanWrite` 檢查，與 Issue 同步同一套。
  - bot：要在白名單中（不分大小寫）。
  - App 自己：一律略過。
  - review：`approved` 不觸發。
  - CI：結論是 `failure`、`timed_out` 才觸發，而且只看 PR 目前的 head。
- **批次**（`dispatch.ts`）：
  - 每個 PR 每種來源最多一批，存在 `FeedbackStore`，Server 重啟後還在。
  - 完整的 review 與 CI 立刻到期；零散留言在最後一則之後 2 分鐘到期。
  - 同一個 PR 有 `sent` 的紀錄時，到期的批次也先留著。
- **CI 的判斷**：
  - 每次 `check_suite.completed` 或失敗的 `check_run.completed` 都重新查一次這個 commit 的 suite 與 check run，所以判斷是冪等的。
  - 有 check run 的 suite 都完成後，才把還沒觸發過的失敗 check 合併成一批。
  - 沒有 check run、一直是 `queued` 的 suite 不等，例如 Vercel、Fly.io 這類安裝了但沒在跑 check 的 App。
- **prompt**（`prompt.ts`、`ci-details.ts`、`ci-log.ts`）：
  - review：附上檔案、行號、留言與 `diff_hunk` 的最後 20 行。
  - CI：附上 check 名稱、結論與 output。output 放在 code block 中當資料，長度有上限。
  - GitHub Actions 的 check 另外讀 job log（`actions: read`），只擷取第一個 `##[error]` 所在步驟中錯誤之前的最後 60 行。job log 以串流讀取，最多讀最後 8 MiB。
  - 沒有權限、log 已過期，或不是 Actions 的 check：改附 failure 等級的 annotations。
- **次數與紀錄**（`records.ts`）：
  - 每種來源最多 5 次，次數由 `FeedbackFix` 數出（開成 Run 的才算）。第一次超過時記一筆 `limit_reached`，在 PR 上說明，並以 `feedback_limit_reached` 通知負責人。
  - 每次修正都在 PR 上留下以 `<!-- <產品 slug>:feedback-fix -->` 標記的留言，並寫一筆 Task note；push 後更新同一則留言。

## Repo Spec 提交到 repo

規則見 ARCHITECTURE §12.1，程式在 `src/repo-specs.ts`。

- 分支名稱是 `<產品 slug>/spec/<檔名>-<6 碼亂數>`，以 Contents API commit。
- PR body 以 `<!-- <產品 slug>:repo-spec -->` 標記。
- Spec PR 的 `pull_request.closed` 不會被當成 Task 的 PR 處理。

## 開發與測試

```sh
pnpm --filter @orbis/github test
```

- 測試用 `src/testing/` 中的 fake（`FakeGitHub`、`FakeDomainService`、`InMemoryGitHubStore`），不連到真的 GitHub。
- webhook 測試以 `test/fixtures/webhooks/` 的真實 payload 為底。

### 手動驗證（dev harness）

Server 完成前，用 dev harness 在測試 repo 上走過完整流程。它連的是真實的 GitHub App，Task 則放在記憶體中。

```sh
# 1. webhook 轉送到本機
npx smee-client --url <smee channel> --target http://localhost:4402/api/webhooks/github
# 2. 啟動 harness（--member 是 <GitHub login>:<數字 user id>）
pnpm --filter @orbis/github dev:harness --repo <owner>/<name> --member <login>:<id>
# 3. 操作：POST /dev/tasks、PATCH /dev/tasks/:id、POST /dev/import、POST /dev/tasks/:id/branch-pushed（見 dev/harness.ts）
# 4. 錄製真實 payload 成 fixture（--only 只錄指定的事件，不覆蓋其他 fixture）
pnpm --filter @orbis/github fixtures:record [--only pull_request_review,check_suite]
```

- Feedback Loop 的 fixture 是在 `orbis-sandbox` 的 PR 上錄的。
- sandbox 有一個測試用的 CI（`.github/workflows/ci.yml`），repo 根目錄有 `FAIL_LINT` 或 `FAIL_TEST` 檔案時，對應的 job 會故意失敗。
- 同一種 event／action 依 payload 分成幾個變體，檔名多一段，例如 `issue_comment.created.pr`、`pull_request_review.submitted.commented`、`check_suite.completed.failure`。
