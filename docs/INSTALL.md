# Orbis 安裝與部署

這份文件說明怎麼用 Docker Compose 自架 Orbis Server（ARCHITECTURE §16），讓一台乾淨的 Windows 電腦照著做就能完成：部署 Server → 建立 GitHub App 與 OAuth App → 第一次登入成為 Owner → 安裝 Desktop → 接上 Team Runner → 備份、還原與升級。Desktop 的安裝、SmartScreen／Gatekeeper 與自動更新另見 [DESKTOP.md](DESKTOP.md)。

名詞以 [GLOSSARY](../GLOSSARY.md) 為準。所有設定的變數名稱見 `deploy/.env.example`（Server 的設定定義在 `apps/server/src/config.ts`）。

## 1. 架構與前置條件

```
瀏覽器／Desktop ──HTTPS──▶ 反向代理（選用）──▶ Server 容器（API、Web 靜態檔、Runner WebSocket）──▶ Postgres 容器
GitHub webhook  ──HTTPS──▶                                   ▲
Team Runner 容器（選用，profile `team-runner`）──WS──────────┘
```

- **部署機**：Linux 主機，或 Windows／macOS 上的 Docker Desktop。需要 Docker Engine 24 以上與 Docker Compose v2。
- **網址**：
  - 要讓 GitHub 的 webhook 送得到，Server 需要一個**公開網址**（例如 `https://orbis.example.com`），通常由反向代理（Caddy、nginx、Cloudflare Tunnel 等）提供 HTTPS 並轉到 Server 的 port。反向代理不在這份 compose 中，請自行架設；WebSocket（`/runner`、`/api/ws`、共同編輯）要一併轉送。
  - 只在區域網路使用（例如用 Windows Sandbox／VM 驗收）時，可以直接用 `http://<主機 IP>:4000`，但 webhook 送不進來，要用 §11 的轉送。
  - 要用 Preview 網址（ARCHITECTURE §13）需要 wildcard DNS（`*.preview.example.com`）與 wildcard 憑證，反向代理要把這些子網域也轉給 Server。沒有也能用，只是 Preview 只能在執行 Run 的電腦上用 Desktop 開。
- **GitHub**：一個 GitHub 帳號（建立 OAuth App 與 GitHub App），以及要讓 Orbis 管理的 repo 的 admin 權限（安裝 App）。
- **Agent 的 Credential**：Local Runner 沿用每個人電腦上各 CLI 的登入狀態；Team Runner 的 Credential 以 Docker secret 給（§8）。Server 不保存任何 Agent Credential（ADR-0007）。

## 2. 取得程式碼與建置 image

image 目前在部署機上自己建（Phase 1 不發佈到 registry）：

```sh
git clone https://github.com/Kashionz/orbis.git
cd orbis
git checkout <tag 或 commit>      # 例如 v0.1.0；Server、Team Runner、Desktop 要用同一個版本
cd deploy
cp .env.example .env
```

`deploy/docker-compose.yml` 包含三個 service：

| service | 內容 | 說明 |
|---|---|---|
| `postgres` | `postgres:17` | 資料在 volume `pgdata`；不對外開 port |
| `server` | `apps/server/Dockerfile` | Hono API、Runner 與 Web 的 WebSocket、**Web 的靜態檔**（`vite build` 的輸出，同一個 origin）、GitHub webhook。blob 在 volume `blobs`。啟動時自動執行 migration |
| `team-runner` | `crates/runner/Dockerfile`，profile `team-runner` | 選用。Runner 的本機目錄（Runner token、Worktree）在 volume `runner-home` |

三個都有健康檢查與 `restart: unless-stopped`。Server 等 Postgres 健康才啟動，Team Runner 等 Server 健康才啟動。

## 3. GitHub OAuth App（登入）

1. 到 GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App（組織的 App 在組織的 Settings 中建立）。
2. 填入：
   - Homepage URL：`<ORBIS_PUBLIC_URL>`
   - **Authorization callback URL：`<ORBIS_PUBLIC_URL>/api/auth/github/callback`**（網址要和 `.env` 的 `ORBIS_PUBLIC_URL` 完全一致，含 http／https 與 port）
3. 建立後產生一組 client secret，把 Client ID 與 secret 填進 `deploy/.env` 的 `ORBIS_GITHUB_CLIENT_ID`、`ORBIS_GITHUB_CLIENT_SECRET`。

## 4. GitHub App（Issues 同步、開 PR、Feedback Loop）

GitHub App 負責 Issues 雙向同步、Review Gate 核准後開 PR、接收 PR 與 CI 的 webhook（Feedback Loop）、Repo 的安裝狀態。四個環境變數都不填時這些功能停用，Orbis 仍可以登入與派工；只填一部分 Server 會拒絕啟動。

### 4.1 權限與事件

| 權限 | 等級 | 用途 |
|---|---|---|
| Issues | Read & write | Issues 雙向同步、狀態摘要留言 |
| Pull requests | Read & write | 開 PR、讀取 review |
| Contents | Read & write | 提交 Spec 到 repo；Phase 2 的 Team Runner installation token |
| Checks | Read | 讀取 CI 結果 |
| **Actions** | Read | 讀取 GitHub Actions 的 job log，擷取 CI 失敗的段落給 Feedback Loop。沒有這個權限時只用 annotations 與 check 的 output |
| Metadata | Read | 所有 App 都需要 |

訂閱的 webhook 事件：`issues`、`issue_comment`、`pull_request`、`pull_request_review`、`pull_request_review_comment`、`check_suite`、`check_run`（`installation`、`installation_repositories` 不需要訂閱，App 一律會收到）。

- Webhook URL：`<ORBIS_PUBLIC_URL>/api/webhooks/github`
- Webhook secret：自己產生一組亂數，之後填進 `ORBIS_GITHUB_WEBHOOK_SECRET`
- 「Where can this GitHub App be installed?」：Only on this account 即可

### 4.2 建立 App

**方式 A：用 manifest 流程（在有 pnpm 的開發機上）**。manifest 由程式產生（`packages/github/src/manifest.ts`），權限與事件不會漏填：

```sh
pnpm install
pnpm --filter @orbis/github app:create --public-url https://orbis.example.com --webhook-url https://orbis.example.com/api/webhooks/github [--org <組織>] [--name "Orbis (acme)"]
```

用瀏覽器開啟印出的 `http://localhost:4401/`，按下按鈕到 GitHub 確認建立。完成後 App ID、private key、webhook secret、slug 會寫進**開發機 repo 根目錄的 `.env`**，把這四個值複製到部署機的 `deploy/.env`。

**方式 B：手動建立**。GitHub → Settings → Developer settings → GitHub Apps → New GitHub App，依 §4.1 填權限、事件、Webhook URL 與 secret。建立後：

- App ID 在 App 的 General 頁。
- 在 General 頁最下方 **Generate a private key**，下載的 `.pem` 內容放進 `ORBIS_GITHUB_APP_PRIVATE_KEY`。在 `.env` 中整段放一行、換行以 `\n` 表示，例如 `ORBIS_GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"`。
- slug 是 App 網址 `https://github.com/apps/<slug>` 的最後一段。

### 4.3 安裝 App 到 repo

到 `https://github.com/apps/<slug>/installations/new`，選擇要讓 Orbis 管理的 repo。之後在 Orbis 的 Project 設定頁登記 Repo 時，Server 會確認 App 已安裝、讀取 default branch；提出的人本人要對 repo 有寫入權限。漏掉 webhook 時，Repo 設定頁可以「重新檢查安裝狀態」。

## 5. 填寫 `deploy/.env`

`deploy/.env.example` 的每一項都有說明，至少要填：

| 變數 | 說明 |
|---|---|
| `ORBIS_DB_PASSWORD` | Postgres 密碼（只在 compose 網路內使用，仍請用亂數） |
| `ORBIS_PUBLIC_URL` | 使用者打開的網址，也是 OAuth callback 與 Issue 中 Task 連結的 base。有反向代理時是 `https://...`；沒有時是 `http://<主機 IP>:<ORBIS_DEPLOY_PORT>` |
| `ORBIS_GITHUB_CLIENT_ID`、`ORBIS_GITHUB_CLIENT_SECRET` | §3 |
| `ORBIS_BOOTSTRAP_OWNER` | 第一位 Owner 的 GitHub **數字 user id**（§6） |
| `ORBIS_GITHUB_APP_*` 四項 | §4；不用 GitHub 整合時四個都留空 |

其他：

- `ORBIS_DEPLOY_BIND`／`ORBIS_DEPLOY_PORT`：Server 對外綁的位址與 port。預設 `127.0.0.1:4000`，由同一台機器上的反向代理轉送；要讓區域網路直接連（例如 Windows Sandbox）改成 `0.0.0.0`，並在主機防火牆放行這個 port。
- `ORBIS_API_ORIGIN`：Runner 連的網址。Web 與 API 在同一個 origin，留空等於 `ORBIS_PUBLIC_URL`。
- `ORBIS_PREVIEW_DOMAIN`：Preview 網域（§1）。
- Postgres 的連線字串、容器內的 port、blob 與 Web 靜態檔的目錄由 compose 固定，不用填。
- 這個檔案含有 secret，權限只開給部署的帳號；`deploy/.env` 已在 `.gitignore` 中。

## 6. 第一次啟動

### 6.1 bootstrap owner

第一次登入的人要成為 Team 的 Owner。Server 以 GitHub 的**數字 user id**（不是 login，login 可以改名）辨認：

```sh
gh api user --jq .id                      # 有 gh CLI 時
curl -s https://api.github.com/users/<login> | grep '"id"'   # 沒有 gh 時
```

填進 `ORBIS_BOOTSTRAP_OWNER`。只在資料庫中還沒有任何 Team 時生效；之後的 Member 由 Owner／Admin 在 UI 邀請，這個變數可以留著不影響。

### 6.2 啟動

```sh
cd deploy
docker compose up -d --build
docker compose logs -f server      # 看到「資料庫 migration 完成」與「Server 已啟動」即可
```

- 第一次 `--build` 要下載 base image 並安裝 workspace，需要幾分鐘。
- 設定有誤時 Server 會列出每個有問題的變數後結束（`docker compose logs server`），修好 `.env` 後 `docker compose up -d` 重新建立容器。
- 健康檢查：`docker compose ps` 的 server 顯示 `healthy`，或 `curl http://127.0.0.1:4000/api/health` 回 `{"ok":true,...}`。

### 6.3 登入與建立 Project

1. 用瀏覽器開 `ORBIS_PUBLIC_URL`，以 GitHub 登入。bootstrap owner 第一次登入時自動建立 Team 並成為 Owner。
2. 到「管理」邀請其他 Member（以 GitHub login），設定 Role。
3. 建立 Project、登記 Repo（§4.3），設定預設的 Permission Policy。

### 6.4 用 Windows Sandbox／VM 驗收

Server 跑在主機的 Docker，Sandbox 當乾淨的客戶端：

- Sandbox 透過 NAT 上網，連不到主機的 `localhost`。`ORBIS_PUBLIC_URL` 要用主機的區域網路 IP（例如 `http://192.168.1.20:4000`），`ORBIS_DEPLOY_BIND=0.0.0.0`，主機防火牆放行該 port；OAuth App 的 callback URL 也要用同一個網址。
- GitHub 的 webhook 送不到區域網路 IP：在主機用 §11 的 `gh webhook forward` 轉到 `http://127.0.0.1:4000/api/webhooks/github`。
- 在 Sandbox 中安裝 Desktop，Server URL 填 `ORBIS_PUBLIC_URL`，登入後 Desktop 自動完成 Local Runner 的 Pairing。步驟見 [DESKTOP.md](DESKTOP.md)。

## 7. Desktop 與 Local Runner

Desktop 的下載、安裝（未簽章的安裝檔如何開啟）、自動更新與 Local Runner 的 Pairing 見 [DESKTOP.md](DESKTOP.md)。第一次啟動時輸入 `ORBIS_PUBLIC_URL`，Desktop 以 `/api/health` 確認後登入；登入的人是某個 Team 的 Member 時，自動取得 Pairing token 並啟動 Local Runner。

## 8. Team Runner

Team Runner 是跑在伺服器容器中的 Runner，領取 Team 佇列中的 Run，使用 Team 共用的 Credential。**共用一個 Claude 訂閱有條款風險**（ADR-0005），UI 的 Runner 設定頁會顯示警告；可以改用 API key。

### 8.1 準備 secret

Credential 一律以 Docker secret 傳入，不放在環境變數、`.env` 或 image 中。四個檔案都要存在，不用的留空（詳見 [`deploy/secrets/README.md`](../deploy/secrets/README.md)）：

```sh
cd deploy/secrets
touch pairing_token github_token agent_credentials codex_auth_json
```

| 檔案 | 內容 |
|---|---|
| `pairing_token` | §8.2 產生的 Team Runner Pairing token |
| `github_token` | Runner `git fetch`／`git push` 用的 GitHub token：fine-grained PAT（只勾選要管理的 repo，Repository permissions → Contents: Read and write）或機器帳號。Phase 1 先用 token；由 GitHub App 的 installation token 推分支是 Phase 2 的項目 |
| `agent_credentials` | `KEY=VALUE` 逐行，例如 Claude Code：在任何一台登入過的電腦執行 `claude setup-token`，把印出的 token 寫成 `CLAUDE_CODE_OAUTH_TOKEN=...`；或 `ANTHROPIC_API_KEY=...`。Codex 用 API key 時 `OPENAI_API_KEY=...` |
| `codex_auth_json` | Codex 以 ChatGPT 帳號登入時，`codex login` 產生的 `~/.codex/auth.json` 內容 |

Antigravity 需要瀏覽器登入、Grok Build 需要自行安裝 CLI，Phase 1 的 Team Runner image 不支援這兩個 Agent。

**安全注意**：容器內的 Agent 和 Runner 是同一個使用者，Agent 執行指令時讀得到這些 Credential（環境變數與 tmpfs 中的 git credential），和在開發者電腦上跑 Local Runner 的情況相同。所以 `github_token` 只給必要的 repo 與 Contents 權限並設定到期日，Agent 的 Credential 用可以隨時撤銷的 token，Team Runner 的 Permission Policy 不要用 `yolo`。由 Runner 以短效的 installation token 代為 push 是 Phase 2 的項目。

### 8.2 Pairing

1. 以 Admin 以上登入 Web UI → 「管理」→ Runner → **產生 Team Runner 的 Pairing token**（24 小時內有效，只顯示一次）。
2. 把 token 寫進 `deploy/secrets/pairing_token`（整個檔案只有 token，沒有換行也可以）。
3. 依需要編輯 `deploy/team-runner/runner.toml`（Repo 對應、Agent 的並行數；預設不用改）。
4. 啟動：

   ```sh
   cd deploy
   docker compose --profile team-runner up -d --build
   docker compose logs -f team-runner
   ```

   Runner 完成 Pairing 後把 Runner token 存在 volume `runner-home` 中，之後重新啟動都用它，`pairing_token` 可以清空。UI 的 Runner 清單會出現這台 Runner 與它能跑的 Agent；派工時選「Team Runner」就會進入 Team 佇列。
5. Runner 第一次收到派工時會以 npm 安裝 Claude Code／Codex 的 ACP adapter 到狀態目錄（需要連到 npm registry），所以第一個 Run 的啟動會慢一些。

Server 在別台機器時，把 `ORBIS_TEAM_RUNNER_SERVER_URL` 設成 Server 的公開網址。之後 `docker compose --profile team-runner ...` 的指令都要帶 profile，否則 compose 會忽略這個 service。

### 8.3 撤銷與重新 Pairing

Admin 在 UI 撤銷 Runner 後，容器中的 Runner 會以「需要重新 Pairing」結束並由 compose 重新啟動，但沒有新的 Pairing token 就會一直失敗。重新 Pairing：產生新的 token 寫進 `pairing_token`，刪掉舊的 Runner token（`docker compose --profile team-runner run --rm --entrypoint sh team-runner -c 'rm -f ~/.orbis/runner/credentials.json'`；或直接刪除 volume `runner-home`，Worktree 會一起消失），再 `up -d --force-recreate team-runner`。

## 9. 備份與還原

要備份的資料：Postgres（所有 Task、Run、Event、設定）、blob volume（大型 Event 內容、截圖、review diff 的大檔案，預設保存 90 天）、`deploy/.env` 與 `deploy/secrets/`。Team Runner 的 `runner-home` volume 只有 Runner token 與 Worktree，不備份也可以（重新 Pairing 即可）。volume 的實際名稱是 `<ORBIS_DEPLOY_PROJECT>_<volume>`，預設 `orbis_pgdata`、`orbis_blobs`、`orbis_runner-home`。

### 9.1 備份

```sh
cd deploy
# Postgres：自訂格式的 dump（可以用 pg_restore 選擇性還原）
docker compose exec -T postgres pg_dump -U orbis -Fc orbis > orbis-$(date +%F).dump
# blob
docker run --rm -v orbis_blobs:/data:ro -v "$PWD":/backup alpine tar czf /backup/orbis-blobs-$(date +%F).tgz -C /data .
```

Windows 的 PowerShell 把 `$(date +%F)` 換成 `$(Get-Date -Format yyyy-MM-dd)`、`"$PWD"` 換成 `${PWD}`。Server 不用停就可以備份（`pg_dump` 讀的是一致的快照）。建議用排程每天跑一次，並把 dump 與 `.env`、`secrets/` 一起存到別的機器。

### 9.2 還原

到一台裝好 Docker 的機器：

```sh
git clone ... && cd orbis/deploy
# 放回 .env 與 secrets/
docker compose up -d postgres                      # 只先啟動 Postgres
docker compose exec -T postgres pg_restore -U orbis -d orbis --clean --if-exists --no-owner < orbis-2026-10-25.dump
docker run --rm -v orbis_blobs:/data -v "$PWD":/backup alpine sh -c 'cd /data && tar xzf /backup/orbis-blobs-2026-10-25.tgz'
docker compose up -d --build                       # 啟動 Server（會套用缺少的 migration）
```

還原到**同一版或更新版**的 Orbis；還原到比備份時更舊的版本不支援（migration 不可逆）。還原後 Local Runner 與 Team Runner 的 Runner token 仍在資料庫中，不需要重新 Pairing；備份之後才開始的 Run 在備份中不存在，Runner 重新連上時會中止它們，相關的 Task 重新派工即可。

## 10. 升級

Server、Team Runner、Desktop 用同一個版本（tag）。協定帶版本號（ARCHITECTURE §6.1）：Runner 與 Server 不相容時 Runner 以「協定版本不相容」結束（sidecar 結束碼 76），Desktop 提示「Runner 版本與 Server 不相容，請更新」；Web UI 也會提示要更新哪個元件，不會靜默失敗。

1. 先備份（§9.1）。
2. 升級 Server：

   ```sh
   cd orbis
   git fetch --tags && git checkout <新版 tag>
   cd deploy
   docker compose --profile team-runner build        # 沒有 Team Runner 時省略 --profile
   docker compose --profile team-runner up -d
   docker compose logs -f server                      # migration 在啟動時自動執行
   ```

   migration 由 Server 啟動時執行（Drizzle，`apps/server/src/db/migrations/`），只會往前套用；Server 只跑一個實例，所以不會有兩個程序同時 migrate。失敗時 Server 不會啟動，log 會列出錯誤；修好後 `up -d` 重試，或用 §9.2 還原再回到舊版 image。
3. Team Runner 隨同一次 `up -d` 更新（image 由同一個 commit 建）。
4. Desktop：Windows 從 GitHub Releases 自動更新；macOS 偵測到新版時提示並開下載頁，見 [DESKTOP.md](DESKTOP.md)。Server 升級後舊版 Desktop 的 Local Runner 若不相容會停止領取並提示更新。
5. 升級後確認 `docker compose ps` 都是 `healthy`，UI 的 Runner 清單中 Team Runner 在線上。

## 11. 本機開發的 webhook 轉送（Issue #60）

正式部署有公開網址，GitHub 直接把 webhook 送到 `<ORBIS_PUBLIC_URL>/api/webhooks/github`，**不需要任何轉送**。只有本機開發（`pnpm dev`，Server 在 `localhost:4000`）或區域網路部署（§6.4）才需要把 webhook 轉進來。

### 11.1 `gh webhook forward`

```sh
gh extension install cli/gh-webhook     # 第一次
gh webhook forward --repo <owner>/<repo> \
  --events issues,issue_comment,pull_request,pull_request_review,pull_request_review_comment,check_suite,check_run \
  --url http://localhost:4000/api/webhooks/github \
  --secret <ORBIS_GITHUB_WEBHOOK_SECRET>
```

它會在 repo 上建立一個暫時的 webhook，把事件轉到本機。注意事項（Windows 實機，#60）：

- **會斷線**：連線大約每小時中斷一兩次並結束，**斷線期間的事件會遺失**。用迴圈或工作排程器自動重跑，漏掉的事件到 repo 的 Settings → Webhooks → 該 hook 的 Recent Deliveries 按 **Redeliver**；Repo 設定頁的「重新檢查安裝狀態」可以補 App 安裝狀態。
- **強制結束不會刪掉 hook**：Ctrl+C 以外的方式（關掉視窗、`taskkill`）結束時，GitHub 上的 webhook 會留著，下次啟動會因為重複而失敗（422）。到 repo 的 Settings → Webhooks 刪掉舊的，或 `gh api -X DELETE repos/<owner>/<repo>/hooks/<id>`（`gh api repos/<owner>/<repo>/hooks` 可以列出）。
- 它只轉送**repo 層級**的事件，`installation`／`installation_repositories` 這類 App 層級的事件不會轉送；安裝狀態靠「重新檢查安裝狀態」補。
- secret 要和 `ORBIS_GITHUB_WEBHOOK_SECRET` 相同，Server 才驗得過簽章。

### 11.2 smee.io

替代方案：建立 GitHub App 時把 Webhook URL 設成 smee channel（`pnpm --filter @orbis/github app:create --webhook-url https://smee.io/xxxx`），本機跑 `npx smee-client -u https://smee.io/xxxx -t http://localhost:4000/api/webhooks/github`。App 層級的事件也會轉送；smee 是公開的第三方服務，payload 會經過它，只適合開發。

## 12. 疑難排解

| 現象 | 原因與處理 |
|---|---|
| Server 啟動就結束，log 列出「Server 設定有誤」 | `.env` 缺少或格式錯誤，依列出的變數修正 |
| 「未設定 GitHub App」的警告 | `ORBIS_GITHUB_APP_*` 四個都沒填，GitHub 整合停用。要用就四個都填 |
| 登入後回到首頁但沒有 Team | 不是 bootstrap owner，而且還沒被邀請。確認 `ORBIS_BOOTSTRAP_OWNER` 是數字 user id，且資料庫中還沒有 Team |
| OAuth 回 `redirect_uri_mismatch` | OAuth App 的 callback URL 和 `ORBIS_PUBLIC_URL` 不一致 |
| Desktop 連不上 | `ORBIS_PUBLIC_URL` 從客戶端是否連得到（區域網路要用主機 IP 與 `ORBIS_DEPLOY_BIND=0.0.0.0`）；反向代理有沒有轉送 WebSocket |
| Team Runner 一直重啟，log 顯示 `hello_rejected` | Pairing token 過期或已用過：重新產生寫進 `secrets/pairing_token`；或 Runner 已被撤銷（§8.3） |
| Team Runner 的 Run 在 push 時失敗 | `secrets/github_token` 沒有該 repo 的 Contents 寫入權限，或 token 過期 |
| Team Runner 的 Claude Code 回報未登入 | `agent_credentials` 中的 `CLAUDE_CODE_OAUTH_TOKEN` 無效或過期，重新 `claude setup-token`；改檔後 `up -d --force-recreate team-runner` |
| Issue 沒有同步、PR merge 後 Task 沒轉 Done | webhook 送不進來：公開網址是否正確、反向代理有沒有擋 POST；本機開發見 §11。GitHub App 的 Advanced 頁可以看每次 delivery 的回應 |
| 資料庫重啟後 Server 沒有 crash 但短暫出錯 | 正常：連線 pool 會記一筆 warn 並重新連線 |
