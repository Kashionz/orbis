# C2 Web Advanced（W5–7）

你是 Track C 第二階段。目標是在 C1 的 UI 上加入：即時共同編輯、Plan Gate、Verification 結果、Child Run 樹、Draft Task 審核、通知中心與 @mention、Credential 用量與團隊管理頁。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §5、§7（並行與額度的部分）、§9、§12（全部）

## 範圍

範圍與 C1 相同：`apps/web`。Preview 相關的 UI 由 E2 負責，你只需要在 Run 頁面預留一個 Preview 分頁的位置。

## 交付項目

1. **即時共同編輯**：
   - Task 描述、Acceptance Criterion、資料庫中的 Spec 都換成 TipTap 加 Yjs，顯示其他人的游標與在線狀態。
   - Repo Spec 的草稿編輯器，以及「提交到 repo」按鈕，按下後顯示產生的 PR 連結。
2. **Plan Gate**：顯示 plan，提供核准、退回並附上意見兩個動作；Project 與 Task 層級都有「關閉 Plan Gate」的設定。
3. **Verification 結果**：逐條顯示 Acceptance Criterion 的結果與證據（指令 log、Agent 的判定理由、截圖與操作紀錄）、重試次數；`manual` 類型的條件在 Review Gate 中打勾。
4. **Child Run 樹**：在 Task 頁面以樹狀結構顯示 Run 與 Child Run，標示 Agent、model、狀態、用量；可以中止任一節點；點擊節點後顯示該 Run 的即時檢視。
5. **Draft Task 審核**：列出 Agent 提出的 Draft Task（含 Acceptance Criterion 與相依關係），可以逐筆或批次確認、修改、捨棄。
6. **通知中心**：通知列表、已讀與未讀、依事件類型的通知設定、勿擾時段設定。
7. **@mention**：在留言、Spec、diff 留言中輸入 `@` 時自動完成成員與 Agent 的名稱；@agent 送出後，顯示產生的 `consult` Run 的連結。
8. **Credential 與佇列**：顯示各 Credential 的並行數、用量、rate limit 狀態與排隊數；Team Runner 的佇列。
9. **管理頁**：成員與 Role、Project 的 Role 覆寫、Team Runner 的 Pairing token、Permission Policy 與 config 信任核准（只有 Admin 以上看得到）；Team Runner 共用訂閱的條款風險警告（ADR-0005）。

## 完成條件

- 每個交付項目都有 Playwright 測試；共同編輯用兩個瀏覽器 context 驗證內容同步。
- 有一個端到端測試走完：Plan Gate → Verification 失敗後重試 → 通過 → `manual` 條件打勾 → 核准。
- 三平台 CI 全部通過。

## 結束時

開 PR `track-c: web advanced`。
