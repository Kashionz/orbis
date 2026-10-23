//! Preview 多工通道的訊息（ARCHITECTURE §13）。
//!
//! TODO(contract): 契約 v2（#29）合併後，這個檔案的型別全部改用 `orbis_protocol::preview`，
//! frame 改用 `RunnerToServer`／`ServerToRunner` 的 preview 變體。名稱與欄位已照契約分支
//! （contract/w5-7 的 `crates/orbis-protocol/src/preview.rs`）的定義寫，合併後只需要換 import。

use orbis_protocol::ids::RunId;
use serde::{Deserialize, Serialize};

/// 每個 stream 每個方向的初始 credit。Runner 給 Server 的初始 credit 固定是這個值。
pub const PREVIEW_INITIAL_WINDOW: u32 = 256 * 1024;
/// 單一 binary 訊息的 payload 上限。
pub const PREVIEW_MAX_CHUNK: usize = 64 * 1024;
/// 每個 Run 同時開啟的 stream 上限。
pub const PREVIEW_MAX_STREAMS_PER_RUN: u32 = 256;
/// binary 訊息 header 的長度（kind 1 byte、stream_id 4 byte）。
pub const PREVIEW_DATA_HEADER_LEN: usize = 5;
/// 分段後組回的單則 WebSocket 訊息上限；超過時以 1009 關閉。
pub const PREVIEW_MAX_WS_MESSAGE: usize = 16 * 1024 * 1024;

pub type PreviewHeaders = Vec<(String, String)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewStreamKind {
    Http,
    Websocket,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewOpen {
    pub stream_id: u32,
    pub run_id: RunId,
    pub kind: PreviewStreamKind,
    pub method: String,
    pub path: String,
    pub headers: PreviewHeaders,
    pub window: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewResponse {
    pub stream_id: u32,
    pub status: u16,
    pub headers: PreviewHeaders,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewWindow {
    pub stream_id: u32,
    pub credit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewEnd {
    pub stream_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewResetReason {
    Canceled,
    UpstreamError,
    NotRunning,
    TooManyStreams,
    ProtocolError,
    /// 不認得的代碼一律當成 `upstream_error`。
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewReset {
    pub stream_id: u32,
    pub reason: PreviewResetReason,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewWsClose {
    pub stream_id: u32,
    pub code: u16,
    pub reason: String,
}

/// Server 送來的 preview 控制 frame。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PreviewFromServer {
    PreviewOpen(PreviewOpen),
    PreviewWindow(PreviewWindow),
    PreviewEnd(PreviewEnd),
    PreviewReset(PreviewReset),
    PreviewWsClose(PreviewWsClose),
}

/// Runner 送出的 preview 控制 frame。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PreviewToServer {
    PreviewResponse(PreviewResponse),
    PreviewWindow(PreviewWindow),
    PreviewEnd(PreviewEnd),
    PreviewReset(PreviewReset),
    PreviewWsClose(PreviewWsClose),
}

impl PreviewFromServer {
    /// 這段 JSON 是不是 preview 的控制 frame（`type` 以 `preview_` 開頭）。
    pub fn parse(text: &str) -> Option<serde_json::Result<Self>> {
        #[derive(Deserialize)]
        struct Type<'a> {
            #[serde(borrow, rename = "type")]
            ty: &'a str,
        }
        let ty: Type<'_> = serde_json::from_str(text).ok()?;
        ty.ty
            .starts_with("preview_")
            .then(|| serde_json::from_str(text))
    }
}

/// binary 訊息中的資料種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum PreviewDataKind {
    Body = 0,
    WsText = 1,
    WsBinary = 2,
    /// 超過 [`PREVIEW_MAX_CHUNK`] 的 WebSocket 訊息的前面各段；最後一段用 `ws_text`／`ws_binary`。
    // TODO(contract): 契約 v2 加入 `WsFragment = 3` 後改用（#29）。
    WsFragment = 3,
}

impl PreviewDataKind {
    pub const fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            0 => Some(Self::Body),
            1 => Some(Self::WsText),
            2 => Some(Self::WsBinary),
            3 => Some(Self::WsFragment),
            _ => None,
        }
    }
}

/// 一則 binary 訊息：`[kind u8][stream_id u32 big-endian][payload]`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewData<'a> {
    pub kind: PreviewDataKind,
    pub stream_id: u32,
    pub payload: &'a [u8],
}

impl<'a> PreviewData<'a> {
    pub fn encode(&self) -> Vec<u8> {
        debug_assert!(self.payload.len() <= PREVIEW_MAX_CHUNK);
        let mut out = Vec::with_capacity(PREVIEW_DATA_HEADER_LEN + self.payload.len());
        out.push(self.kind as u8);
        out.extend_from_slice(&self.stream_id.to_be_bytes());
        out.extend_from_slice(self.payload);
        out
    }

    pub fn decode(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < PREVIEW_DATA_HEADER_LEN {
            return None;
        }
        let kind = PreviewDataKind::from_byte(bytes[0])?;
        let stream_id = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        let payload = &bytes[PREVIEW_DATA_HEADER_LEN..];
        (payload.len() <= PREVIEW_MAX_CHUNK).then_some(Self {
            kind,
            stream_id,
            payload,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_的控制_frame_才會被認出來() {
        let open = r#"{"type":"preview_end","stream_id":3}"#;
        assert_eq!(
            PreviewFromServer::parse(open).unwrap().unwrap(),
            PreviewFromServer::PreviewEnd(PreviewEnd { stream_id: 3 })
        );
        assert!(PreviewFromServer::parse(r#"{"type":"event_ack"}"#).is_none());
        assert!(PreviewFromServer::parse("not json").is_none());
        assert!(
            PreviewFromServer::parse(r#"{"type":"preview_end"}"#)
                .unwrap()
                .is_err()
        );
    }

    #[test]
    fn 不認得的中止原因當成_unknown() {
        let reset: PreviewReset =
            serde_json::from_str(r#"{"stream_id":1,"reason":"new_reason","message":""}"#).unwrap();
        assert_eq!(reset.reason, PreviewResetReason::Unknown);
    }

    #[test]
    fn binary_訊息編碼後解得回來() {
        let data = PreviewData {
            kind: PreviewDataKind::WsText,
            stream_id: 0x0102_0304,
            payload: b"hi",
        };
        let bytes = data.encode();
        assert_eq!(&bytes[..5], &[1, 1, 2, 3, 4]);
        assert_eq!(PreviewData::decode(&bytes), Some(data));
        assert_eq!(PreviewData::decode(&[9, 0, 0, 0, 1]), None);
        assert_eq!(PreviewData::decode(&[0, 0]), None);
    }
}
