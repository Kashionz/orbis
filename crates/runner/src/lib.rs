//! Runner 的程式庫部分。`main.rs` 只負責命令列與 log 設定，其他邏輯都在這裡，
//! 讓整合測試可以直接使用。

pub mod agent;
pub mod archive;
pub mod blobs;
pub mod catalog;
pub mod config;
pub mod connection;
pub mod diff;
pub mod git;
pub mod handoff;
pub mod home;
pub mod judge;
pub mod local_merge;
pub mod login;
pub mod normalize;
pub mod orbis_mcp;
pub mod outbox;
pub mod paths;
pub mod policy;
pub mod preview;
pub mod process;
pub mod rate_limit;
pub mod repo_config;
pub mod run;
pub mod secrets;
pub mod shell;
pub mod sidecar;
pub mod supervisor;
pub mod worktree;
