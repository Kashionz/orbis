# 預覽邀請：Team 打開設定後，可以把 Preview 分享給特定的人，受邀者登入後才發 ticket

Preview 原本只有 Team 裡能查看那個 Run 的人能開（ADR-0010，ticket 換 cookie）。PM、設計師或客戶常常不在 Team 裡，卻需要看一下成果。我們加上預覽邀請：Team 設定「允許對外分享預覽」（預設關閉，由 Admin 打開）後，對這個 Task 有操作權限的人可以邀請特定的人。

受邀者以 GitHub 帳號（邀請時查出 GitHub user id 並保存，登入時以 id 比對）或 email（以 Member 存下的已驗證 email 比對）指定，可以是其他 Team 的人或不屬於任何 Team 的人。每位受邀者各自一條邀請連結（Orbis 主網址的 `/preview-invites/<token>`，有設定 SMTP 時也寄信）：對方用 GitHub 登入，Server 確認在名單上、邀請有效，才發 ticket 並轉到預覽子網域，換票流程和 ADR-0010 相同。不在名單上的人拿到連結也打不開。期限可以選 1 小時、24 小時（預設）、7 天，可以個別撤銷；預覽停止或 Worktree 封存後全部失效。受邀者只能看預覽頁面，不會因此加入 Team，也看不到 Task。

## Considered Options

- **產生公開的分享連結（任何人拿到都能開）**：連結一外流就沒有控制，而且 Preview 跑的是還沒審查的程式碼，所以一律要登入並比對名單。
- **把受邀者加成 Team Viewer**：會看到 Team 所有的 Task 與 Run，超出「看一下成果」的需要。

## Consequences

- Preview 的存取判斷（`preview/access.ts`）除了 Project 的 `view`，也接受有效的邀請；沒有 Team 的登入者也要能換票。
- 預覽分頁要顯示受邀名單、期限與最後一次開啟的時間，所以 Server 記錄每次開啟。
- 寄信由 Server 新的 mailer 模組處理，和 Task 邀請共用；SMTP 沒有設定時不寄，由邀請人複製連結。

## 2026-10-26 修訂

拿掉 Team 設定「允許對外分享預覽」：能操作這個 Task 的人都能邀請（[ADR-0018](0018-minimal-settings.md)）。登入後比對名單、期限與撤銷的規則不變。
