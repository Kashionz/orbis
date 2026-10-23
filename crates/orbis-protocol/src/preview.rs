//! Preview 的多工通道（ARCHITECTURE §13、ADR-0010）。
//!
//! Server 把 Team 成員對 Preview 網址的 HTTP 與 WebSocket 請求，經由既有的 Runner 連線轉給
//! Runner，Runner 再連到該 Run 的 `localhost:<port>`。每個請求是一個 stream，以 `stream_id`
//! 區分（由 Server 產生，在同一條 Runner 連線內唯一）。
//!
//! - 控制訊息是一般的 JSON frame：`preview_open`（Server→Runner）、`preview_response`
//!   （Runner→Server），以及雙向的 `preview_window`、`preview_end`、`preview_reset`、
//!   `preview_ws_close`。
//! - 資料（HTTP body、WebSocket 訊息）走 **WebSocket binary 訊息**，格式見 [`PreviewData`]：
//!   `[kind u8][stream_id u32 big-endian][payload]`。
//! - **背壓**：以 credit 控制，雙向各自計算。送出的一方對每個 stream 最多送出對方給的 credit
//!   （初始值是 `preview_open` 的 `window`，預設 [`PREVIEW_INITIAL_WINDOW`]），收到
//!   `preview_window` 後再加上 `credit`。接收的一方把資料交出去（寫進 socket 或 HTTP 回應）
//!   之後才補 credit。單一 binary 訊息的 payload 最多 [`PREVIEW_MAX_CHUNK`]。
//! - `path` 是 dev server 端的路徑（含 query），與 Preview 網址的形式無關。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::wire_enum;
use crate::ids::RunId;

/// 每個 stream 每個方向的初始 credit，單位是 byte。
pub const PREVIEW_INITIAL_WINDOW: u32 = 256 * 1024;

/// 單一 binary 訊息的 payload 上限，單位是 byte。
pub const PREVIEW_MAX_CHUNK: usize = 64 * 1024;

/// 每個 Run 同時開啟的 stream 上限；超過時 Runner 以 `preview_reset`（`too_many_streams`）拒絕。
pub const PREVIEW_MAX_STREAMS_PER_RUN: u32 = 256;

/// binary 訊息 header 的長度（kind 1 byte、stream_id 4 byte）。
pub const PREVIEW_DATA_HEADER_LEN: usize = 5;

/// HTTP 或 WebSocket 的 header，依原本的順序，同名的 header 可以出現多次。
pub type PreviewHeaders = Vec<(String, String)>;

/// 開啟一個 stream（Server→Runner）。HTTP 的 request body 接著以 `body` 資料送出，
/// 送完以 `preview_end` 結束。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PreviewOpen {
    pub stream_id: u32,
    pub run_id: RunId,
    pub kind: PreviewStreamKind,
    /// HTTP method；WebSocket 為 `GET`。
    pub method: String,
    /// dev server 端的路徑，含 query，例如 `/src/main.ts?t=1`。
    pub path: String,
    /// 轉送的 header（Server 已移除 Orbis 自己的 cookie）。Runner 會改寫 `Host` 與 `Origin`。
    pub headers: PreviewHeaders,
    /// Server 給 Runner 的初始 credit（Runner→Server 方向的資料）。
    pub window: u32,
}

wire_enum! {
    PreviewStreamKind {
        Http => "http",
        /// WebSocket（包含 HMR）。Runner 連上後以 `preview_response`（101）回覆。
        Websocket => "websocket",
    }
}

/// dev server 的回應標頭（Runner→Server）。HTTP 的 body 接著以 `body` 資料送出，
/// 送完以 `preview_end` 結束；WebSocket 回 101 後雙向以 `ws_text`／`ws_binary` 傳訊息。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PreviewResponse {
    pub stream_id: u32,
    pub status: u16,
    pub headers: PreviewHeaders,
}

/// 增加對方可以送出的 credit（雙向）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PreviewWindow {
    pub stream_id: u32,
    /// 增加的 byte 數。
    pub credit: u32,
}

/// 這個方向的資料已經送完（雙向；HTTP 用）。兩個方向都結束後 stream 關閉。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PreviewEnd {
    pub stream_id: u32,
}

/// 立刻中止 stream（雙向），之後收到的資料一律丟棄。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PreviewReset {
    pub stream_id: u32,
    pub reason: PreviewResetReason,
    /// 給人看的說明（已遮蔽 secret）。
    pub message: String,
}

wire_enum! {
    /// stream 被中止的理由。
    /// 彈性：之後可能增加代碼，接收端遇到不認得的值要當成 `upstream_error`。
    PreviewResetReason {
        /// 使用者端斷線，或 Server 取消請求。
        Canceled => "canceled",
        /// 連不上 dev server，或 dev server 中途斷線。
        UpstreamError => "upstream_error",
        /// 這個 Run 不在這台 Runner 上，或 Preview 沒有在執行。
        NotRunning => "not_running",
        /// 超過 [`PREVIEW_MAX_STREAMS_PER_RUN`]。
        TooManyStreams => "too_many_streams",
        /// 收到不合規則的訊息，例如超過 credit 或不存在的 stream。
        ProtocolError => "protocol_error",
    }
}

/// 關閉 WebSocket stream（雙向），對應 WebSocket 的 close frame。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PreviewWsClose {
    pub stream_id: u32,
    pub code: u16,
    pub reason: String,
}

/// binary 訊息中的資料種類。值是 header 第一個 byte。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum PreviewDataKind {
    /// HTTP 的 request 或 response body。
    Body = 0,
    /// WebSocket 的文字訊息（UTF-8）。
    WsText = 1,
    /// WebSocket 的 binary 訊息。
    WsBinary = 2,
}

impl PreviewDataKind {
    pub const ALL: &'static [Self] = &[Self::Body, Self::WsText, Self::WsBinary];

    /// TS 常數中使用的名稱。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Body => "body",
            Self::WsText => "ws_text",
            Self::WsBinary => "ws_binary",
        }
    }

    pub const fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            0 => Some(Self::Body),
            1 => Some(Self::WsText),
            2 => Some(Self::WsBinary),
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

/// binary 訊息無法解析。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewDecodeError {
    /// 比 header 還短。
    TooShort,
    UnknownKind(u8),
    /// payload 超過 [`PREVIEW_MAX_CHUNK`]。
    TooLarge,
}

impl std::fmt::Display for PreviewDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooShort => f.write_str("preview 資料比 header 還短"),
            Self::UnknownKind(kind) => write!(f, "不認得的 preview 資料種類 {kind}"),
            Self::TooLarge => write!(f, "preview 資料超過 {PREVIEW_MAX_CHUNK} byte"),
        }
    }
}

impl std::error::Error for PreviewDecodeError {}

impl<'a> PreviewData<'a> {
    /// 編碼成一則 binary 訊息。payload 超過 [`PREVIEW_MAX_CHUNK`] 時，呼叫端要先切開。
    pub fn encode(&self) -> Vec<u8> {
        debug_assert!(self.payload.len() <= PREVIEW_MAX_CHUNK);
        let mut out = Vec::with_capacity(PREVIEW_DATA_HEADER_LEN + self.payload.len());
        out.push(self.kind as u8);
        out.extend_from_slice(&self.stream_id.to_be_bytes());
        out.extend_from_slice(self.payload);
        out
    }

    /// 解析一則 binary 訊息，payload 借用原本的 buffer。
    pub fn decode(bytes: &'a [u8]) -> Result<Self, PreviewDecodeError> {
        if bytes.len() < PREVIEW_DATA_HEADER_LEN {
            return Err(PreviewDecodeError::TooShort);
        }
        let kind = PreviewDataKind::from_byte(bytes[0])
            .ok_or(PreviewDecodeError::UnknownKind(bytes[0]))?;
        let stream_id = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        let payload = &bytes[PREVIEW_DATA_HEADER_LEN..];
        if payload.len() > PREVIEW_MAX_CHUNK {
            return Err(PreviewDecodeError::TooLarge);
        }
        Ok(Self {
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
    fn encode_then_decode_returns_the_same_data() {
        for kind in PreviewDataKind::ALL {
            let data = PreviewData {
                kind: *kind,
                stream_id: 0x0102_0304,
                payload: b"hello",
            };
            let bytes = data.encode();
            assert_eq!(&bytes[..5], &[*kind as u8, 1, 2, 3, 4]);
            assert_eq!(PreviewData::decode(&bytes), Ok(data));
        }
    }

    #[test]
    fn decode_rejects_malformed_messages() {
        assert_eq!(
            PreviewData::decode(&[0, 0, 0]),
            Err(PreviewDecodeError::TooShort)
        );
        assert_eq!(
            PreviewData::decode(&[9, 0, 0, 0, 1]),
            Err(PreviewDecodeError::UnknownKind(9))
        );
        let mut big = vec![0u8; PREVIEW_DATA_HEADER_LEN + PREVIEW_MAX_CHUNK + 1];
        big[0] = PreviewDataKind::Body as u8;
        assert_eq!(PreviewData::decode(&big), Err(PreviewDecodeError::TooLarge));
    }

    #[test]
    fn empty_payload_is_allowed() {
        let data = PreviewData {
            kind: PreviewDataKind::Body,
            stream_id: 7,
            payload: &[],
        };
        assert_eq!(PreviewData::decode(&data.encode()), Ok(data));
    }

    #[test]
    fn kind_bytes_match_their_names() {
        for kind in PreviewDataKind::ALL {
            assert_eq!(PreviewDataKind::from_byte(*kind as u8), Some(*kind));
        }
    }
}
