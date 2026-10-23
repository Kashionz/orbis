# 手動驗證截圖

在測試 repo `Kashionz/orbis-sandbox`（private）上，以 `dev:harness`（真實的 GitHub App＋in-memory 的 Task）加上 smee 轉發 webhook 走過一輪。步驟與結果列在 PR #9 的說明中。

| 截圖 | 內容 |
|---|---|
| [01-issue-1-synced.jpg](01-issue-1-synced.jpg) | Task ORB-1 建立的 Issue #1：body 來自 Task 描述、負責人與 labels 已同步、App 維護的狀態摘要留言（含 Acceptance Criterion 結果） |
| [02-issue-1-timeline.jpg](02-issue-1-timeline.jpg) | Issue #1 的時間軸：在 GitHub 上加 label、改標題、關閉再重開（都同步回 Task）、PR #3 關聯、merge PR #3 時以 `Closes #1` 關閉 |
| [03-pr-3-body.jpg](03-pr-3-body.jpg) | App 開出的 PR #3：標題 `<Task Key> <title>`，內文有 Task 連結、Spec 摘要、Acceptance Criterion 結果表、`Closes #1` |
| [04-pr-3-merged.jpg](04-pr-3-merged.jpg) | PR #3 的時間軸：沒有 merge 就關閉（Task 退回 Review Gate）、重開（回到 PR Open）、merge（Task 轉 Done） |
| [05-issue-5-not-planned.jpg](05-issue-5-not-planned.jpg) | 在 GitHub 上以「not planned」關閉 Issue #5 → Task 轉 Done、關閉原因 `not_planned`；之後 Task 回到 Backlog，App 重新打開 Issue |

截圖是驗證結束後拍的，和驗證當下的畫面有三處不同：

- **Issue #1 最後是 Open、摘要是 Backlog**：merge 之後，驗證者重新啟動 harness 時新程序沒有起來，「把 task-1 改回 Backlog」的請求被舊的 harness 接走，而舊 harness 的 task-1 正是 ORB-1，所以 Issue #1 又被重新打開（時間軸最後一筆）。merge 當下 Issue #1 是以 completed 關閉、摘要是 Done。
- **Issue #1 時間軸第一筆標題是亂碼**：第一次建立 Task 時，從 Git Bash 用 curl 送出的中文被轉成系統編碼。之後改用 UTF-8 檔案送出，App 把標題改正。這是驗證工具的輸入問題，不是同步的問題。
- **Issue #5 的摘要顯示「Backlog（不處理）」**：這是驗證時發現的 bug。摘要留言只看關閉原因，沒有檢查 Task 是否為 Done；harness 的 fake 不會在離開 Done 時清空關閉原因，所以露出來。已修正為只在 Done 時顯示，並加上測試。
