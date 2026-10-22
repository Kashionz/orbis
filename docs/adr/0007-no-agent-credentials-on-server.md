# Server 不保存任何 Agent Credential

Agent 的登入狀態與 API key 只存在 Runner 主機上。Local Runner 沿用各 CLI 自己的登入狀態，Team Runner 則用 Docker secret。Server 只記錄每台 Runner 能跑哪些 Agent，以及各 Credential 的並行上限。`.env` 這類檔案也只在 Runner 本機複製。這樣即使 Server 被入侵，攻擊者也拿不到任何模型的 Credential。代價是「在 UI 上設定 Credential」這類功能無法實作，Credential 只能在 Runner 主機上設定。
