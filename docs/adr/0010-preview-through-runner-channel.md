# Preview 經由 Runner 既有的反向通道分享，不使用第三方 tunnel

成員要能看到隊友 Run 的 Preview。我們讓 Runner 把 Preview 的 HTTP 與 WebSocket 流量經由它已經連到 Server 的 WebSocket 通道轉送，Server 以登入保護的網址對外提供。這樣不需要開 port，也不需要 ngrok 或 Cloudflare Tunnel 這類第三方服務，存取控制也沿用 Orbis 的 session。

## Consequences

- Server 要承擔 Preview 的頻寬，大型資源也會經過 Runner 的上傳頻寬。
- 路徑式網址（`/preview/<run-id>/`）會讓使用絕對路徑載入資源的 app 壞掉。要在路徑式與子網域式之間做選擇，見 ARCHITECTURE §19 的待決事項。
