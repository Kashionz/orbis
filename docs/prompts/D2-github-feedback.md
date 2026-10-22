# D2 GitHub Feedback Loop（W5–7）

你是 Track D 第二階段。目標是完成 PR 開出之後的 **Feedback Loop**：review 留言與 CI 失敗自動送回原 Run 修正。另外實作 Repo Spec 的「提交到 repo」。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §5.2、§11、§12.1（Repo Spec 的部分）

## 範圍

範圍與 D1 相同：`packages/github`。

## 交付項目

1. **觸發來源的過濾**：
   - 人類 review 留言：檢查留言者對 repo 有沒有寫入權限。
   - CI 失敗：`check_run` 或 `check_suite` 的結果是失敗。
   - bot 留言：只有 Project 設定的白名單中的 bot 才會觸發。
2. **合併再送**：同一份 review 中的留言合併成一批，在 review 送出時觸發；零散的單則留言則在最後一則之後 2 分鐘觸發。
3. **組成修正 prompt**：
   - review 留言：附上檔案、行號、留言內容與 diff 上下文。
   - CI 失敗：附上失敗的 check 名稱與 log 摘要（擷取失敗的段落，不放完整的 log）。
   - 透過 B 軌的介面送給原 Run（Runner 端的接續執行由 A2 實作）。
4. **次數上限**：每個 PR 自動修正最多 5 次，CI 與 review 分開計數；超過上限時停止，並透過通知系統通知負責人。
5. **紀錄**：每次自動修正都在 Task 上留下紀錄，並在 PR 上留言，註明是哪則留言或哪個 check 觸發，修正後再附上新的 commit。
6. **Repo Spec 提交到 repo**：從 Spec 草稿建立分支、commit 該 markdown 檔、開 PR；PR merge 後更新 Repo Spec 的版本。

## 完成條件

- 每一種觸發與過濾規則都有使用 webhook fixture 的測試，包括：沒有寫入權限的人留言、不在白名單中的 bot 留言、合併再送的時間窗、次數上限、CI 與 review 分開計數。
- 在測試用的 GitHub repo 上手動驗證：留一則 review 留言 → Agent 自動修正並 push → PR 上出現紀錄留言；讓 CI 故意失敗 → Agent 自動修正。
- 三平台 CI 全部通過。

## 結束時

開 PR `track-d: github feedback loop`。
