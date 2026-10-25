# Task 層級的分享：Task 角色可以調高、一般存取可以限制，Owner 與 Admin 永遠有完整權限

原本的權限只有 Team 的 Role 與 Project 的 Role 覆寫，沒有辦法讓外包或 PM 只參與某一個 Task，也沒有辦法把某個 Task 限制給少數人。我們在 Task 上加一層分享：Task 成員有角色（擁有者、可操作、可檢視），Task 另有一般存取（`invited` 僅受邀成員、`team_view` Team 可檢視、`team_edit` Team 可操作，預設 `team_edit`，和沒有這一層時的行為相同）。

有效權限的計算是：Owner 與 Admin 一律完整；其他人取「Task 角色」與「一般存取限制後的 Team／Project Role」中較高的一個。所以 Task 角色可以把 Team Viewer 在這個 Task 上調高到能編輯、派工、核准關卡、傳訊息；一般存取則可以把沒有被分享的人降到只能看或看不到。權限策略、設定信任、Team Runner、Project 設定這些 Admin 層級的能力不受 Task 角色影響。擁有者是建立 Task 的人，可以轉移；管理分享的是擁有者與 Admin 以上。

還不是 Member 的人以 email 邀請：邀請產生一條連結（有設定 SMTP 時也寄信），對方用 GitHub 登入、已驗證的 email 等於受邀的 email 時，以 Viewer 身分加入 Team，再取得邀請時選的 Task 角色。邀請 7 天後過期，可以撤銷；email 已經是某位 Member 的已驗證 email 時直接加進 Task，不產生邀請。

## Considered Options

- **只做限制，不做調高**：Viewer 要參與某個 Task 就得把整個 Team 的 Role 升成 Member，等於能動所有 Task，所以不採用。
- **Task 角色完全取代 Team Role**：限制成「僅受邀成員」時連 Owner、Admin 都可能被鎖在 Task 外面，沒有人能救回來，所以 Owner 與 Admin 永遠不受影響。
- **拿到邀請連結就能接受**：連結被轉寄就會讓別人加入 Team，所以接受時比對已驗證的 email（同預覽邀請，ADR-0015）。

## Consequences

- `authorize()` 要多一層 Task：需要 Task 的能力（`edit_task`、派工、核准關卡、`view`）時一併傳入 Task；看板、待我處理、搜尋等列表要濾掉看不到的 Task。
- GitHub OAuth 要請求 `user:email`，並在每次登入時寫入 Member 的已驗證 email；成員清單會顯示 email（小團隊內彼此可見）。
- 既有的 Task 在 migration 時以建立者為擁有者；建立者已被移除的 Task 沒有擁有者，由 Admin 管理分享。
- 一般存取是「僅受邀成員」的 Task 不寫到 GitHub Issue（Issue 在 repo 上看得到，會洩漏 Task 內容）：不自動建立 Issue；已有 Issue 的 Task 之後改成僅受邀成員時保留原 Issue，但不再更新它與狀態摘要留言；改回 Team 可檢視／可操作後恢復同步，補寫期間的變更，沒有 Issue 的那時建立。GitHub→Orbis 的回寫與 Issue 匯入不受影響。（2026-10-26 使用者決定）
