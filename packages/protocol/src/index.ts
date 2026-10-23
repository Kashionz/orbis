// 型別都在 ./generated，由 `pnpm gen:protocol` 從 crates/orbis-protocol 產生。
// 要改協定請改 Rust 後重新產生（ADR-0003）。
export * from "./generated/index";
// Preview binary 訊息的編解碼（手寫，與 Rust 共用 golden case）。
export * from "./preview-data";
