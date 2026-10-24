# A2 Runner Advanced（W5–7）

你是 Track A 第二階段。目標是在 A1 的 Runner 上加入：其他三個 Agent、Planning 階段、Verification 的 Runner 端、Orbis MCP server 與 Delegation、並行與 rate limit 處理、Feedback Loop 的接續執行。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §5、§5.1、§5.2、§7、§8、§9、§13（Playwright MCP 的部分）
- `docs/adr/0002`、`0005`、`0006`、`0009`

## 範圍

範圍與 A1 相同：`crates/runner`（`src/preview/` 除外）與 `crates/fake-agent`。

## 交付項目（依優先順序）

1. **Agent Profile**：
   - Codex（`codex-acp`）、Antigravity（Google 官方的 `agy_acp_server`，取代 Gemini CLI）、Grok Build（`grok agent stdio`），版本都要鎖定。
   - 每個 profile 都寫清楚 Windows 上的啟動方式，以及已知的功能落差（ARCHITECTURE §7 的表格）。
   - Agent 不支援某項能力時，透過 `capabilities()` 回報，讓上層可以降級處理。
2. **Planning**：以 plan 模式執行，收到 plan Event 後送出「等待 Plan Gate」，核准後切換成執行模式。如果某個 Agent 的 plan 模式不可靠，在 profile 中標註，並改用「只產出 plan、不修改檔案」的 prompt 作為後備。
3. **Verification（Runner 端）**：
   - `command`：在 Worktree 執行指令，回報 exit code 與 log 摘要。
   - `agent`：開一個 `consult` 的 Child Run 逐條判定，回報結果與證據。
   - `browser`：注入 Playwright MCP，連到該 Run 的 Preview，回報截圖與操作紀錄。
4. **Orbis MCP server**：在每個 session 開始時注入（stdio），提供 §9 的全部工具。工具呼叫透過協定轉給 Server。
5. **Delegation**：
   - `consult`：在父 Worktree 中唯讀。
   - `branch`：從父 Run 當下的 HEAD 開出子 Worktree，分支命名用 `--c<n>`。
   - `merge_child`：merge 子分支；有衝突時把衝突交給父 Agent，父 Agent 解不了就停下來並加入 Needs You。
   - `ask_parent`：Child Run 阻塞等待父 Run 回答。
   - 防護規則：深度、子 Run 數量、權限只能收緊。
   - 父 Run 被中止或封存時，連同 Child Run 一起處理。
   - **進度落後時**：`branch` 模式延到 Phase 2，先完成 `consult`。
6. **並行與 rate limit**：依 Credential 的並行上限（預設 30）決定能不能接受 Dispatch。偵測到各 Agent 的 rate limit 錯誤時，回報 rate limit Event 並暫停 Run，額度恢復後在同一個 session 繼續。
7. **Feedback Loop 的接續執行**：收到 Server 送來的修正 prompt 時，如果 session 還在就直接接續；如果程序已經結束，就用 `session/resume`（或 `session/load`）恢復後再接續，修正完成後 push。

## 完成條件

- 每個交付項目都有 Fake Agent 劇本測試（必要時擴充 Fake Agent），三平台 CI 全部通過。
- Delegation 的測試涵蓋：深度超過上限被拒絕、子 Run 數量超過上限被拒絕、`merge_child` 發生衝突、父 Run 中止時 Child Run 一併中止、`ask_parent` 的阻塞與回答。
- 四個 Agent 都在 Windows 實機上各跑一個小 Task 成功，Claude Code 透過 `delegate` 把工作交給 Codex 也成功。

## 結束時

開 PR `track-a: runner advanced`，說明中更新各 Agent Profile 的功能落差表。如果表格內容有變動，也要同步更新 ARCHITECTURE §7。
