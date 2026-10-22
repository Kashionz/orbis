# Runner 用 Rust 寫，Runner↔Server 協定以 Rust 型別為唯一定義來源

Runner 要在三平台以單一執行檔發布，同時處理 PTY、Job Object、大量子程序與持續的 stdout 讀取。我們選擇用 Rust 實作 Runner，Server、Web 與 Desktop 則維持 TypeScript。協定型別定義在 `crates/orbis-protocol`（`serde`），用 `ts-rs` 產生到 `packages/protocol`，CI 會檢查產生的結果是否與 Rust 一致。傳輸格式是 WebSocket 上的 JSON。

## Considered Options

- **JSON Schema 或 Protobuf 作為中立定義**：多一層工具鏈。而 Event 模型本來就是 Runner 從 ACP 正規化出來的，由 Rust 定義最自然。
- **Runner 也用 TypeScript**：ACP 的 TS SDK 最成熟，但打包成單一執行檔與 Windows 程序管理都比較麻煩。

## Consequences

- `packages/protocol` 不可以手改。要改協定，先改 Rust，再重新產生型別。
