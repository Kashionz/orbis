# B1 Server Core（W2–4）

你是 Track B，在自己的 Orca Worktree 中開發 Orbis Server（Hono、Drizzle、Postgres）。目標是提供 M1 Dogfood 需要的 API：PM 資料、Task 狀態機、Dispatch 佇列、Event 儲存與推送、Role 授權。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §4、§5（Planning、Verifying 在這個階段只需要預留狀態）、§6.1、§10、§12.2、§14、§15
- `docs/adr/0001`、`0004`、`0007`

## 範圍

你擁有 `apps/server`（`src/preview/` 除外）。DB schema 與 `packages/api-contract` 是契約，要依照契約變更流程修改。D 軌會提供 `packages/github`，請在 Server 中預留掛載 GitHub 路由與 webhook 的位置，並提供 D 軌需要的 domain service 介面，例如「Task 狀態變更」與「PR 已 merge」。

## 交付項目

1. **PM API**：Team、Member、Project、Repo、Task、Acceptance Criterion 的 CRUD，以及 Task Key 的產生、Task 之間的 `depends_on`。
2. **Task 狀態機**：Backlog → Ready → Running → Review Gate → PR Open → Done。Planning 與 Verifying 先保留為「直接通過」的掛鉤。不合法的狀態轉換一律拒絕，並有完整的測試。
3. **Runner 登錄與 Dispatch 佇列**：
   - Pairing token：Local Runner 綁定 Member，Team Runner 綁定 Team。
   - 依 §6.1 的派工規則派工。
   - 處理 Dispatch ID 與 Heartbeat 逾時。
   - 記錄每台 Runner 回報的 AgentAvailability。
4. **Event 儲存**：`run_events` 依 seq 去除重複、blob 參照、保存 90 天的清理工作；即時透過 WebSocket 推送給訂閱該 Run 的 Web 客戶端，並支援從任一個 seq 開始重播。
5. **Needs You**：權限請求與等待中的 Gate 會產生 Needs You 項目。Member 回覆後轉成 RunControl 送給 Runner。
6. **Review Gate API**：核准（觸發 push 加開 PR 的流程，開 PR 由 D 軌實作）、退回（附上行內留言，轉成送給 Agent 的 prompt）、中止。
7. **Role 授權**：§12.2 的四種 Role 與 Project 覆寫，以 middleware 在 Server 端檢查每一個 API。

## 完成條件

- 所有 API 都有使用 Testcontainers Postgres 的測試；Role 授權矩陣中的**每一格**都有測試。
- 有一個整合測試用「模擬 Runner」（直接使用協定型別）走完：建立 Task → Dispatch → 收到 Event → 權限請求 → 回覆 → Review Gate 退回 → 核准 → 進入 PR Open。
- `packages/api-contract` 的 schema 與實際的 API 回應一致（用測試驗證）。
- 三平台 CI 全部通過。

## 結束時

開 PR `track-b: server core`，說明中列出提供給 C 軌、D 軌的介面與端點。
