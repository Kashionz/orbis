# 91 Integration：M3 Phase 1 發布（W8–9）

你負責整合 A2–E2，完成 Windows 強化、部署與發布，達成 **M3**。

## 先讀

- `CLAUDE.md`、`docs/PLAN.md` 的里程碑
- `docs/ARCHITECTURE.md` §16、§17、§18
- 各軌 PR 說明中的落差清單

## 交付項目

1. **整合**：確認 A2–E2 都已合併，並清除所有的 `TODO(api)` 與 `TODO(contract)`。端到端測試要涵蓋 M2 的完成條件：每個 Gate、Verification 重試、Feedback Loop、Delegation、共同編輯、通知、Preview 留言。
2. **Windows 強化清單**，每一項都要有測試或實機驗證紀錄：
   - 路徑含空白或非 ASCII 字元（例如中文使用者名稱）
   - 長路徑
   - 防毒軟體或索引服務鎖住檔案時的刪除重試
   - WSL 中的 git
   - PowerShell、cmd、Git Bash 三種 setup 腳本
   - 休眠與喚醒後 Runner 重新連線
   - 多個 Worktree 同時跑 dev server 時 port 不衝突
3. **真實 Agent 煙霧測試**：一個可以手動觸發或每晚定時跑的 workflow，Claude Code、Codex、Gemini、Grok 各跑一個小 Task 並回報結果。
4. **部署**：
   - `deploy/docker-compose.yml`，包含 Postgres、Server、選用的 Team Runner。
   - Team Runner 的 Docker image，Credential 用 Docker secret 傳入。
   - 撰寫 `docs/INSTALL.md`：GitHub App 的安裝、第一次啟動、備份與還原、升級。
5. **Desktop 發布**：
   - electron-builder 產出 Windows 與 macOS 的安裝檔（Linux 暫時不出）（Windows 不做簽章，文件中說明 SmartScreen 警告）。
   - electron-updater 從 private GitHub Releases 自動更新，Runner 執行檔隨 App 一起更新。
6. **版本相容**：Runner、Server、Desktop 的協定版本不相容時，UI 明確提示需要更新哪一個元件，並用測試驗證。

## 完成條件（M3）

- 用一台乾淨的 Windows 機器，只照著 `docs/INSTALL.md` 操作，就能完成：部署 Server → 安裝 Desktop → 登入 → 跑完一個 Task 到 merge。
- 四個 Agent 的煙霧測試都通過。
- ARCHITECTURE 與 GLOSSARY 都已經反映實際的行為。

## 結束時

開 PR `integration: phase 1 release`，打上 tag `v0.1.0`，並在 PR 說明中列出移到 Phase 2 的項目。
