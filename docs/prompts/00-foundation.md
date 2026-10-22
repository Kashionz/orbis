# 00 Foundation：Monorepo 與共用契約（W1）

你負責建立 Orbis 的 monorepo，以及所有軌道共用的**契約**。之後會有 5 條軌（A–E）在各自的 Worktree 中，依照這些契約平行開發。所以這一步的重點是**契約要完整、穩定、有測試**，功能只需要做到骨架。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §2、§3、§4、§6.1、§7、§8、§14、§17
- `docs/PLAN.md`：分軌與目錄所有權
- `docs/adr/0001`、`0002`、`0003`

## 交付項目

1. **Monorepo 骨架**：
   - pnpm workspaces：`apps/server`、`apps/web`、`apps/desktop`、`packages/protocol`、`packages/api-contract`、`packages/github`
   - cargo workspace：`crates/orbis-protocol`、`crates/runner`、`crates/fake-agent`
   - 根目錄的 lint、format、typecheck、test 指令都能一次跑完所有子專案。
2. **名稱常數**：
   - Rust 放在 `orbis-protocol::names`，TS 放在 `packages/api-contract/src/names.ts`。
   - 內容包含產品名稱 `Orbis`、設定目錄 `.orbis`、環境變數前綴 `ORBIS_`、Worktree 根目錄。
   - 寫一個測試比對兩邊是否一致，例如比對 `runner --print-names` 的 JSON 輸出。
3. **`crates/orbis-protocol`**（Runner↔Server 協定，帶 `PROTOCOL_VERSION`）：
   - **連線**：Hello（含 Pairing）、Heartbeat。
   - **派工**：DispatchOffer、Accept、Reject（帶 Dispatch ID）。
   - **控制**：RunControl，包含取消、送 prompt、回覆權限請求、Gate 的結果。
   - **能力回報**：AgentAvailability，包含 Agent 清單與各 Credential 的並行上限。
   - **Event 外層**：run_id、seq、ts、kind。
   - **正規化的 Event kind**：訊息片段、思考、tool call（含 diff）、權限請求、plan、用量、狀態變更、錯誤、rate limit、preview 就緒。

   型別用 `ts-rs` 產生到 `packages/protocol`。CI 中產生的結果與 commit 的版本不一致時，CI 要失敗。
4. **資料庫 schema**（`apps/server/src/db/schema/`，用 Drizzle）：涵蓋 §4 的完整領域模型（含 Child Run、Draft Task、Event、Dispatch），並建立 migration。
5. **`packages/api-contract`**：Server↔Web 主要資源的 zod schema 骨架，包含 Project、Repo、Task、AcceptanceCriterion、Run、Event、Needs You 項目。
6. **`crates/fake-agent`**：
   - 一個以 stdio 實作 ACP v1 的 agent，依 YAML 劇本行動。
   - 至少附上以下劇本：正常完成並產出 diff、權限請求、plan、錯誤、rate limit 後恢復、呼叫注入的 MCP 工具。
7. **骨架**：
   - **Server**：Hono 加 GitHub OAuth 登入，提供 Runner 用的 WebSocket 端點（Pairing token 先用 stub）；用 Testcontainers 的 Postgres 跑測試。
   - **Web**：Vite 加 React，有登入頁和空的看板路由。
   - **Runner**：連上 Server、送出 Hello、持續送 Heartbeat，並提供 `--print-names`。
8. **CI**：GitHub Actions 在 `windows-latest`、`macos-latest`、`ubuntu-latest` 三平台都跑 cargo test、pnpm test、lint、typecheck，以及 ts-rs 一致性檢查。

## 完成條件（M0）

- 三平台 CI 全部通過。
- 有一個整合測試能用 Fake Agent 跑完一份劇本：測試以 ACP client 身分驅動 Fake Agent，並驗證收到的 Event 序列正確。
- 本機執行 `docker compose up`（只含 Postgres）加上 `pnpm dev` 後，可以完成 GitHub 登入；Runner 連上 Server 後，可以在 Server 的 log 中看到 Heartbeat。
- `docs/ARCHITECTURE.md` §3 的路徑與實際目錄一致。

## 結束時

開 PR `foundation: monorepo and contracts`，說明中列出契約中**刻意保留彈性**的地方，例如還不確定的欄位，讓各軌知道哪裡可能還會變。
