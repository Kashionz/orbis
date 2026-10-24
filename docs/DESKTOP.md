# Orbis Desktop：安裝與更新

Desktop 是 Web UI 的外殼，另外代管這台電腦的 Local Runner（[ARCHITECTURE §16](ARCHITECTURE.md#16-部署與發布)）。安裝檔放在 GitHub 的 [Releases](https://github.com/Kashionz/orbis/releases)，每個版本附：

| 檔案 | 用途 |
|---|---|
| `Orbis-<版本>-win-x64.exe` | Windows 安裝檔（NSIS，一鍵安裝到使用者目錄） |
| `Orbis-<版本>-mac-arm64.dmg`、`Orbis-<版本>-mac-x64.dmg` | macOS 安裝檔（Apple Silicon 用 arm64，Intel 用 x64） |
| `Orbis-<版本>-mac-*.zip`、`latest.yml`、`latest-mac.yml` | 自動更新用，不需要手動下載 |
| `orbis-runner-<平台>` | Runner 的單獨執行檔（Team Runner、手動執行用）；Desktop 已內建，不用另外下載 |

Phase 1 的安裝檔**沒有程式碼簽章**（Windows、macOS 都沒有），第一次開啟時作業系統會警告，下面說明怎麼處理。簽章排在 Phase 2。

## Windows

1. 下載 `Orbis-<版本>-win-x64.exe` 並執行。
2. SmartScreen 會顯示「Windows 已保護您的電腦」：按「**其他資訊**」，再按「**仍要執行**」。瀏覽器下載時也可能要在下載清單中選「保留」。
3. 安裝不需要系統管理員權限，裝在 `%LOCALAPPDATA%\Programs\Orbis`，完成後自動啟動。
4. 解除安裝：「設定 → 應用程式」或開始功能表的「Uninstall Orbis」。本機設定（`%APPDATA%\Orbis`）會保留，要清掉請自行刪除。

## macOS

1. 下載對應架構的 dmg（「關於這台 Mac」看是 Apple 晶片還是 Intel），打開後把 Orbis 拖到「應用程式」。
2. 第一次開啟會被 Gatekeeper 擋下（「無法打開，因為 Apple 無法檢查其是否含有惡意軟體」或「無法驗證開發者」）。任選一種方式放行：
   - 「**系統設定 → 隱私權與安全性**」，往下捲到安全性區塊，按「**強制打開**」，再確認一次。
   - 或在 Finder 對 Orbis **按右鍵 → 打開**，再按「打開」（macOS 15 以後只能用上一種）。
   - 或在終端機移除隔離標記：`xattr -d com.apple.quarantine /Applications/Orbis.app`。
3. 之後就能正常開啟。更新時下載新的 dmg 覆蓋，第一次開啟要再放行一次。

## 第一次啟動

1. 輸入 Server 的網址（Web UI 的 origin，例如 `https://orbis.example.com`），Desktop 會用 `/api/health` 確認後儲存。
2. 用 GitHub 登入。登入後 Desktop 自動替這台電腦的 Local Runner 完成 Pairing，系統匣顯示「已連線」。
3. Runner 需要的 Agent（Claude Code、Codex 等）由 Runner 自己安裝或偵測，憑證留在這台電腦上。

關閉主視窗只是縮到系統匣，Runner 繼續執行；要結束請用系統匣或選單的「結束 Orbis」。

## 自動更新

Desktop 從 public GitHub Releases 檢查更新：啟動 30 秒後第一次，之後每 6 小時一次；系統匣與「檔案」選單的「檢查更新…」可以隨時手動檢查。只看已 publish 的 Release，不看 draft 與 pre-release。

- **Windows**：有新版本時自動下載，下載完成後詢問「立即重新啟動並更新」或「稍後」。選稍後，更新會在結束 App 時安裝；系統匣會顯示「更新 vX 已下載，結束 App 時安裝」。安裝前 Desktop 會先停止 Runner（還有 Run 在跑時會再確認一次），內建的 Runner 執行檔隨 App 一起換新。
- **macOS**：未簽章的 App 不能自動安裝更新，所以只會提示「有新版本 vX」，可以「開啟下載頁」「略過這個版本」或「稍後」。略過的版本不再提示（手動檢查仍會問），稍後則下一次檢查再提醒。下載 dmg 後覆蓋「應用程式」中的 Orbis，重新開啟時再放行一次 Gatekeeper。
- 更新與版本檢查的紀錄在 `logs/desktop.log`（Windows：`%APPDATA%\Orbis\logs`；macOS：`~/Library/Application Support/Orbis/logs`），Runner 的紀錄在同目錄的 `runner.log`。

## 版本相容

Runner、Server、Desktop、Web 不一定同時更新，版本不相容時 UI 會明說要更新哪一個（[ARCHITECTURE §16「版本相容」](ARCHITECTURE.md#16-部署與發布)）：

| 看到的提示 | 要做的事 |
|---|---|
| 系統匣或對話框：「Desktop 版本過舊，請更新 Desktop」 | Windows 按「檢查更新」；macOS 到 Releases 下載新版。內建的 Runner 會一起更新。 |
| 系統匣或對話框：「Server 版本過舊，請更新 Server」 | 請 Server 的管理者升級 Server（見 [INSTALL.md](INSTALL.md)）。 |
| 頁面頂端：「Web UI 有新版本，請重新整理」 | 瀏覽器快取了舊的 Web UI，按「重新整理」即可。 |
| 頁面頂端：「Server 版本過舊，請更新 Server」 | 同上，請管理者升級 Server。 |
| Runner log：`hello_rejected`、`version_mismatch` | 手動執行的 Runner 版本和 Server 不符，訊息會說要更新 Runner 還是 Server。 |

## 發布新版本（維護者）

1. 把 `apps/desktop/package.json` 的 `version` 改成新版本並合併到 `main`。
2. 在 `main` 上打 tag 並推上去：`git tag v<版本> && git push origin v<版本>`。tag 必須和 `package.json` 的版本一致，否則 workflow 會失敗。
3. `.github/workflows/release.yml` 在 Windows 與 macOS 建置 Runner（release）與 Desktop，建立一個 **draft** Release 並上傳上表的檔案。
4. 檢查 draft 的附件，填 release notes，按 **Publish**。publish 之後 Windows 的 Desktop 會在下一次檢查時自動更新，macOS 會提示下載。
5. 只想確認打包是否正常、不要發布：在 Actions 手動執行「Release」workflow（workflow_dispatch），安裝檔會上傳成 workflow artifact。

### 在本機測試更新流程

設定環境變數 `ORBIS_DESKTOP_UPDATE_FEED_URL` 指向一個靜態檔案伺服器（底下放 electron-builder 產生的 `latest.yml`／`latest-mac.yml` 與安裝檔），開發模式（`pnpm dev:desktop`）也會檢查更新。Desktop 的 e2e（`apps/desktop/e2e/update.spec.ts`）就是用本機的 fake feed 跑真實的 electron-updater。
