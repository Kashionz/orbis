//! Run 的 Preview（ARCHITECTURE §13）：依 `[preview].command` 啟動 dev server、判斷就緒、
//! 隨 Run 結束。這個目錄屬於 E 軌。

mod process;

pub use process::{
    Preview, PreviewNotice, PreviewSpec, PreviewStopReason, PreviewTiming, local_url,
};
