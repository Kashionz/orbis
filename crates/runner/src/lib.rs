//! Runner 的程式庫部分。`main.rs` 只負責命令列與 log 設定，其他邏輯都在這裡，
//! 讓整合測試可以直接使用。

pub mod config;
pub mod connection;
pub mod contract;
pub mod git;
pub mod home;
pub mod paths;
pub mod policy;
pub mod process;
pub mod repo_config;
pub mod secrets;
pub mod shell;
pub mod worktree;
