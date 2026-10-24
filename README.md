# Orbis

給 2–10 人小團隊用的專案管理加 Agent Workspace。在 Orbis 中把 Task（Spec 加上 Acceptance Criterion）派給 Claude Code、Codex、Antigravity 或 Grok Build，Agent 在隔離的 git worktree 中執行。之後經過自動驗收、人工 review、開 PR，merge 後 Task 自動完成。Windows 是一等公民。

> 目前狀態：Phase 1 開發中（M0：monorepo 與共用契約）。

## 文件

| 文件 | 內容 |
|---|---|
| [GLOSSARY.md](GLOSSARY.md) | 名詞定義 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 完整設計（唯一依據） |
| [docs/adr/](docs/adr/) | 重大決策與理由 |
| [docs/PLAN.md](docs/PLAN.md) | Phase 1 分軌時程與里程碑 |
| [docs/prompts/](docs/prompts/) | 各階段給 Claude Code 的開發 prompt |
| [CLAUDE.md](CLAUDE.md) | 給 Agent 的開發規範 |

## 本機開發

### 需要的工具

- Rust（版本由 `rust-toolchain.toml` 固定，`rustup` 會自動安裝）
- Node.js 24 與 pnpm（版本由 `package.json` 的 `packageManager` 固定，用 `corepack enable pnpm` 啟用）
- Docker（本機的 Postgres，以及 Server 的 Testcontainers 測試）

### 第一次設定

1. `pnpm install`
2. 複製 `.env.example` 為 `.env`，填入 GitHub OAuth App 的 client id／secret，以及自己的 GitHub 數字 user id（`ORBIS_BOOTSTRAP_OWNER`，用 `gh api user --jq .id` 查詢）。
   - OAuth App 的 callback URL 設為 `http://localhost:5173/api/auth/github/callback`。
   - `.env` 只放在本機，不會被 commit。

### 啟動

```sh
docker compose up -d   # 只有 Postgres
pnpm dev               # Server（:4000）與 Web（:5173）
pnpm dev:runner        # 另開一個終端機：Runner 連上 Server，Server 的 log 會出現 Heartbeat
```

打開 <http://localhost:5173> 用 GitHub 登入。

### 檢查

| 指令 | 內容 |
|---|---|
| `pnpm lint` | Biome、rustfmt、clippy、名稱常數檢查、ARCHITECTURE §3 路徑檢查 |
| `pnpm typecheck` | 所有 TS 子專案 |
| `pnpm test` | `cargo test`、所有 TS 子專案的測試、腳本測試 |
| `pnpm gen:protocol` | 從 `crates/orbis-protocol` 重新產生 `packages/protocol` |
| `pnpm --filter @orbis/web test:e2e` | Web 的 Playwright 測試 |
