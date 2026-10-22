//! Orbis Runner↔Server 協定。
//!
//! 這個 crate 是協定的唯一定義來源（ADR-0003）。TS 型別由 `gen-ts` 產生到
//! `packages/protocol`，不可以手改產生的檔案。
//!
//! 傳輸格式是 WebSocket 上的 JSON：每個 frame 是一個帶 `type` 欄位的物件，
//! 見 [`frame::RunnerToServer`] 與 [`frame::ServerToRunner`]。

pub mod availability;
pub mod connection;
pub mod control;
pub mod dispatch;
pub mod enums;
pub mod event;
pub mod frame;
pub mod ids;
pub mod names;
pub mod sidecar;
pub mod typescript;

/// Runner↔Server 協定版本。不相容的變更要遞增，Server 會以
/// [`connection::HelloRejectReason::VersionMismatch`] 拒絕版本不同的 Runner。
pub const PROTOCOL_VERSION: u32 = 1;

/// Server 上給 Runner 連線的 WebSocket 路徑，例如 `ws://localhost:4000/runner`。
pub const RUNNER_WS_PATH: &str = "/runner";

/// Runner 上傳 blob 的 HTTP 路徑前綴（ARCHITECTURE §14）：
/// `PUT <server><RUNNER_BLOB_PATH>/<blob_id>?run_id=<run_id>&sha256=<sha256>`，
/// 以 `Authorization: Bearer <Runner token>` 認證，body 是 blob 的原始內容。
/// Server 驗證 SHA-256 與大小；上傳成功後 Runner 才送出參照它的 Event。
pub const RUNNER_BLOB_PATH: &str = "/api/runner/blobs";
