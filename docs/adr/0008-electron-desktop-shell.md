# 桌面殼用 Electron，而且只是 Web UI 的外殼

主要介面是 Web UI，瀏覽器就能使用。桌面殼負責載入 Web UI、代管 Local Runner sidecar、系統匣、桌面通知，以及內嵌的 Preview 瀏覽器（WebContentsView）。我們選擇 Electron 而不是 Tauri，因為三平台的渲染一致（Tauri 在 Linux 上用的 WebKitGTK 渲染終端機與 diff 比較容易出問題），WebContentsView 也適合做 Preview 與元素留言。Codex、Claude Desktop、Nimbalyst、Orca 都用 Electron。Runner 是獨立的 Rust 執行檔，不跑在 Electron 的 Node 程序中，所以 Team Runner 可以不依賴 Electron 單獨部署。
