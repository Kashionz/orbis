# 互動式終端機經由 Runner 通道開在 Worktree 中，不經過 Permission Policy，Team Runner 預設關閉

人在審查或接手時常常要在 Worktree 裡下幾個指令，原本只能用 Desktop 的「在終端機開啟」，而且只限同一台電腦。我們讓 Runner 在 Worktree 中開 PTY（`portable-pty`，Windows 用 ConPTY），輸入輸出經由既有的 Runner 連線（frame `terminal_*`，資料以 base64 傳送）到 Server，再經由一條專用的 WebSocket 到 Web 的終端機分頁（xterm.js）。

終端機是人自己下指令，所以不經過 Permission Policy；Server 只記錄誰在什麼時候開、關，不記錄按鍵與輸出。能開的人和能回覆權限請求的人一致：Local Runner 只限那台 Runner 的擁有者；Team Runner 只限 Admin 以上，而且 Team 設定預設關閉，因為那等於在共用機器上拿到 shell。Worktree 存在期間都能用（Run 結束後也可以）；閒置 30 分鐘自動關閉；每個 Run 最多同時 3 個。WebSocket 關閉就關閉終端機，不支援重新接上。shell 在 Windows 預設是 PowerShell，其他平台用 `$SHELL`，Runner 設定可以覆寫。

## Considered Options

- **只保留 Desktop 開外部終端機**：看隊友的 Run 或 Team Runner 上的 Run 時做不到。
- **讓終端機的指令也經過 Permission Policy**：人自己下的指令不需要再問人，而且 PTY 的字元流無法可靠地切成指令來判斷。
- **斷線後保留終端機、可以重新接上**：要在 Server 暫存輸出並處理多個連線同時接上，複雜度不成比例，這次不做。

## Consequences

- Runner 信任 Server 的授權：Server 把 `terminal_id` 綁定到開啟者的 session，只轉送那個人的輸入；Runner 只接受自己開過的 `terminal_id`。Runner 端是否還要有自己的開關（例如 Team Runner 在 `runner.toml` 預設不允許）之後再決定。
- 終端機的輸出沒有 credit 背壓，Runner 送往 Server 時排在 Event、control 與 Heartbeat 之後。
