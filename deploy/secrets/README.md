# Team Runner 的 Docker secret

這個目錄的每個檔案是一個 Docker secret（`deploy/docker-compose.yml` 的 `secrets:`），啟動時掛到 Team Runner 容器的 `/run/secrets/<檔名>`，由 `crates/runner/docker-entrypoint.sh` 讀進 Runner 程序的環境變數。**內容不會進 image、volume 或 compose 的 environment**（ADR-0007）。除了這份 README 與 `.gitignore`，目錄中的檔案都不會被 commit。

四個檔案都必須存在（compose 才能啟動），不用的留空：

```sh
cd deploy/secrets
touch pairing_token github_token agent_credentials codex_auth_json
```

| 檔案 | 內容 | 用途 |
|---|---|---|
| `pairing_token` | Admin 在 Web UI 的「管理 → Runner」產生的 Team Runner Pairing token（24 小時內有效） | 第一次連線時完成 Pairing。完成後 Runner token 存在 `runner-home` volume 中，之後這個檔案會被忽略，可以清空 |
| `github_token` | GitHub token：fine-grained PAT（只勾要讓 Runner 推分支的 repo，權限 Contents: Read and write）或機器帳號的 token | Runner `git fetch`／`git push`（以 `https://x-access-token:<token>@github.com` 存進 tmpfs 的 credential store）。Phase 1 的做法，installation token 的交換是 Phase 2 的項目（ARCHITECTURE §11） |
| `agent_credentials` | `KEY=VALUE` 逐行，例如 `CLAUDE_CODE_OAUTH_TOKEN=...`（`claude setup-token` 產生）或 `ANTHROPIC_API_KEY=...`、`OPENAI_API_KEY=...` | Agent 的 Credential，逐行匯出成環境變數，Runner 啟動的 Agent 繼承它們 |
| `codex_auth_json` | `codex login` 產生的 `~/.codex/auth.json` 內容（以 ChatGPT 帳號登入時） | 啟動時複製到容器的 `~/.codex/auth.json`。用 `OPENAI_API_KEY` 時留空 |

注意：

- **容器內的 Agent 讀得到這些 Credential**：Runner 與它啟動的 Agent 是同一個使用者，Agent 執行指令時可以讀到環境變數中的 Agent Credential 與 tmpfs 中的 git credential（和在開發者電腦上跑 Local Runner 一樣）。所以 `github_token` 請用 fine-grained PAT：只勾選要讓 Orbis 管理的 repo、只給 Contents 的讀寫、設定到期日；Agent 的 Credential 也用可以隨時撤銷的 token（`claude setup-token`、API key），不要用個人主帳號的長期憑證。Permission Policy 用 `manual` 或 `auto`，不要對 Team Runner 用 `yolo`。由 Runner 以短效的 installation token 代為 push 是 Phase 2 的項目（ARCHITECTURE §11）。
- `pairing_token` 只能用一次，Pairing 完成後就失效；留在環境變數中沒有額外風險，但建議完成後清空檔案。
- Team Runner 共用一個 Claude 訂閱有條款風險（ADR-0005），UI 的 Runner 設定頁會顯示警告。
- 換 Credential：改檔案後 `docker compose --profile team-runner up -d --force-recreate team-runner`（secret 在容器啟動時讀取）。
- Antigravity 需要瀏覽器登入（`orbis-runner login antigravity`），在容器中沒有瀏覽器，Phase 1 的 Team Runner 不支援；Grok Build 要自行安裝 CLI，也不在這個 image 中。
