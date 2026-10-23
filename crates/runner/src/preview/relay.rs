//! Preview 的轉送（ARCHITECTURE §13「轉送」、ADR-0010）：Server 經由 Runner 連線送來的每個
//! HTTP 請求或 WebSocket 是一條 stream，Runner 連到該 Run 的 `localhost:<port>` 轉送。
//!
//! - 每條 stream 一個 task；relay 只負責分派訊息與限制。
//! - **背壓**：送往 Server 的資料最多送出 Server 給的 credit；Server 送來的資料寫給 dev server
//!   之後才補 credit 給 Server。所有 stream 共用一個有上限的送出 channel，連線送不出去時
//!   stream 會停下來等。
//! - `Host`、`Origin` 改寫成 `localhost:<port>`，原本的 Host 放在 `X-Forwarded-Host`，
//!   dev server 因此視為本機請求（Vite 的 `allowedHosts`、Next.js 的 `allowedDevOrigins`）。

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Either, Empty, StreamBody};
use hyper::body::Frame;
use hyper_util::rt::TokioIo;
use orbis_protocol::ids::RunId;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tracing::debug;

use super::registry::PreviewRegistry;
use super::wire::{
    PREVIEW_INITIAL_WINDOW, PREVIEW_MAX_CHUNK, PREVIEW_MAX_STREAMS_PER_RUN, PREVIEW_MAX_WS_MESSAGE,
    PreviewData, PreviewDataKind, PreviewEnd, PreviewFromServer, PreviewHeaders, PreviewOpen,
    PreviewReset, PreviewResetReason, PreviewResponse, PreviewStreamKind, PreviewToServer,
    PreviewWindow, PreviewWsClose,
};

/// 送出 channel 的容量（訊息數）。每則最多 64 KiB，所以最多約 4 MiB 等著送出。
const OUTBOUND_CAPACITY: usize = 64;
/// 連 dev server 的時限。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// WebSocket 的 close code：訊息太大。
const CLOSE_MESSAGE_TOO_BIG: u16 = 1009;

/// 要送給 Server 的訊息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outbound {
    /// JSON 控制 frame。
    Text(String),
    /// binary 資料訊息。
    Binary(Vec<u8>),
}

impl Outbound {
    fn frame(frame: &PreviewToServer) -> Self {
        let frame = orbis_protocol::frame::RunnerToServer::from(frame.clone());
        Self::Text(serde_json::to_string(&frame).expect("preview frame 一定能序列化"))
    }

    fn data(kind: PreviewDataKind, stream_id: u32, payload: &[u8]) -> Self {
        Self::Binary(
            PreviewData {
                kind,
                stream_id,
                payload,
            }
            .encode(),
        )
    }
}

/// Server 送給某條 stream 的訊息。
#[derive(Debug)]
enum Input {
    Data(PreviewDataKind, Bytes),
    End,
    Window(u32),
    WsClose(u16, String),
    Reset,
}

struct StreamEntry {
    run_id: RunId,
    input: mpsc::UnboundedSender<Input>,
    /// Server 還能送給 Runner 的 credit；超過時是協定錯誤。
    inbound_credit: Arc<AtomicI64>,
    task: JoinHandle<()>,
}

/// 一條 Runner 連線上的 Preview 轉送。連線結束時 drop，所有 stream 一起結束。
pub struct PreviewRelay {
    registry: Arc<PreviewRegistry>,
    out: mpsc::Sender<Outbound>,
    streams: HashMap<u32, StreamEntry>,
}

impl Drop for PreviewRelay {
    fn drop(&mut self) {
        for entry in self.streams.values() {
            entry.task.abort();
        }
    }
}

impl PreviewRelay {
    /// 建立 relay；回傳的 receiver 是要送給 Server 的訊息（優先順序低於 Event 與 control）。
    pub fn new(registry: Arc<PreviewRegistry>) -> (Self, mpsc::Receiver<Outbound>) {
        let (out, rx) = mpsc::channel(OUTBOUND_CAPACITY);
        (
            Self {
                registry,
                out,
                streams: HashMap::new(),
            },
            rx,
        )
    }

    /// 處理 Server 送來的控制 frame。
    pub fn handle_frame(&mut self, frame: PreviewFromServer) {
        self.prune();
        match frame {
            PreviewFromServer::PreviewOpen(open) => self.open(open),
            PreviewFromServer::PreviewWindow(w) => {
                self.deliver(w.stream_id, Input::Window(w.credit))
            }
            PreviewFromServer::PreviewEnd(e) => self.deliver(e.stream_id, Input::End),
            PreviewFromServer::PreviewWsClose(c) => {
                self.deliver(c.stream_id, Input::WsClose(c.code, c.reason));
            }
            PreviewFromServer::PreviewReset(r) => {
                if let Some(entry) = self.streams.remove(&r.stream_id) {
                    let _ = entry.input.send(Input::Reset);
                }
            }
        }
    }

    /// 處理 Server 送來的 binary 資料訊息。
    pub fn handle_data(&mut self, bytes: &[u8]) {
        let Ok(data) = PreviewData::decode(bytes) else {
            debug!("無法解析的 preview 資料，略過");
            return;
        };
        let Some(entry) = self.streams.get(&data.stream_id) else {
            // stream 已經結束（例如剛被 reset），之後到的資料丟棄
            return;
        };
        let len = i64::try_from(data.payload.len()).unwrap_or(i64::MAX);
        if entry.inbound_credit.fetch_sub(len, Ordering::AcqRel) < len {
            self.reset(
                data.stream_id,
                PreviewResetReason::ProtocolError,
                "送來的資料超過 credit",
            );
            return;
        }
        let payload = Bytes::copy_from_slice(data.payload);
        self.deliver(data.stream_id, Input::Data(data.kind, payload));
    }

    /// 目前開著的 stream 數（測試用）。
    pub fn open_streams(&mut self) -> usize {
        self.prune();
        self.streams.len()
    }

    fn open(&mut self, open: PreviewOpen) {
        let stream_id = open.stream_id;
        if self.streams.contains_key(&stream_id) {
            self.reset(
                stream_id,
                PreviewResetReason::ProtocolError,
                "stream_id 重複",
            );
            return;
        }
        let Some(port) = self.registry.port(&open.run_id) else {
            self.reset(
                stream_id,
                PreviewResetReason::NotRunning,
                "這個 Run 的 Preview 沒有在這台 Runner 上執行",
            );
            return;
        };
        let per_run = self
            .streams
            .values()
            .filter(|e| e.run_id == open.run_id)
            .count();
        if per_run >= PREVIEW_MAX_STREAMS_PER_RUN as usize {
            self.reset(
                stream_id,
                PreviewResetReason::TooManyStreams,
                "同時開啟的請求太多",
            );
            return;
        }
        let (input, rx) = mpsc::unbounded_channel();
        let inbound_credit = Arc::new(AtomicI64::new(PREVIEW_INITIAL_WINDOW.into()));
        let stream = Stream {
            id: stream_id,
            port,
            out: self.out.clone(),
            rx,
            outbound_credit: open.window,
            inbound_credit: inbound_credit.clone(),
        };
        let run_id = open.run_id.clone();
        let task = tokio::spawn(async move {
            let id = stream.id;
            let out = stream.out.clone();
            let result = match open.kind {
                PreviewStreamKind::Http => stream.http(open).await,
                PreviewStreamKind::Websocket => stream.websocket(open).await,
            };
            if let Err(Failure(reason, message)) = result {
                debug!(stream_id = id, ?reason, %message, "preview stream 中止");
                let _ = out
                    .send(Outbound::frame(&PreviewToServer::PreviewReset(
                        PreviewReset {
                            stream_id: id,
                            reason,
                            message,
                        },
                    )))
                    .await;
            }
        });
        self.streams.insert(
            stream_id,
            StreamEntry {
                run_id,
                input,
                inbound_credit,
                task,
            },
        );
    }

    fn deliver(&mut self, stream_id: u32, input: Input) {
        if let Some(entry) = self.streams.get(&stream_id)
            && entry.input.send(input).is_err()
        {
            self.streams.remove(&stream_id);
        }
    }

    /// 中止 stream 並通知 Server。
    fn reset(&mut self, stream_id: u32, reason: PreviewResetReason, message: &str) {
        if let Some(entry) = self.streams.remove(&stream_id) {
            entry.task.abort();
        }
        let frame = Outbound::frame(&PreviewToServer::PreviewReset(PreviewReset {
            stream_id,
            reason,
            message: message.to_owned(),
        }));
        // 送出 channel 滿時在背景送，不擋住收訊息的迴圈
        if let Err(mpsc::error::TrySendError::Full(frame)) = self.out.try_send(frame) {
            let out = self.out.clone();
            tokio::spawn(async move {
                let _ = out.send(frame).await;
            });
        }
    }

    /// 移除已經結束的 stream。
    fn prune(&mut self) {
        self.streams.retain(|_, entry| !entry.task.is_finished());
    }
}

/// stream 中止的原因（送給 Server 的 `preview_reset`）。
struct Failure(PreviewResetReason, String);

impl Failure {
    fn upstream(message: impl Into<String>) -> Self {
        Self(PreviewResetReason::UpstreamError, message.into())
    }

    /// Server 中止或連線結束：不必再通知 Server。
    fn gone() -> Self {
        Self(PreviewResetReason::Canceled, String::new())
    }
}

type StreamResult = Result<(), Failure>;

struct Stream {
    id: u32,
    port: u16,
    out: mpsc::Sender<Outbound>,
    rx: mpsc::UnboundedReceiver<Input>,
    /// 還能送給 Server 的 byte 數。
    outbound_credit: u32,
    inbound_credit: Arc<AtomicI64>,
}

/// 轉送時不帶過去的 hop-by-hop header（RFC 9110 §7.6.1）與 WebSocket 交握由 client 自己產生的 header。
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
const WS_HANDSHAKE: &[&str] = &[
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-accept",
];

/// 轉給 dev server 的 header：移除 hop-by-hop，改寫 Host、Origin，原本的 Host 放進 X-Forwarded-Host。
///
/// Origin 只有在和原本的 Host 同一個 host 時才改寫（同一個 Preview 網址的頁面發出的請求）；
/// 其他 origin 原樣轉送，讓 dev server 自己的檢查擋下（Server 也會先擋下跨 origin 的請求）。
/// `X-Forwarded-Host` 一律由 Runner 依 Host 設定，不採用請求中帶來的值。
pub fn upstream_headers(headers: &PreviewHeaders, port: u16, websocket: bool) -> PreviewHeaders {
    let local = format!("localhost:{port}");
    let original_host = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.to_ascii_lowercase());
    let mut out = Vec::with_capacity(headers.len() + 2);
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if HOP_BY_HOP.contains(&lower.as_str())
            || (websocket && WS_HANDSHAKE.contains(&lower.as_str()))
        {
            continue;
        }
        match lower.as_str() {
            "host" | "x-forwarded-host" => {}
            "origin" => {
                let same = original_host
                    .as_deref()
                    .is_some_and(|host| origin_host(value).as_deref() == Some(host));
                let origin = if same {
                    format!("http://{local}")
                } else {
                    value.clone()
                };
                out.push((name.clone(), origin));
            }
            _ => out.push((name.clone(), value.clone())),
        }
    }
    if !websocket {
        out.insert(0, ("host".to_owned(), local));
    }
    if let Some(host) = original_host {
        out.push(("x-forwarded-host".to_owned(), host));
    }
    out
}

/// Origin（`scheme://host[:port]`）的 host 部分，小寫。
fn origin_host(origin: &str) -> Option<String> {
    let (_, rest) = origin.split_once("://")?;
    (!rest.is_empty() && !rest.contains('/')).then(|| rest.to_ascii_lowercase())
}

/// 轉回給 Server 的回應 header：移除 hop-by-hop。
fn downstream_headers<'a>(headers: impl Iterator<Item = (&'a str, &'a [u8])>) -> PreviewHeaders {
    headers
        .filter(|(name, _)| !HOP_BY_HOP.contains(&name.to_ascii_lowercase().as_str()))
        .map(|(name, value)| (name.to_owned(), String::from_utf8_lossy(value).into_owned()))
        .collect()
}

/// 連到 dev server：先試 IPv4 再試 IPv6（dev server 可能只綁 `::1`）。
async fn connect(port: u16) -> Result<TcpStream, Failure> {
    let mut last = None;
    for addr in [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ] {
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(e)) => last = Some(e.to_string()),
            Err(_) => last = Some("逾時".to_owned()),
        }
    }
    Err(Failure::upstream(format!(
        "連不上 dev server（port {port}）：{}",
        last.unwrap_or_default()
    )))
}

impl Stream {
    async fn send(&self, outbound: Outbound) -> StreamResult {
        self.out.send(outbound).await.map_err(|_| Failure::gone())
    }

    async fn send_frame(&self, frame: PreviewToServer) -> StreamResult {
        self.send(Outbound::frame(&frame)).await
    }

    /// 資料已經交給 dev server：補 credit 給 Server。
    async fn grant(&self, len: usize) -> StreamResult {
        if len == 0 {
            return Ok(());
        }
        let credit = u32::try_from(len).unwrap_or(u32::MAX);
        self.inbound_credit
            .fetch_add(i64::from(credit), Ordering::AcqRel);
        self.send_frame(PreviewToServer::PreviewWindow(PreviewWindow {
            stream_id: self.id,
            credit,
        }))
        .await
    }

    /// 處理等待 credit 時收到的訊息；`Data` 與 `WsClose` 交給 `pending`（呼叫端之後處理）。
    fn on_waiting_input(&mut self, input: Option<Input>, pending: &mut Vec<Input>) -> StreamResult {
        match input {
            None | Some(Input::Reset) => Err(Failure::gone()),
            Some(Input::Window(credit)) => {
                self.outbound_credit = self.outbound_credit.saturating_add(credit);
                Ok(())
            }
            Some(other) => {
                pending.push(other);
                Ok(())
            }
        }
    }

    /// 送出資料給 Server，依 credit 與 chunk 上限切開；`last_kind` 是最後一段的種類，
    /// 前面各段是 `more_kind`（HTTP body 都是 `body`；大 WebSocket 訊息前面是 `ws_fragment`）。
    async fn send_data(
        &mut self,
        more_kind: PreviewDataKind,
        last_kind: PreviewDataKind,
        data: &[u8],
        pending: &mut Vec<Input>,
    ) -> StreamResult {
        let mut offset = 0;
        loop {
            let remaining = data.len() - offset;
            if remaining > 0 && self.outbound_credit == 0 {
                let input = self.rx.recv().await;
                self.on_waiting_input(input, pending)?;
                continue;
            }
            let credit = usize::try_from(self.outbound_credit).unwrap_or(usize::MAX);
            let size = remaining.min(PREVIEW_MAX_CHUNK).min(credit);
            let last = offset + size == data.len();
            let kind = if last { last_kind } else { more_kind };
            self.send(Outbound::data(kind, self.id, &data[offset..offset + size]))
                .await?;
            self.outbound_credit -= u32::try_from(size).unwrap_or(u32::MAX);
            offset += size;
            if last {
                return Ok(());
            }
        }
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    async fn http(mut self, open: PreviewOpen) -> StreamResult {
        let tcp = connect(self.port).await?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tcp))
            .await
            .map_err(|e| Failure::upstream(format!("和 dev server 交握失敗：{e}")))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });

        let headers = upstream_headers(&open.headers, self.port, false);
        let has_body = headers.iter().any(|(name, value)| {
            let name = name.to_ascii_lowercase();
            (name == "content-length" && value.trim() != "0") || name == "transfer-encoding"
        });
        let mut builder = hyper::Request::builder()
            .method(open.method.as_str())
            .uri(open.path.as_str());
        for (name, value) in &headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        // 有 body 時以 channel 串流給 hyper：hyper 寫出一段才收下一段，寫出後才補 credit
        let (body_tx, body_rx) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(1);
        let body = if has_body {
            Either::Right(StreamBody::new(tokio_stream_from(body_rx)))
        } else {
            drop(body_rx);
            Either::Left(Empty::<Bytes>::new())
        };
        let request = builder.body(body).map_err(|e| {
            Failure(
                PreviewResetReason::ProtocolError,
                format!("請求不合法：{e}"),
            )
        })?;

        // 等回應的同時，把 Server 送來的 request body 交給 hyper
        let mut body_tx = has_body.then_some(body_tx);
        let mut pending = Vec::new();
        let response = sender.send_request(request);
        tokio::pin!(response);
        let response = loop {
            tokio::select! {
                response = &mut response => {
                    break response.map_err(|e| Failure::upstream(format!("dev server 沒有回應：{e}")))?;
                }
                input = self.rx.recv() => match input {
                    Some(Input::Data(PreviewDataKind::Body, bytes)) => {
                        let len = bytes.len();
                        if let Some(tx) = &body_tx
                            && tx.send(Ok(Frame::data(bytes))).await.is_err()
                        {
                            body_tx = None;
                        }
                        self.grant(len).await?;
                    }
                    Some(Input::End) => body_tx = None,
                    other => self.on_waiting_input(other, &mut pending)?,
                },
            }
        };
        drop(body_tx);

        let status = response.status().as_u16();
        let response_headers = downstream_headers(
            response
                .headers()
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_bytes())),
        );
        self.send_frame(PreviewToServer::PreviewResponse(PreviewResponse {
            stream_id: self.id,
            status,
            headers: response_headers,
        }))
        .await?;

        let mut body = response.into_body();
        loop {
            tokio::select! {
                frame = body.frame() => match frame {
                    None => break,
                    Some(Err(e)) => return Err(Failure::upstream(format!("讀取 dev server 的回應失敗：{e}"))),
                    Some(Ok(frame)) => {
                        if let Ok(data) = frame.into_data() {
                            self.send_data(PreviewDataKind::Body, PreviewDataKind::Body, &data, &mut pending)
                                .await?;
                        }
                    }
                },
                input = self.rx.recv() => self.on_waiting_input(input, &mut pending)?,
            }
        }
        self.send_frame(PreviewToServer::PreviewEnd(PreviewEnd {
            stream_id: self.id,
        }))
        .await
    }

    // ── WebSocket ───────────────────────────────────────────────────────────

    async fn websocket(mut self, open: PreviewOpen) -> StreamResult {
        let tcp = connect(self.port).await?;
        let mut request = format!("ws://localhost:{}{}", self.port, open.path)
            .into_client_request()
            .map_err(|e| {
                Failure(
                    PreviewResetReason::ProtocolError,
                    format!("請求不合法：{e}"),
                )
            })?;
        for (name, value) in upstream_headers(&open.headers, self.port, true) {
            let lower = name.to_ascii_lowercase();
            if lower == "host" {
                continue;
            }
            if let (Ok(name), Ok(value)) = (
                hyper::header::HeaderName::from_bytes(lower.as_bytes()),
                hyper::header::HeaderValue::from_str(&value),
            ) {
                request.headers_mut().append(name, value);
            }
        }
        let (ws, response) = tokio_tungstenite::client_async(request, tcp)
            .await
            .map_err(|e| Failure::upstream(format!("dev server 拒絕 WebSocket：{e}")))?;
        let headers = response
            .headers()
            .get_all("sec-websocket-protocol")
            .iter()
            .map(|v| {
                (
                    "sec-websocket-protocol".to_owned(),
                    String::from_utf8_lossy(v.as_bytes()).into_owned(),
                )
            })
            .collect();
        self.send_frame(PreviewToServer::PreviewResponse(PreviewResponse {
            stream_id: self.id,
            status: 101,
            headers,
        }))
        .await?;

        let (mut sink, mut upstream) = ws.split();
        let mut pending: Vec<Input> = Vec::new();
        let mut fragments: Vec<u8> = Vec::new();
        loop {
            // 等 credit 時暫存的訊息先處理
            let input = if pending.is_empty() {
                tokio::select! {
                    message = upstream.next() => {
                        match message {
                            None => return self.ws_closed(1006, "dev server 中斷連線").await,
                            Some(Err(e)) => return self.ws_closed(1006, &e.to_string()).await,
                            Some(Ok(Message::Text(text))) => {
                                self.send_data(PreviewDataKind::WsFragment, PreviewDataKind::WsText, text.as_bytes(), &mut pending).await?;
                            }
                            Some(Ok(Message::Binary(data))) => {
                                self.send_data(PreviewDataKind::WsFragment, PreviewDataKind::WsBinary, &data, &mut pending).await?;
                            }
                            Some(Ok(Message::Close(frame))) => {
                                let (code, reason) = frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string()));
                                return self.ws_closed(code, &reason).await;
                            }
                            Some(Ok(_)) => {}
                        }
                        continue;
                    }
                    input = self.rx.recv() => input,
                }
            } else {
                Some(pending.remove(0))
            };
            match input {
                None | Some(Input::Reset) => return Err(Failure::gone()),
                Some(Input::Window(credit)) => {
                    self.outbound_credit = self.outbound_credit.saturating_add(credit);
                }
                Some(Input::End) => {}
                Some(Input::WsClose(code, reason)) => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code: CloseCode::from(code),
                            reason: reason.into(),
                        })))
                        .await;
                    return Ok(());
                }
                Some(Input::Data(kind, bytes)) => {
                    let len = bytes.len();
                    match kind {
                        PreviewDataKind::WsFragment => {
                            if fragments.len() + len > PREVIEW_MAX_WS_MESSAGE {
                                let _ = sink.send(Message::Close(None)).await;
                                return self.ws_closed(CLOSE_MESSAGE_TOO_BIG, "訊息太大").await;
                            }
                            fragments.extend_from_slice(&bytes);
                        }
                        PreviewDataKind::WsText | PreviewDataKind::WsBinary => {
                            let whole = if fragments.is_empty() {
                                bytes.to_vec()
                            } else {
                                let mut whole = std::mem::take(&mut fragments);
                                whole.extend_from_slice(&bytes);
                                whole
                            };
                            let message = if kind == PreviewDataKind::WsText {
                                match String::from_utf8(whole) {
                                    Ok(text) => Message::text(text),
                                    Err(_) => {
                                        return Err(Failure(
                                            PreviewResetReason::ProtocolError,
                                            "ws_text 不是 UTF-8".into(),
                                        ));
                                    }
                                }
                            } else {
                                Message::binary(whole)
                            };
                            sink.send(message).await.map_err(|e| {
                                Failure::upstream(format!("送給 dev server 失敗：{e}"))
                            })?;
                        }
                        PreviewDataKind::Body => {
                            return Err(Failure(
                                PreviewResetReason::ProtocolError,
                                "WebSocket stream 收到 body 資料".into(),
                            ));
                        }
                    }
                    self.grant(len).await?;
                }
            }
        }
    }

    /// dev server 端的 WebSocket 關閉了：通知 Server。
    async fn ws_closed(&self, code: u16, reason: &str) -> StreamResult {
        self.send_frame(PreviewToServer::PreviewWsClose(PreviewWsClose {
            stream_id: self.id,
            code,
            reason: close_reason(reason),
        }))
        .await
    }
}

/// WebSocket close reason 的上限是 123 bytes（UTF-8），依字元截斷，不切開多 byte 的字。
fn close_reason(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if out.len() + ch.len_utf8() > 123 {
            break;
        }
        out.push(ch);
    }
    out
}

/// mpsc receiver 轉成 hyper 的 body stream。
fn tokio_stream_from<T: Send + 'static>(
    mut rx: mpsc::Receiver<T>,
) -> impl futures_util::Stream<Item = T> + Send + 'static {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> PreviewHeaders {
        pairs
            .iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn 改寫_host_與_origin_並移除_hop_by_hop() {
        let headers = upstream_headers(
            &h(&[
                ("Host", "r1.preview.example.com"),
                ("Origin", "https://r1.preview.example.com"),
                ("Connection", "keep-alive"),
                ("Cookie", "a=1"),
                ("Accept", "text/html"),
            ]),
            4100,
            false,
        );
        assert_eq!(
            headers,
            h(&[
                ("host", "localhost:4100"),
                ("Origin", "http://localhost:4100"),
                ("Cookie", "a=1"),
                ("Accept", "text/html"),
                ("x-forwarded-host", "r1.preview.example.com"),
            ])
        );
    }

    #[test]
    fn 其他_origin_不改寫_x_forwarded_host_不採用請求帶來的值() {
        let headers = upstream_headers(
            &h(&[
                ("Host", "r1.preview.example.com"),
                ("Origin", "https://r2.preview.example.com"),
                ("X-Forwarded-Host", "evil.example.com"),
                ("X-Forwarded-Proto", "https"),
            ]),
            4100,
            true,
        );
        assert_eq!(
            headers,
            h(&[
                ("Origin", "https://r2.preview.example.com"),
                ("X-Forwarded-Proto", "https"),
                ("x-forwarded-host", "r1.preview.example.com"),
            ])
        );
        assert_eq!(origin_host("null"), None);
        assert_eq!(origin_host("https://a.b/c"), None);
    }

    #[test]
    fn close_reason_依_utf8_bytes_截斷() {
        let reason = close_reason(&"中".repeat(100));
        assert_eq!(reason.len(), 123);
        assert_eq!(close_reason("ok"), "ok");
    }

    #[test]
    fn websocket_交握的_header_由_client_自己產生() {
        let headers = upstream_headers(
            &h(&[
                ("Host", "r1.preview.example.com"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "abc"),
                ("Sec-WebSocket-Version", "13"),
                ("Sec-WebSocket-Protocol", "vite-hmr"),
            ]),
            4100,
            true,
        );
        assert_eq!(
            headers,
            h(&[
                ("Sec-WebSocket-Protocol", "vite-hmr"),
                ("x-forwarded-host", "r1.preview.example.com"),
            ])
        );
    }
}
