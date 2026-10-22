# E2 Preview（W5–7）

你是 Track E 第二階段。目標是完成 Preview：Runner 啟動 dev server、經由 Runner 通道轉送給 Team、Electron 內嵌瀏覽器、在 Preview 上點選元素留言並回給 Agent。

## 先讀

- `CLAUDE.md`、`GLOSSARY.md`
- `docs/ARCHITECTURE.md` §6.3（`[preview]` 的部分）、§13、§19（第一項待決事項）
- `docs/adr/0001`、`0010`

## 範圍

你擁有 `apps/desktop`、`crates/runner/src/preview/`、`apps/server/src/preview/`。Run 頁面的 Preview 分頁在 `apps/web` 中，由 C 軌預留位置；你需要的元件請放在 `apps/web/src/features/preview/`，並在 PR 中標註請 C 軌 review。

## 第一步：先停下來確認

開始實作前，**先向人提出 ARCHITECTURE §19 的 Preview 網址方案**：路徑式（`/preview/<run-id>/`）或子網域式（`<run-id>.preview.<domain>`）。列出兩者在 Vite、Next.js 等常見框架上的實際影響與部署需求，等人選定後才繼續。決定之後要更新 ARCHITECTURE §13 與 §19。

## 交付項目

1. **Runner 端的 Preview 程序**：依 `[preview].command` 用 `ORBIS_PORT` 啟動 dev server；用 `ready_path` 判斷是否已就緒，就緒後送出 preview 就緒的 Event；Run 結束時一併結束 dev server。
2. **轉送**：Runner 端把 HTTP 與 WebSocket（含 HMR）流量多工到既有的 Runner 通道；Server 端提供有登入保護的 Preview 網址，只有同 Team 的人可以存取；處理大型回應的串流與背壓。
3. **Electron 內嵌瀏覽器**：本機的 Run 直接用 WebContentsView 開 `localhost:$ORBIS_PORT`，別人的 Run 則開 Server 的 Preview 網址；提供網址列、重新整理、DevTools。
4. **在 Preview 上留言**：點選元素時以 overlay 標示，留言時自動附上截圖、CSS selector 與 URL，送出後成為 Agent 的下一個 prompt（透過 B 軌的介面）。
5. **瀏覽器版本**：在一般瀏覽器中開 Preview 網址也能用，但不提供元素留言功能，只能附上整頁截圖。

## 完成條件

- Preview 的轉送有整合測試：以 Fake Agent 的 Run 搭配一個簡單的 Vite app，驗證 HTTP、HMR 的 WebSocket、大檔案都能正常通過，而且未登入的請求會被拒絕。
- 元素留言有 Playwright（Electron 模式）測試，驗證送給 Agent 的 prompt 中包含 selector 與截圖參照。
- 三平台 CI 全部通過。

## 結束時

開 PR `track-e: preview`。
