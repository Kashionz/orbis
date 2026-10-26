# 設定最小化：行為寫死合理的預設值，只留下沒有它就不能運作的設定

v0.1.0 時，個人設定有 5 個分頁、Project 設定約 16 項、管理頁有 3 區，`.orbis/config.toml` 有 7 個區段；v0.1.0 完成規劃中還有自訂 State、Task 類型與自訂欄位、彙報關係、Wiki 資料夾權限等會再增加設定的項目。使用者要求整個專案從簡，不讓使用者動到太多設定（2026-10-26）。

原則是能寫死就寫死，只保留沒有它就不能運作的設定：

| 位置 | 保留 | 改成固定的行為 |
|---|---|---|
| 個人設定 | 語言、主題 | 預設版面、自動展開工具用固定的預設值；版本移到「關於」；終端機的 shell 自動偵測；Windows 長路徑一律開啟，不顯示；各 Agent 的預設模型改成記住上次的選擇；通知只剩一個桌面通知開關，拿掉依事件類型關閉、勿擾時段與時區（時區取瀏覽器的設定） |
| Team 設定 | 名稱、成員 | 對外分享預覽一律允許；「允許 Team Runner 的終端機」拿掉（ADR-0017） |
| Project 設定 | 名稱、描述、Task Key 前綴、Repo 與預設分支 | Plan Gate 改成派工時的選項「先出計畫」，預設不勾；Delegation 一律開啟、可以分派給所有 Agent；拿掉「禁止核准自己的 Task」；成員一律可以派工到 Team Runner；拿掉預設權限策略（ADR-0017）；Verification 固定最多重試 3 次；GitHub Repo 的 Task 一律建立 Issue；bot 的留言一律不觸發 Feedback Loop；本機合併固定 squash，合併後不 push 基準分支 |
| 管理頁 | 成員 | 拿掉 Credential 並行上限的覆寫，一律用 Runner 回報的值，佇列與用量改成唯讀；拿掉信任請求（ADR-0017） |
| `.orbis/config.toml` | `[worktree]` 的 `setup`、`copy`；`[preview]` 的 `command`；`[verify]` 的 `commands` | 拿掉 `archive` hook、`wait_for_setup`（一律等 setup 完成）、`shared_dirs`、`ready_path`（固定 `/`）、`[permissions]`、`[delegation]`、`[git].commit_message`（固定 `<TASK-KEY>: <title>`） |
| `runner.toml` | Server 網址、Runner 名稱、Worktree 根目錄、`port_range`、`[repos]`、`[agents]` | 拿掉 `allow_terminal`、`terminal_shell`、`terminal_idle_timeout_secs`、`[agents.claude-code] user_settings`、`[browser_judge]` |
| Desktop | — | 拿掉「代理可以使用的資料夾」的允許清單，開對話時直接選資料夾；拿掉「接收預覽版」 |

- **Role 只剩 Owner 與 Member**，拿掉 Admin、Viewer 與 Project 的 Role 覆寫。Owner 管理成員、Team Runner 的 Pairing 與撤銷、刪除 Project；其他事（建立與設定 Project、登記 Repo、派工、核准 Gate、留言）Member 都可以做。migration 時 Admin 改成 Owner，Viewer 改成 Member。
- **拿掉 Task 分享**（取代 ADR-0012）：不再有 Task 成員、Task 角色與一般存取，Team 中每個人都能看、能操作每個 Task。Task 邀請改成邀請加入 Team（以 Member 身分），沿用已驗證 email 的比對與 7 天期限。
- **預覽邀請保留**（ADR-0015）：這是給 Team 以外的人看成果的唯一方式，不再需要先打開 Team 設定。
- **規劃中的項目**：拿掉 Task 類型與自訂欄位、彙報關係與主管留言、Wiki 資料夾權限、CI App 白名單、可設定的 blob 保存期限；自訂 State 改成固定 5 個 State；Module、Intake、排程週報、Wiki 的 git 同步延後；Worktree 與 Task 的自動封存期限寫死。細節見 v0.1.0 完成規劃。

## Considered Options

- **保留設定，收進「進階」**：程式碼、測試與文件的分支數不變，只是藏起來；使用者還是會被問到怎麼設。
- **保留 Viewer**：給 Team 以外的人看成果已經有預覽邀請；2–10 人的 Team 不需要唯讀角色。
- **保留 Admin**：Owner 可以有多位，Admin 與 Owner 的差別（能不能指派 Owner）對小團隊沒有意義。

## Consequences

- 預設值不適合時要改程式碼，不是改設定。之後真的有需求再加回設定，先開 ADR。
- 刪掉的設定欄位要有 migration，舊值直接丟棄（Role 除外）。Viewer 改成 Member 會提高權限，migration 前要在 release notes 說明。
- 一般存取是「僅受邀成員」的 Task 會變成 Team 都看得到；這類 Task 停止同步的 GitHub Issue 依 ADR-0012 的補寫規則恢復同步。
- 取代 [ADR-0012](0012-task-sharing-and-invites.md)；修訂 [ADR-0013](0013-local-repo-and-connect-to-github.md)（本機合併方式固定）、[ADR-0015](0015-preview-invites.md)（不需要 Team 設定）。
