# A1 Runner Core（W2–4）

你是 Track A，在自己的 Orca Worktree 中開發 Orbis Runner（Rust）。目標是讓 Runner 能可靠地領取 Run、建立 Worktree、以 ACP 驅動 Claude Code、依 Permission Policy 回覆權限請求，並把 Event 串流到 Server。這是 M1 Dogfood 的核心路徑。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §6（全部）、§7、§8、§14
- `docs/adr/0001`、`0002`、`0006`、`0007`

## 範圍

你擁有 `crates/runner`（`src/preview/` 除外）與 `crates/fake-agent`。要修改 `crates/orbis-protocol`，請依 PLAN.md 的契約變更流程。

## 交付項目

1. **連線與 Dispatch**：
   - Pairing（token 存放在本機設定）。
   - 斷線後以指數退避重新連線。
   - 驗證 Dispatch ID，並拒絕過期的 Dispatch。
   - 斷線期間 Event 先暫存在本機，重新連上後依 seq 補送。
2. **Worktree 管理**：§6.2 的路徑、分支名稱、建立流程、刪除保護、WSL 處理，以及 §6.3 的 config 解析、信任 hash、環境變數注入、`ORBIS_PORT` 分配。
3. **程序管理**：§6.4。Windows 用 Job Object，macOS／Linux 用 process group；持續讀取 stdout；路徑正規化；spawn 時自己處理引號；解析 `.cmd` shim；關閉 git 的互動式提示。
4. **`AcpAgentAdapter` 與 Agent Profile 架構**：
   - 先完成 **Claude Code** 的 profile（鎖定 `claude-agent-acp` 的版本）。
   - 從 `initialize` 讀出能力旗標，透過 `capabilities()` 提供給上層。
5. **Event 正規化**：把 ACP 的 `session/update` 轉成協定中的 Event kind；送出前遮蔽像 secret 的字串；大型內容改送 blob 參照。
6. **Permission Policy 引擎**：`manual`、`auto`、`yolo` 三級，以及 `allow_commands` 的 glob 比對。要問人時送出權限請求 Event，並暫停等待 RunControl 的回覆。
7. **RunControl**：取消、送出後續 prompt（Review Gate 退回時，在**同一個 session** 繼續），以及 push 分支（供 D 軌開 PR 用）。

## 完成條件

- 每個交付項目都有使用 Fake Agent 劇本或真實 git 的測試，**而且三平台 CI 全部通過**。
- 以下 Windows 情境都有測試：路徑含空白、磁碟代號大小寫不同、長路徑錯誤、`.cmd` shim、取消時整個程序樹都被結束。
- 有一個測試能用 Fake Agent 走完：領取 Dispatch → 建立 Worktree → 權限請求 → 收到回覆 → 產生 diff → 完成 → 收到退回的 prompt → 再次完成。
- 在真實的 Windows 機器上用 Claude Code 手動跑一個小 Task 成功，並在 PR 說明中附上 Event 摘要。

## 結束時

開 PR `track-a: runner core`。在說明中列出：各 Agent Profile 已知的功能落差，以及你提出或需要的契約 PR。
