//! Run 的 Preview（ARCHITECTURE §13）：依 `[preview].command` 啟動 dev server、判斷就緒、
//! 隨 Run 結束，並經由 Runner 連線把 Team 成員的請求轉送給 dev server。這個目錄屬於 E 軌。

mod process;
mod registry;
mod relay;
pub mod wire;

pub use process::{
    Preview, PreviewNotice, PreviewSpec, PreviewStopReason, PreviewTiming, local_url,
};
pub use registry::{PreviewRegistry, Registration, RegistrationGuard};
pub use relay::{Outbound, PreviewRelay, upstream_headers};
