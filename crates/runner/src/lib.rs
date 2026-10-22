//! Runner 的程式庫部分。`main.rs` 只負責命令列與 log 設定，連線邏輯在這裡，
//! 讓測試與之後的 A1（重連、Dispatch）可以直接使用。

pub mod config;
pub mod connection;
