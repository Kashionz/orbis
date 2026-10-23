# @orbis/server

Orbis 的 Server（B 軌）：Hono API、Runner 與 Web 的 WebSocket、Drizzle。設計依據是 [ARCHITECTURE](../../docs/ARCHITECTURE.md)。

```sh
pnpm --filter @orbis/server dev    # 讀 repo 根目錄的 .env，變數見 .env.example
pnpm --filter @orbis/server test   # DB 測試以 Testcontainers 啟動 Postgres，需要 Docker
```

## 完整系統 e2e 的啟動腳本（`e2e:stack`）

Web 的完整系統 e2e（M1 路徑）需要真實的 Server、Postgres、Local Runner 與 Fake Agent。`scripts/system-e2e-stack.ts` 一次把它們全部準備好，執行到收到結束訊號為止。

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

- **Postgres**：有設定 `ORBIS_DATABASE_URL` 時用它，`pnpm` 會讀 repo 根目錄的 `.env`。沒有設定時以 Testcontainers 啟動 Postgres 17（需要 Docker）。啟動後都會先跑 migration。
- **Server**：在同一個程序內啟動。
  - port 取自 `ORBIS_SERVER_PORT`，預設 4000，所以 Web 的 Vite proxy 不用改。
  - Web 的 origin 取自 `ORBIS_PUBLIC_URL`，預設 `http://localhost:5173`；`/api/ws` 會檢查請求的 Origin。
  - 開 PR 時回假的網址，不連 GitHub。
  - Heartbeat 間隔預設 1 秒，可以用 `ORBIS_RUNNER_HEARTBEAT_INTERVAL_MS` 調整。
- **種子資料**：每次執行都建立新的一組，重複使用同一個資料庫也不會衝突：
  - Team，與它的 Owner 和這個 Owner 的 session。
  - Project：Task Key 前綴 `SYS`，預設 Permission Policy 是 `manual`，所以 M1 劇本的寫檔權限請求一定會出現在 Needs You；不自動建立 GitHub Issue。
  - Repo：`e2e/m1-repo`，default branch `main`。
- **本機 repo**：在暫存目錄建立 bare repo（含一個 README 的 commit），再 clone 出一份 checkout，checkout 的 `origin` 指向 bare repo。
  - Server 送給 Runner 的 clone URL 一律是 GitHub 的網址（`https://github.com/e2e/m1-repo.git`）。
  - `runner.toml` 以 `[repos."https://github.com/e2e/m1-repo.git"] path = <checkout>` 對應到這份 checkout。
  - Runner 從 checkout 開 Worktree，fetch 與 push 都走它的 `origin`，也就是本機 bare repo，不連網路。Server 的程式沒有為此修改。
- **Runner**：
  - 以 Owner 的 session 建立 Local Runner 的 Pairing token。
  - 在暫存的 `ORBIS_HOME` 寫 `runner.toml`，把 `claude-code` 換成 Fake Agent 執行 `crates/fake-agent/scripts/m1.yaml`。
  - 以 sidecar 模式啟動真實的 `orbis-runner`。
  - 等到 Server 收到它的第一個 Heartbeat（`accepting_dispatches` 為 true），並且它回報 `claude-code` 可用。

M1 劇本在退回時要求 prompt 包含「改成第二版」，例如在 diff 上留言「請改成第二版」。

### 參數與環境變數

| 參數 | 環境變數 | 預設 |
|---|---|---|
| `--runner-bin <path>` | `ORBIS_E2E_RUNNER_BIN` | `target/debug/orbis-runner(.exe)` |
| `--fake-agent-bin <path>` | `ORBIS_E2E_FAKE_AGENT_BIN` | `target/debug/orbis-fake-agent(.exe)` |
| `--agent-script <path>` | `ORBIS_E2E_AGENT_SCRIPT` | `crates/fake-agent/scripts/m1.yaml` |
| `--port <port>` | `ORBIS_SERVER_PORT` | `4000` |
| — | `ORBIS_DATABASE_URL` | 未設定時用 Testcontainers |
| — | `ORBIS_PUBLIC_URL` | `http://localhost:5173` |
| — | `ORBIS_RUNNER_HEARTBEAT_INTERVAL_MS` | `1000` |
| — | `ORBIS_LOG_LEVEL` | `info` |

用 `pnpm --filter @orbis/server e2e:stack -- --port 4100` 傳參數。

### ready 行

一切就緒後，stdout 只會印一行 JSON。其他 log（包括 Runner 的 log 與 sidecar 狀態）一律寫到 stderr。

```json
{"ready":true,"serverUrl":"http://localhost:4000","webOrigin":"http://localhost:5173","sessionCookie":{"name":"orbis_session","value":"…"},"teamId":"…","memberId":"…","projectId":"…","projectKey":"SYS","repoId":"…","runnerId":"…","runnerPid":12345,"bareRepoPath":"…","checkoutPath":"…","tempDir":"…"}
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
| `runnerId`、`runnerPid` | 已上線的 Local Runner，與它的程序 ID |
| `bareRepoPath` | 本機 bare repo。核准後 Runner 把分支 push 到這裡，可以用 `git -C <bareRepoPath> show <branch>:<path>` 確認結果 |
| `checkoutPath` | Runner 開 Worktree 用的 checkout |
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
3. 停掉 Testcontainers。
4. 刪除暫存目錄。

Runner 意外結束時，腳本也會清理並以 1 結束。

### 在 CI 中使用

在 Playwright 之前於背景啟動，讀到 ready 行後再開始測試。

- C 軌的 spec 用 `sessionCookie` 設定 cookie，用 `bareRepoPath` 確認 push 的結果。
- `test/system-e2e-stack.test.ts` 以子程序執行這支腳本，走過 M1 劇本，並確認關閉後沒有殘留的程序。可以參考它的寫法。
