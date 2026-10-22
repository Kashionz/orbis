# Agent 權限由 Runner 依政策回覆 ACP 權限請求，不使用 Agent 的 bypass 旗標

Orca 預設以 YOLO 模式啟動 Agent（例如 `--dangerously-skip-permissions`），把 Worktree 當作沙盒，權限則以字串形式寫在啟動參數裡。但 Worktree 只能隔離檔案衝突，擋不住 Agent 讀取 `~/.ssh` 或雲端憑證。我們改成一律以「會詢問」的模式啟動 Agent，再由 Runner 依 Permission Policy（`manual`／`auto`／`yolo`，預設 `auto`）回覆 `session/request_permission`。這樣政策是結構化資料，可以讓 Child Run 繼承並收緊，也能統一套用在所有 Agent 上。

## Consequences

- Agent 對 ACP 權限請求的支援程度不一，Agent Profile 必須標示哪些操作在這個 Agent 上「無法攔截」，UI 也要讓使用者看得到。
- Phase 1 沒有 OS 層級沙盒，所以 Local Runner 上的 `yolo` 一定要顯示警告。
