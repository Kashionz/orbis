# @orbis/server

Orbis 的 Server（B 軌）：Hono API、Runner 與 Web 的 WebSocket、Drizzle。設計依據是 [ARCHITECTURE](../../docs/ARCHITECTURE.md)。

```sh
pnpm --filter @orbis/server dev    # 讀 repo 根目錄的 .env，變數見 .env.example
pnpm --filter @orbis/server test   # DB 測試的 Postgres：見下方「測試用的 Postgres」
```

## 測試用的 Postgres

DB 測試與 `e2e:stack` 一律在「測試用的 Postgres」上建立自己的 database（`test_<亂數>`、`e2e_<亂數>`），用完刪除，**不使用開發 DB**（`ORBIS_DATABASE_URL`）。

- 有設定 `ORBIS_TEST_DATABASE_URL`（admin 連線，需要 CREATEDB 權限）時用那個 Postgres，不需要 Docker。CI 在 Windows、macOS 都把安裝的原生 Postgres 傳進來。
- 沒有設定時以 Testcontainers 啟動 Postgres 17（需要 Docker）。CI 上沒有設定、又不是 Linux 時，DB 測試明確略過並印出原因。
- `ORBIS_TEST_DATABASE_URL` 與 `ORBIS_DATABASE_URL` 指向同一個 database 時直接失敗。

## 完整系統 e2e 的啟動腳本（`e2e:stack`）

Web 與 Desktop 的完整系統 e2e（M1 路徑，到 merge 後 Task 轉 Done）需要真實的 Server、Postgres、Local Runner 與 Fake Agent。`scripts/system-e2e-stack.ts` 一次把它們全部準備好，執行到收到結束訊號為止。

依決定 R22，這支腳本不開任何測試用的登入端點，Member 與 session 直接寫進 DB。

### 前置

先編譯 Runner 與 Fake Agent：

```sh
cargo build -p orbis-runner -p orbis-fake-agent
```

腳本預設使用 `target/debug/` 下的執行檔，Windows 會自動加上 `.exe`。

### 執行

```sh
pnpm --filter @orbis/server e2e:stack
```

- **Postgres**：見「測試用的 Postgres」。有設定 `ORBIS_TEST_DATABASE_URL` 時在那個 Postgres 上建立 `e2e_<亂數>` database，結束時刪除；沒有設定時以 Testcontainers 啟動 Postgres 17（需要 Docker）。啟動後都會先跑 migration。
  - 腳本不讀 `ORBIS_DATABASE_URL`，`e2e:stack` 也不載入 repo 根目錄的 `.env`，所以不會寫進開發 DB。
  - 有設定時完全不會載入 Testcontainers，所以在沒有 Docker 的 macOS、Windows 上，接原生 Postgres 也能用（CI 在 Windows、macOS 都這樣跑）。
- **Server**：在同一個程序內啟動。
  - port 取自 `ORBIS_SERVER_PORT`，預設 4000，所以 Web 的 Vite proxy 不用改。
  - Web 的 origin 取自 `ORBIS_PUBLIC_URL`，預設 `http://localhost:5173`；`/api/ws` 會檢查請求的 Origin。
  - 掛上真實的 GitHub App 整合（`packages/github`），連 GitHub 的部分換成 D 軌的 `FakeGitHub`（in-memory）。
    - Review Gate 核准、Runner push 之後，會像正式環境一樣以 App 開 PR，寫入 `pull_requests`。PR 號碼依序是 1、2…，可以用 head branch 找到對應的 PR。
    - webhook 路由 `API_ROUTES.githubWebhook`（`/api/webhooks/github`）已掛上，secret 每次隨機產生，寫在 ready 行。
    - 不自動建立 GitHub Issue（Project 的 `autoCreateIssues` 是 false）。
  - Heartbeat 間隔預設 1 秒，可以用 `ORBIS_RUNNER_HEARTBEAT_INTERVAL_MS` 調整。
- **種子資料**：每次執行都建立新的一組，重複使用同一個資料庫也不會衝突：
  - Team，與它的 Owner 和這個 Owner 的 session。
  - Project：Task Key 前綴 `SYS`，預設 Permission Policy 是 `manual`，所以 M1 劇本的寫檔權限請求一定會出現在 Needs You；不自動建立 GitHub Issue。
  - Repo：`e2e/m1-repo`，default branch `main`，GitHub App 已安裝（`github.installed` 是 true）。repo id 與 installation id 每次隨機產生，寫在 ready 行的 `github.repo`。
- **本機 repo**：在暫存目錄建立 bare repo（含一個 README 的 commit），再 clone 出一份 checkout，checkout 的 `origin` 指向 bare repo。
  - Server 送給 Runner 的 clone URL 一律是 GitHub 的網址（`https://github.com/e2e/m1-repo.git`）。
  - `runner.toml` 以 `[repos."https://github.com/e2e/m1-repo.git"] path = <checkout>` 對應到這份 checkout。
  - Runner 從 checkout 開 Worktree，fetch 與 push 都走它的 `origin`，也就是本機 bare repo，不連網路。Server 的程式沒有為此修改。
- **Runner**：
  - 在 Runner 的本機目錄（`ORBIS_HOME`）寫 `runner.toml`，把 `claude-code` 換成 Fake Agent 執行 `crates/fake-agent/scripts/m1.yaml`。預設是暫存目錄中的 `runner-home/`。
  - 以 Owner 的 session 建立 Local Runner 的 Pairing token，以環境變數 `ORBIS_PAIRING_TOKEN` 交給 Runner。token 可能以 `-` 開頭，不能放在命令列上。
  - 以 sidecar 模式啟動真實的 `orbis-runner`。
  - 等到 Server 收到它的第一個 Heartbeat（`accepting_dispatches` 為 true），並且它回報 `claude-code` 可用。
  - 指定 `--runner-config-out` 時不啟動 Runner，見下一節。

### 不啟動 Runner 的模式（`--runner-config-out <dir>`）

給 Desktop 的 e2e 使用：Runner 由 Electron 的 sidecar 啟動，自己完成 Pairing。

```sh
pnpm --filter @orbis/server e2e:stack -- --runner-config-out <dir>
```

- stack 照常建立種子資料、bare repo 與 checkout，但**不**建立 Pairing token、不啟動 Runner。
- 把對應好的 `runner.toml` 寫到 `<dir>/runner.toml`（檔名是 `NAMES.runnerConfigFile`），內容和自己啟動 Runner 時相同：
  - `server`：stack 的 Server 網址。Runner 的優先順序是 `--server` > `ORBIS_SERVER_URL` > `runner.toml` 的 `server`，所以 Desktop 以環境變數指定的 Server 會蓋過它。
  - `worktree_root`：stack 暫存目錄中的 `wt/`。
  - `[repos."https://github.com/e2e/m1-repo.git"] path = <checkoutPath>`。
  - `[agents.claude-code] command = <Fake Agent> args = ["--script", <m1.yaml>]`。
- **Runner 讀取 `runner.toml` 的位置**：一律是 `<ORBIS_HOME>/runner.toml`，也就是 Runner 本機目錄的根，不是狀態目錄。
  - 狀態目錄預設是 `<ORBIS_HOME>/runner/`，可以用 `ORBIS_RUNNER_STATE_DIR` 另外指定。Desktop 的 sidecar 就是這樣指定的，設定檔仍從 `ORBIS_HOME` 讀。
  - 所以 Desktop 的 e2e 要以 `ORBIS_HOME=<dir>` 啟動 Electron。Desktop 會把自己的環境變數傳給 sidecar，只覆寫 `ORBIS_SERVER_URL`、`ORBIS_PAIRING_TOKEN`、`ORBIS_RUNNER_STATE_DIR`。
- ready 行的 `runnerId`、`runnerPid` 是 `null`，`runnerHome` 是 `<dir>`。Runner 上線後，可以用 `GET /api/runners`（帶 `sessionCookie`）查到它。
- 結束時刪除 stack 自己的暫存目錄（包括 checkout、bare repo、`wt/`），但不刪除 `<dir>`，由呼叫端自己清理。

M1 劇本在退回時要求 prompt 包含「改成第二版」，例如在 diff 上留言「請改成第二版」。

### 參數與環境變數

| 參數 | 環境變數 | 預設 |
|---|---|---|
| `--runner-bin <path>` | `ORBIS_E2E_RUNNER_BIN` | `target/debug/orbis-runner(.exe)` |
| `--fake-agent-bin <path>` | `ORBIS_E2E_FAKE_AGENT_BIN` | `target/debug/orbis-fake-agent(.exe)` |
| `--agent-script <path>` | `ORBIS_E2E_AGENT_SCRIPT` | `crates/fake-agent/scripts/m1.yaml` |
| `--port <port>` | `ORBIS_SERVER_PORT` | `4000` |
| `--runner-config-out <dir>` | — | 未指定時 stack 自己啟動 Runner |
| — | `ORBIS_TEST_DATABASE_URL` | 未設定時用 Testcontainers |
| — | `ORBIS_PUBLIC_URL` | `http://localhost:5173` |
| — | `ORBIS_RUNNER_HEARTBEAT_INTERVAL_MS` | `1000` |
| — | `ORBIS_LOG_LEVEL` | `info` |

用 `pnpm --filter @orbis/server e2e:stack -- --port 4100` 傳參數。

### ready 行

一切就緒後，stdout 只會印一行 JSON。其他 log（包括 Runner 的 log 與 sidecar 狀態）一律寫到 stderr。

```json
{"ready":true,"serverUrl":"http://localhost:4000","webOrigin":"http://localhost:5173","sessionCookie":{"name":"orbis_session","value":"…"},"teamId":"…","memberId":"…","projectId":"…","projectKey":"SYS","repoId":"…","runnerId":"…","runnerPid":12345,"runnerHome":"…","runnerConfigPath":"…","bareRepoPath":"…","checkoutPath":"…","databaseUrl":"postgres://…","github":{"webhookUrl":"http://localhost:4000/api/webhooks/github","webhookSecret":"…","repo":{"owner":"e2e","name":"m1-repo","id":123456789,"installationId":12345678}},"tempDir":"…"}
```

| 欄位 | 說明 |
|---|---|
| `ready` | 一律是 `true` |
| `serverUrl` | Server 的網址（`http://localhost:<port>`） |
| `webOrigin` | Server 設定的 Web origin（`ORBIS_PUBLIC_URL`） |
| `sessionCookie.name`、`sessionCookie.value` | Owner 的 session cookie。設定到 Web 的 origin 上就是已登入的狀態，名稱取自 Server 的 `SESSION_COOKIE` |
| `teamId`、`memberId` | 種子資料的 Team 與 Owner |
| `projectId`、`projectKey` | Project 的 ID 與 Task Key 前綴（`SYS`） |
| `repoId` | Project 中唯一的 Repo |
| `runnerId`、`runnerPid` | 已上線的 Local Runner，與它的程序 ID；`--runner-config-out` 模式下是 `null` |
| `runnerHome` | Runner 的本機目錄（`ORBIS_HOME`）。`--runner-config-out` 模式下是指定的目錄 |
| `runnerConfigPath` | `<runnerHome>/runner.toml` |
| `bareRepoPath` | 本機 bare repo。核准後 Runner 把分支 push 到這裡，可以用 `git -C <bareRepoPath> show <branch>:<path>` 確認結果 |
| `checkoutPath` | Runner 開 Worktree 用的 checkout |
| `databaseUrl` | stack 使用的資料庫。e2e 的 helper 用它依 head branch 找出 PR 號碼 |
| `github.webhookUrl` | GitHub webhook 的網址 |
| `github.webhookSecret` | 這次執行隨機產生的 webhook secret（`X-Hub-Signature-256` 以它簽章） |
| `github.repo` | 種子資料的 Repo 在 GitHub 上的 `owner`、`name`、`id` 與 `installationId` |
| `tempDir` | 這次執行的暫存目錄，結束時刪除 |

### 結束

以下任一情況會結束腳本：

- Ctrl+C（SIGINT）。
- SIGTERM。
- stdin 是 pipe 時，關閉 stdin。stdin 是終端機或 `/dev/null` 時不看 stdin，所以可以直接在背景執行。
- 在 Windows 上，以 Node 的 `kill()` 結束子程序不會觸發清理；由程式管理時請關閉 stdin。

結束時依序處理以下事項，正常時以 0 結束：

1. 停掉 Runner：先以 sidecar 的方式關閉 stdin，10 秒內沒有結束就連同子程序強制結束，Windows 用 `taskkill /T`。
2. 關閉 Server 與資料庫連線。
3. 刪除 stack 建立的 database，或停掉 Testcontainers。
4. 刪除暫存目錄。

Runner 意外結束時，腳本也會清理並以 1 結束。

### merge PR：`@orbis/server/e2e` 的 helper

e2e 走到 PR Open 之後，以 helper 模擬「在 GitHub 上 merge 了 App 開的 PR」：

```ts
import { parseReadyLine, sendPullRequestMergedWebhook } from "@orbis/server/e2e";

const ready = parseReadyLine(firstStdoutLine);
// 以 Run 的分支（Run 的 `branch`）找出 PR；也可以用 { prNumber: 1 }
const { status, pullRequest } = await sendPullRequestMergedWebhook(ready, { branch: run.branch });
// status 是 200，Task 轉為 Done，doneReason 是 completed
```

- 使用的套件要在 `package.json` 加上 `"@orbis/server": "workspace:*"`（devDependencies）。
- helper 的行為：
  - 以 `ready.databaseUrl` 從 `pull_requests` 依 head branch 或 PR 號碼找出 PR，取得號碼、head sha 與網址。PR 還沒開出時丟出錯誤，可以重試到開出為止。
  - payload 以 D 軌從測試 repo 錄製的真實 `pull_request.closed` payload（`packages/github/test/fixtures/webhooks/pull_request.closed.json`）為底，只替換 PR、repo 與 installation 的欄位，`merged` 設為 true。
  - 以 `ready.github.webhookSecret` 簽章，`X-GitHub-Delivery` 每次隨機產生，然後送到 `ready.github.webhookUrl`。
- 也匯出 `pullRequestMergedPayload(ready, pullRequest)`，可以只組 payload、自己送出。

### 在 CI 中使用

在 Playwright 之前於背景啟動，讀到 ready 行後再開始測試。

- C 軌的 spec 用 `sessionCookie` 設定 cookie，用 `bareRepoPath` 確認 push 的結果，用 `sendPullRequestMergedWebhook` 完成 merge → Done。
- E 軌（Desktop）以 `--runner-config-out <dir>` 啟動，再以 `ORBIS_HOME=<dir>` 啟動 Electron。
- `test/system-e2e-stack.test.ts` 以子程序執行這支腳本，可以參考它的寫法。它涵蓋：
  - 走過 M1 劇本到 merged webhook → Done；
  - `--runner-config-out` 模式；
  - 關閉後沒有殘留的程序，stack 建立的 database 已刪除；
  - 不使用開發 DB（環境中放一個指向哨兵 database 的 `ORBIS_DATABASE_URL`，跑完後哨兵仍是空的）。
- `test/system-e2e-stack.test.ts` 與其他 DB 測試共用同一個測試用的 Postgres（以 `ORBIS_TEST_DATABASE_URL` 傳給 stack），執行條件同 DB 測試。
