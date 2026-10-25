# 執行中換 Agent：留在同一個 Run 與 Worktree，用新的 session 接手，交接 prompt 由 Runner 依 Event 組出

使用者常在 Agent 卡住、額度用完或能力不夠時想換另一個 Agent 接手。ACP 的 session 綁在各家的 Agent 上，無法搬到另一個 Agent。所以「接續」的意思是：留在同一個 Run、同一個 Worktree，用新的 Agent 開新的 session，並送出交接 prompt（RunControl `switch_agent`、Event `agent_switched`）。

只在回合之間生效：回合中選擇切換時，和排隊的訊息一樣等回合結束。只能換成同一台 Runner 上可以用的 Agent（Worktree 在那台電腦上），而且要符合派工的限制。Run id 與 Worktree 不變；Run 的 Agent 改成目前的 Agent；用量與費用依 Agent 分段記錄（`run_agent_segments`）；權限策略依新 Agent 的 Agent Profile 重新套用 session mode；Child Run 不受影響。

交接 prompt 的格式固定，依序是：

1. Task 的規格與驗收條件
2. 人送出的所有 prompt（依時間）
3. Agent 每個回合最後的回覆
4. 目前的計畫
5. diff 摘要：改了哪些檔案、各增減幾行（細節請新的 Agent 自己讀 Worktree）
6. 還沒處理的審查留言

其中 Task 的規格、驗收條件與還沒處理的審查留言只有 Server 知道，由 `switch_agent` 帶給 Runner（`HandoffContext`）；其他部分 Runner 從 Run 的 Event 與 Worktree 組出。

## Considered Options

- **請舊的 Agent 先寫一份交接摘要**：會想換 Agent 的時候，舊的 Agent 常常已經不能用（額度用完、卡住、出錯），所以不依賴它。
- **開一個新的 Run 接手**：Worktree、審查關卡與 Run 的歷史都要重新串起來，事件串流也會斷成兩段，所以留在同一個 Run。
- **由 Server 組出整份交接 prompt**：diff 摘要要讀 Worktree，只有 Runner 做得到；Runner 組也讓 Fake Agent 的測試可以用 snapshot 鎖定格式。

## Consequences

- 換 Agent 之後，協定的 `usage` Event 從 0 重新累計，Run 的用量是各段的合計。
- 交接 prompt 以新的 prompt 來源 `handoff` 送出，事件串流可以標示出來。
