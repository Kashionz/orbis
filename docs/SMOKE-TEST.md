# 真實 Agent 煙霧測試

四個正式支援的 Agent（Claude Code、Codex、Antigravity、Grok Build）各跑一個小 Task，確認 Runner 和真實 Agent 的整條路徑（建立 Worktree → 權限請求 → Review Gate 退回 → 修正 → 核准 → push）還是通的。對應 ARCHITECTURE §17「真實 Agent 煙霧測試」與 M3 的完成條件。

**只在使用者自己的電腦上跑**：手動，或用 Windows 工作排程器每晚跑。不放進 GitHub Actions，Agent 的憑證不離開這台電腦。

## 它做什麼

腳本是 [`scripts/smoke-agents.ps1`](../scripts/smoke-agents.ps1)。每個 Agent：

1. 在輸出目錄建立一個只有 `README.md` 的 git repo（`main` 分支）。
2. 啟動 `dev_dispatch`（`crates/runner/examples/dev_dispatch.rs`，扮演最小的 Server，隨機 port）：派一個「新增 hello.txt」的 Task，權限請求一律回 `allow_once`，第一次 Review Gate 退回並送出修正 prompt，第二次核准後 `push_branch`。
3. 啟動 `orbis-runner`，用**獨立的 Runner home**（預設 `%TEMP%\orbis-smoke\home`），不會碰到你平常的 `~/.orbis`。
4. 結束後收齊 `result.json`（outcome、push 的 commit、最後的錯誤、耗時）、`summary.md`（Event 摘要）、`dev-dispatch.log`、`runner.log`。

全部跑完後寫 `summary.md` 與 `summary.json`，任何一個 Agent 不是 `completed` 就以非 0 結束。`%TEMP%\orbis-smoke\latest.txt` 指向最新一次的輸出目錄。

目錄：

```text
%TEMP%\orbis-smoke\
├── home\                 Runner home（跨次沿用：Antigravity 的登入標記、代管安裝的 ACP adapter）
├── latest.txt            最新一次的 runs 目錄
└── runs\<時間戳>\
    ├── summary.md / summary.json
    └── <agent>\          repo、wt（Worktree）、result.json、summary.md、dev-dispatch.log、runner.log
```

`runs` 中超過 7 天（`-KeepDays`）的目錄會自動刪除。

## 事前準備

- Rust toolchain 與 Git for Windows（腳本沒有指定 `-BinDir` 時會 `cargo build`）。
- 各 Agent 自己的登入：
  - Claude Code：`claude` 已登入（adapter 由 Runner 代管安裝）。
  - Codex：`codex login`；`~/.codex/config.toml` 不要指定帳號不支援的模型。
  - Grok Build：安裝 `grok` CLI（版本不低於 ARCHITECTURE §7 的最低版本）並登入，需要 SuperGrok 系列訂閱。
  - Antigravity：第一次執行時腳本會跑 `orbis-runner --home <home> login antigravity`，請在開啟的瀏覽器中用 Google 帳號登入；之後沿用同一個 home 中的登入標記。排程執行時加 `-SkipLogin`，沒登入就記為 `skipped`，不會卡在瀏覽器上。
- 網路：Runner 第一次會下載 Claude Code／Codex 的 adapter 與 Antigravity 的 `agy_acp_server`（存在 home 中，之後不必重抓）。

## 手動執行

```powershell
# 四個都跑（第一次會先 cargo build）
pwsh -NoProfile -File scripts\smoke-agents.ps1

# 只跑其中幾個、縮短每個 Agent 的上限
pwsh -NoProfile -File scripts\smoke-agents.ps1 -Agents claude-code,grok -TimeoutSec 900

# 用預先建置好的執行檔（orbis-runner.exe、dev_dispatch.exe 在同一個目錄）
pwsh -NoProfile -File scripts\smoke-agents.ps1 -BinDir C:\path\to\bin

# 開發者自測腳本流程：全部換成 Fake Agent，不呼叫真實模型
pwsh -NoProfile -File scripts\smoke-agents.ps1 -FakeScript crates\runner\tests\scripts\review-loop.yaml -Followup "請改成第二版"
```

結束碼 0 表示全部 `completed`。`summary.md` 的表格列出每個 Agent 的結果、耗時、push 的 commit 與最後的錯誤；細節看該 Agent 目錄中的 `summary.md`（Event 摘要）與兩份 log。

`result.json` 的 `outcome`：

| 值 | 意思 |
|---|---|
| `completed` | 修正後核准、push 成功 |
| `failed`／`canceled` | Run 以這個狀態結束，`last_error` 是最後的錯誤（例如 `agent_start_failed`：Agent 沒登入或沒安裝） |
| `push_failed` | 核准後 `push_branch` 被拒絕 |
| `timeout` | 超過 `-TimeoutSec` 還沒結束 |
| `disconnected` | Runner 中途斷線 |
| `skipped`／`login_failed` | Antigravity 沒登入（`-SkipLogin`）或登入失敗 |
| `no_result` | `dev_dispatch` 沒有寫出結果，請看 log |

## Windows 工作排程器每晚執行

以使用者自己的帳號建立排程（Agent 的憑證在這個使用者的 profile 中，不能用 SYSTEM 跑）：

```powershell
$repo = "C:\path\to\orbis"          # 這個 repo 的位置
$action = New-ScheduledTaskAction -Execute "pwsh.exe" `
  -Argument "-NoProfile -NonInteractive -File `"$repo\scripts\smoke-agents.ps1`" -SkipLogin -BinDir `"$repo\target\debug`"" `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 2:00AM
$settings = New-ScheduledTaskSettingsSet -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 3) -StartWhenAvailable
Register-ScheduledTask -TaskName "Orbis smoke agents" -Action $action -Trigger $trigger -Settings $settings `
  -RunLevel Limited -Description "Orbis 真實 Agent 煙霧測試（docs/SMOKE-TEST.md）"
```

注意：

- 預設是「只在使用者登入時執行」（`Register-ScheduledTask` 沒有給 `-User`／`-Password` 時）。改成「不論使用者是否登入」要輸入密碼，而且有些 Agent 的登入狀態綁在互動式 session 上，可能失敗。
- `-BinDir` 指到已建置的目錄，避免排程時間 `cargo build`；更新 Orbis 之後重新 `cargo build -p orbis-runner --bin orbis-runner --example dev_dispatch`。
- 前一晚 `-SkipLogin` 讓 Antigravity 變成 `skipped` 時，手動跑一次（不加 `-SkipLogin`）完成登入即可。
- 看結果：`Get-Content (Get-Content $env:TEMP\orbis-smoke\latest.txt)\summary.md`。排程器中的「上次執行結果」非 0 表示有 Agent 沒通過。
- 移除排程：`Unregister-ScheduledTask -TaskName "Orbis smoke agents" -Confirm:$false`。

## 常見失敗

- `agent_start_failed`／`agent_unavailable`：該 Agent 沒登入或 CLI 不在 PATH 上；Antigravity 看是不是需要重新 `login`（認證過期時 Runner 會清掉登入標記）。
- Codex 回了「模型不支援」當成一般回覆、diff 為空：`~/.codex/config.toml` 指定的模型帳號不支援（ARCHITECTURE §7）。
- `timeout`：Agent 卡在等權限或模型很慢；看該 Agent 的 `summary.md` 最後幾個 Event。
- `push_failed`：看 `last_error`；本機 repo 不是 bare repo，只能 push 到 `main` 以外的分支（Runner 的分支本來就不是 `main`）。
