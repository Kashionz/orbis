# E1 Desktop Core（W2–4）

你是 Track E，在自己的 Orca Worktree 中開發 Orbis 的 Electron 桌面殼。目標是：載入 Web UI、登入後自動完成 Local Runner 的 Pairing、代管 Runner sidecar、對 Needs You 項目發出桌面通知。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §2、§6.1、§12.3（只看桌面通知的部分）、§16
- `docs/adr/0001`、`0008`

## 範圍

你擁有 `apps/desktop`（這個階段還不碰 `preview/` 的部分）。Runner 是 A 軌產出的執行檔，你只負責它的生命週期，不修改 Runner 本身。

## 交付項目

1. **殼**：
   - 第一次啟動時設定 Server URL，之後在 BrowserWindow 中載入 Web UI。
   - 嚴格的安全設定：`contextIsolation`、不啟用 `nodeIntegration`、只透過 preload 暴露最小的 API。
2. **登入與 Pairing**：Web UI 登入後，透過 preload API 向 Server 取得 Local Runner 的 Pairing token，交給 sidecar。登出時解除 Pairing。
3. **Runner sidecar**：
   - 啟動、停止、當掉時自動重啟（指數退避）。
   - 擷取 log，並提供「開啟 Runner log」選單。
   - 開發模式使用 `cargo build` 的產物，打包模式使用內建的執行檔。
   - 結束 App 時，確保 Runner 與它的所有子程序都被結束（Windows 用 Job Object，或交給 Runner 的關閉協定處理）。
4. **系統匣**：顯示 Runner 狀態（連線中、執行中 N 個 Run、離線）與 Needs You 的數量，提供「顯示視窗」與「暫停領取新 Run」選項。
5. **桌面通知**：訂閱 Server 的通知推送，Needs You 項目出現時發出原生通知，點擊後跳到對應的頁面。
6. **開啟本機工具**：在 Run 頁面提供「用編輯器開啟 Worktree」和「在終端機開啟」，兩者都可以設定要用哪個程式。

## 完成條件

- 在 Windows、macOS、Linux 上都能以開發模式啟動，並完成「登入 → Runner 自動 Pairing → 系統匣顯示已連線」。
- 有一個自動化測試（Playwright 的 Electron 模式）驗證：sidecar 當掉後會自動重啟；App 結束後沒有殘留的 Runner 程序。
- 三平台 CI 全部通過。
- 這個階段**不需要**打包安裝檔與自動更新（那在 91 階段處理）。

## 結束時

開 PR `track-e: desktop core`。
