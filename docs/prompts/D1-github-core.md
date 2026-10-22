# D1 GitHub Core（W2–4）

你是 Track D，在自己的 Orca Worktree 中開發 `packages/github`。目標是：用 GitHub App 讓 Task 與 GitHub Issues 雙向同步、Review Gate 核准後自動開 PR、PR merge 後 Task 自動轉成 Done。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §5、§11、§15
- `docs/adr/0004`

## 範圍

你擁有 `packages/github`。它以模組的形式由 Server 掛載（掛載點由 B 軌提供），並透過 B 軌提供的 domain service 介面讀寫 Task。這些介面還沒完成時，先定義你需要的 interface，用 fake 實作測試，再在 PR 說明中列出需求。

## 交付項目

1. **GitHub App**：
   - 撰寫 App manifest 與安裝說明（`packages/github/README.md`），包含需要的權限與要訂閱的 webhook 事件。
   - 驗證 webhook 簽章、讓 webhook 處理可以安全地重複執行（以 delivery ID 去除重複）。
   - installation token 的取得與快取。
2. **Repo 登記**：Project 新增 Repo 時，檢查 App 有沒有安裝在該 Repo，並讀取 default branch。
3. **Issues 雙向同步**：
   - 同步 §11 的欄位，衝突時以最後寫入者為準，並避免同步的回音（自己寫出去的變更又被 webhook 同步回來）。
   - 提供「從 Issue 匯入成 Task」的功能。
   - 在 Issue 上維護一則 Orbis 狀態摘要留言（只更新那一則，不重複留言）。
4. **開 PR**：Review Gate 核准後，等 Runner push 完成，再以 App 身分開 PR。PR 標題用 Task Key 加上 title，body 包含 Spec 摘要、Acceptance Criterion 的結果，以及 Task 的連結。
5. **merge 後轉 Done**：收到 `pull_request.closed` 而且 merged 時，把 Task 轉成 Done；沒有 merge 就關閉時，把 Task 退回 Review Gate，並通知負責人。

## 完成條件

- 每一種 webhook 都有測試，使用錄製下來的真實 payload（fixture）與 fake domain service。
- 同步回音和重複 delivery 都有測試證明不會造成重複寫入。
- 在一個測試用的 GitHub repo 上手動驗證：Issue 雙向同步、開 PR、merge 後轉 Done 都可以運作，並在 PR 說明中附上截圖。
- 三平台 CI 全部通過。

## 結束時

開 PR `track-d: github core`，說明中列出需要 B 軌提供的 domain service 介面。
