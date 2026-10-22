---
status: accepted（已知風險）
---

# Team Runner 共用一個 Claude 訂閱

團隊決定 Team Runner 共用同一個 Claude 訂閱，不改用 API key。這是在了解條款風險後做的決定。根據 2026-10 查到的第三方整理（非 Anthropic 官方條文）：Consumer Terms 禁止共用帳號登入或憑證；訂閱的 OAuth token 限定用在 Claude Code 與 claude.ai；訂閱額度的設計前提是一般個人使用。最壞情況是帳號被停權，整個團隊的 Agent 會同時停擺。

## Consequences

- 設定頁要清楚顯示這個風險；Credential 的類型要可以隨時切換成 API key，不需要改程式碼。
- 並行上限雖然預設 30，但實際上可能先撞到訂閱額度。rate limit 的處理方式（暫停、等待恢復）必須穩健。
- 建議另外向 Anthropic 確認條款；如果有變動，就改成 API key 或 Claude Team 方案的個人席位。
- Local Runner 不受這項決定影響，每個人仍然使用自己的 `claude` 登入。
