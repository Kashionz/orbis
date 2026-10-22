# Orbis Phase 1 開發計畫

設計內容見 [ARCHITECTURE.md](ARCHITECTURE.md)。每個階段都有對應的開發 prompt，放在 [prompts/](prompts/)。

## 開發方式

- 一個人搭配 Claude Code，用 **Orca 的多 Worktree 方式平行開發**：每條軌在自己的 Worktree 和分支上開發，再各自開 PR 合併回 `main`。
- **第 1 週照順序做**，先完成所有軌道共用的契約。**第 2 週起分軌平行**。
- 同時最多 4–5 條軌在跑。真正的瓶頸是人 review 的速度：review 跟不上時，就先暫停 C 軌或 E 軌其中一條，review 標準不放寬。

## 分軌與目錄所有權

每條軌**只修改自己擁有的目錄**。要動到契約時，依下方「契約變更流程」處理。

| 軌 | 負責內容 | 擁有的目錄 |
|---|---|---|
| **A Runner** | Worktree 管理、ACP、Permission Policy、Delegation、Orbis MCP server、Playwright MCP 的注入 | `crates/runner`（`src/preview/` 除外）、`crates/fake-agent` |
| **B Server 與 PM** | API、Task 狀態機、Role、Dispatch 佇列、通知、Yjs 同步 | `apps/server`（`src/preview/` 除外） |
| **C Web UI** | 看板、Task 頁、Run 即時檢視、diff review、共同編輯、Needs You 清單、通知中心 | `apps/web` |
| **D GitHub** | GitHub App、Issues 雙向同步、PR 建立、Feedback Loop | `packages/github` |
| **E Desktop 與 Preview** | Electron 殼、Runner sidecar、內嵌瀏覽器、Preview 轉送、在 Preview 上留言 | `apps/desktop`、`crates/runner/src/preview/`、`apps/server/src/preview/`、`apps/web/src/features/preview/`（PR 需要 C 軌 review） |

**契約**由第 1 週建立，之後任何一條軌都不可以在自己的 PR 中順手修改：

- `crates/orbis-protocol`：Runner↔Server 的協定與 Event 模型
- `packages/protocol`：由 `ts-rs` 產生
- `apps/server/src/db/schema/`：資料庫 schema
- `packages/api-contract`：Server↔Web 的 zod schema
- 根目錄的設定：`Cargo.toml`、`pnpm-workspace.yaml`、CI 設定

### 契約變更流程

1. 開一個只包含契約變更的小 PR，分支名稱用 `contract/<主題>`，PR 說明寫清楚受影響的軌。
2. 契約 PR 合併後，各軌再 rebase 到最新的 `main`。
3. 如果契約 PR 需要等待，可以先在自己軌的程式碼中用暫時的型別頂著，並加上 `// TODO(contract): <PR 連結>`。

## 時程

| 週 | 依序進行 | A | B | C | D | E |
|---|---|---|---|---|---|---|
| W1 | [00-foundation](prompts/00-foundation.md) | | | | | |
| W2–4 | | [A1](prompts/A1-runner-core.md) | [B1](prompts/B1-server-core.md) | [C1](prompts/C1-web-core.md) | [D1](prompts/D1-github-core.md) | [E1](prompts/E1-desktop-core.md) |
| W4 末 | [90-integration-dogfood](prompts/90-integration-dogfood.md) 🎯 開始用 Orbis 開發 Orbis | | | | | |
| W5–7 | | [A2](prompts/A2-runner-advanced.md) | [B2](prompts/B2-server-advanced.md) | [C2](prompts/C2-web-advanced.md) | [D2](prompts/D2-github-feedback.md) | [E2](prompts/E2-preview.md) |
| W8–9 | [91-integration-release](prompts/91-integration-release.md) | | | | | |
| W10 | 緩衝 | | | | | |

**風險最高的是 A2 的 Delegation。** 進度落後時，`branch` 模式第一個延到 Phase 2，`consult` 模式保留。

## 里程碑

| 里程碑 | 完成條件 |
|---|---|
| **M0 契約完成**（W1 末） | 三平台 CI 全部通過；Fake Agent 可以跑完一份劇本；Server 啟動後可以完成 GitHub 登入；`packages/protocol` 由產生步驟自動產出 |
| **M1 Dogfood**（W4 末） | 在 Orbis 上建立 Task → 派給 Local Runner 上的 Claude Code → 在 UI 上即時看到 Run 的 Event → 處理權限請求 → 在 diff 上留言退回 → 核准 → 自動開 PR → merge 後 Task 自動轉 Done。這條路徑在 Windows 上全程可以走通，之後 Orbis 自己的開發都改用 Orbis |
| **M2 功能完整**（W7 末） | ARCHITECTURE §5–§13 都已實作，而且 Playwright 端到端測試涵蓋每個 Gate 與 Feedback Loop |
| **M3 Phase 1 發布**（W9 末） | Docker Compose 一鍵部署；Electron 安裝檔可以自動更新；四個 Agent 的真實煙霧測試都通過 |
