# Local Runner 與 Team Runner 是同一個執行檔，並主動反向連到 Server

Orbis 同時要支援「Agent 跑在成員自己的電腦上」和「Agent 跑在團隊伺服器上」。我們決定兩者使用同一個 Runner daemon，差別只在部署位置與 Pairing 對象。Runner 一律主動以 WebSocket 連到 Server 領取 Dispatch，Server 永遠不連進 Runner。這樣 Phase 2 加 Team Runner 時不必重寫，成員的電腦也不必開放任何入站 port。這與 Claude Code Remote Control、Codex App Server 的「核心獨立、客戶端很薄」方向一致。

## Consequences

- Preview 的分享流量也必須走這條反向通道（見 [ADR-0010](0010-preview-through-runner-channel.md)）。
- Server 無法主動「叫醒」離線的 Runner。Local Runner 離線時，Run 只能在佇列中等待。
