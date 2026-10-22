# B2 Server Advanced（W5–7）

你是 Track B 第二階段。目標是在 B1 的 Server 上加入：完整的 Gate 與 Verification 流程、Child Run 與 Draft Task、通知系統與 @mention、Yjs 同步服務、並行與佇列控管、Role 的細部規則。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §5（全部）、§7（並行與額度的部分）、§9、§12（全部）
- `docs/adr/0005`、`0009`

## 範圍

範圍與 B1 相同：`apps/server`（`src/preview/` 除外）。

## 交付項目

1. **Planning 與 Plan Gate**：Plan Gate 可以依 Project 或 Task 關閉；核准或退回 plan 的 API。
2. **Verifying**：依 Acceptance Criterion 的類型向 Runner 要求驗證並彙整結果；失敗時自動送回 Agent 重試（預設最多 3 次），超過就加入 Needs You。結果與證據（含截圖 blob）要保存。
3. **Child Run**：建立、樹狀查詢、深度與數量限制（以 Server 為準）；Child Run 的 Dispatch 優先派給父 Run 所在的 Runner。
4. **Draft Task**：`propose_tasks` 建立的 Draft Task 要經人確認後才進入 Backlog；`update_task_note` 的紀錄要保存並顯示來源 Run。Agent 不能修改 Task 的狀態、指派對象與 Acceptance Criterion，這點要用測試證明。
5. **通知系統**：
   - §12.3 的事件類型。
   - 每個人可以依事件類型開關通知，也可以設定勿擾時段。
   - 發送層用 Channel 介面設計，Phase 1 實作「App 內」與「桌面推送」兩種 Channel。
   - 推送到 Web 與 Electron。
6. **@mention**：解析 Task 留言、Spec、diff 行內留言中的 @member 與 @agent；@agent 會在該 Task 上建立一個 `consult` Run，並把留言的上下文帶進 prompt。
7. **Yjs 同步服務**：用 y-websocket 協定提供 Task 描述、Acceptance Criterion、資料庫中的 Spec 的共同編輯；文件快照存進 Postgres；存取權限沿用 Role。Repo Spec 的草稿也用同一套機制，「提交到 repo」由 D 軌實作。
8. **並行與佇列**：依各 Credential 的並行上限（預設 30）排隊；回報 rate limit 的狀態、用量與排隊數；提供 Team Runner 的佇列狀態給 UI 使用。
9. **Role 的細部規則**：Project 可以設定「不能核准自己的 Task」、可以禁止 Member 派工到 Team Runner、可以覆寫個別 Member 的 Role。

## 完成條件

- 每個交付項目都有 Testcontainers 測試；通知的「勿擾時段」與「依事件類型關閉」都有測試。
- 有一個整合測試用模擬 Runner 走完整的生命週期：Planning → Plan Gate → Running → Verifying 失敗 → 重試 → 通過 → Review Gate → PR Open。
- 兩個 Yjs 客戶端同時編輯同一份文件後內容一致，重新啟動 Server 後內容仍在。
- 三平台 CI 全部通過。

## 結束時

開 PR `track-b: server advanced`。
