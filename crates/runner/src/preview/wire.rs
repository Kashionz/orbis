//! Preview 多工通道的訊息（ARCHITECTURE §13）：協定型別（`orbis_protocol::preview`）與
//! relay 收發的 frame 分類。

use orbis_protocol::frame::{RunnerToServer, ServerToRunner};
pub use orbis_protocol::preview::{
    PREVIEW_DATA_HEADER_LEN, PREVIEW_INITIAL_WINDOW, PREVIEW_MAX_CHUNK,
    PREVIEW_MAX_STREAMS_PER_RUN, PREVIEW_MAX_WS_MESSAGE, PreviewData, PreviewDataKind, PreviewEnd,
    PreviewHeaders, PreviewOpen, PreviewReset, PreviewResetReason, PreviewResponse,
    PreviewStreamKind, PreviewWindow, PreviewWsClose,
};

/// Server 送來的 preview 控制 frame。
#[derive(Debug, Clone, PartialEq)]
pub enum PreviewFromServer {
    PreviewOpen(PreviewOpen),
    PreviewWindow(PreviewWindow),
    PreviewEnd(PreviewEnd),
    PreviewReset(PreviewReset),
    PreviewWsClose(PreviewWsClose),
}

impl PreviewFromServer {
    /// 取出 preview 的 frame；其他 frame 原樣傳回（不另外配置，所以不 box）。
    #[allow(clippy::result_large_err)]
    pub fn from_frame(frame: ServerToRunner) -> Result<Self, ServerToRunner> {
        match frame {
            ServerToRunner::PreviewOpen(f) => Ok(Self::PreviewOpen(f)),
            ServerToRunner::PreviewWindow(f) => Ok(Self::PreviewWindow(f)),
            ServerToRunner::PreviewEnd(f) => Ok(Self::PreviewEnd(f)),
            ServerToRunner::PreviewReset(f) => Ok(Self::PreviewReset(f)),
            ServerToRunner::PreviewWsClose(f) => Ok(Self::PreviewWsClose(f)),
            other => Err(other),
        }
    }
}

/// Runner 送出的 preview 控制 frame。
#[derive(Debug, Clone, PartialEq)]
pub enum PreviewToServer {
    PreviewResponse(PreviewResponse),
    PreviewWindow(PreviewWindow),
    PreviewEnd(PreviewEnd),
    PreviewReset(PreviewReset),
    PreviewWsClose(PreviewWsClose),
}

impl From<PreviewToServer> for RunnerToServer {
    fn from(frame: PreviewToServer) -> Self {
        match frame {
            PreviewToServer::PreviewResponse(f) => Self::PreviewResponse(f),
            PreviewToServer::PreviewWindow(f) => Self::PreviewWindow(f),
            PreviewToServer::PreviewEnd(f) => Self::PreviewEnd(f),
            PreviewToServer::PreviewReset(f) => Self::PreviewReset(f),
            PreviewToServer::PreviewWsClose(f) => Self::PreviewWsClose(f),
        }
    }
}

impl PreviewToServer {
    /// 由 [`RunnerToServer`] 取出 preview 的 frame（測試解析 relay 送出的訊息用）。
    pub fn from_frame(frame: RunnerToServer) -> Option<Self> {
        match frame {
            RunnerToServer::PreviewResponse(f) => Some(Self::PreviewResponse(f)),
            RunnerToServer::PreviewWindow(f) => Some(Self::PreviewWindow(f)),
            RunnerToServer::PreviewEnd(f) => Some(Self::PreviewEnd(f)),
            RunnerToServer::PreviewReset(f) => Some(Self::PreviewReset(f)),
            RunnerToServer::PreviewWsClose(f) => Some(Self::PreviewWsClose(f)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_frame_與協定_frame_互相轉換() {
        let end = PreviewEnd { stream_id: 3 };
        assert_eq!(
            PreviewFromServer::from_frame(ServerToRunner::PreviewEnd(end.clone())),
            Ok(PreviewFromServer::PreviewEnd(end.clone()))
        );
        let frame = RunnerToServer::from(PreviewToServer::PreviewEnd(end.clone()));
        assert_eq!(frame.type_name(), "preview_end");
        assert_eq!(
            PreviewToServer::from_frame(frame),
            Some(PreviewToServer::PreviewEnd(end))
        );
    }
}
