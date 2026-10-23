//! Preview 的轉送（ARCHITECTURE §13）：直接驅動 `PreviewRelay`，扮演 Server 送出 frame 與資料、
//! 依 credit 收資料；dev server 是這個測試自己開的 HTTP／WebSocket server。

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use orbis_protocol::ids::RunId;
use orbis_runner::preview::wire::{
    PREVIEW_INITIAL_WINDOW, PREVIEW_MAX_CHUNK, PreviewData, PreviewDataKind, PreviewEnd,
    PreviewFromServer, PreviewOpen, PreviewResetReason, PreviewStreamKind, PreviewToServer,
    PreviewWindow, PreviewWsClose,
};
use orbis_runner::preview::{Outbound, PreviewRegistry, PreviewRelay, Registration};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const BIG_LEN: usize = 5 * 1024 * 1024;
const RUN: &str = "0192f0c4-7a1b-7c3d-8e9f-0a1b2c3d4e5f";

/// 可重現的大檔案內容。
fn big_body() -> Vec<u8> {
    (0..BIG_LEN).map(|i| (i % 251) as u8).collect()
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// ── 測試用的 dev server ──────────────────────────────────────────────────────

/// 一個極簡的 dev server：
/// - `GET /hello`：`hello preview`
/// - `GET /headers`：收到的 header（JSON）
/// - `GET /big`：5 MiB 的內容
/// - `POST /echo`：回傳收到的 body 的長度與 SHA-256
/// - WebSocket `/ws`：文字訊息回 `pong:<訊息>`；`big` 回 200 KiB 的文字；binary 回傳長度；`close` 由 server 關閉
async fn start_dev_server() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve(stream));
        }
    });
    port
}

async fn serve(mut stream: TcpStream) {
    let mut peek = [0u8; 2048];
    let Ok(n) = stream.peek(&mut peek).await else {
        return;
    };
    let head = String::from_utf8_lossy(&peek[..n]).to_ascii_lowercase();
    if head.contains("upgrade: websocket") {
        serve_ws(stream).await;
        return;
    }
    // 讀完 header
    let mut buf = Vec::new();
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await.unwrap_or(0);
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default().to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(n, _)| n == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[header_end..].to_vec();
    while body.len() < length {
        let mut chunk = vec![0u8; 64 * 1024];
        let n = stream.read(&mut chunk).await.unwrap_or(0);
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let path = request_line.split(' ').nth(1).unwrap_or("/").to_owned();
    let (status, content_type, payload): (&str, &str, Vec<u8>) = match path.as_str() {
        "/hello" => ("200 OK", "text/plain", b"hello preview".to_vec()),
        "/headers" => {
            let map: HashMap<_, _> = headers.into_iter().collect();
            (
                "200 OK",
                "application/json",
                serde_json::to_vec(&map).unwrap(),
            )
        }
        "/big" => ("200 OK", "application/octet-stream", big_body()),
        "/echo" => (
            "200 OK",
            "text/plain",
            format!("{} {}", body.len(), sha(&body)).into_bytes(),
        ),
        _ => ("404 Not Found", "text/plain", b"not found".to_vec()),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nset-cookie: app=1\r\nconnection: close\r\n\r\n",
        payload.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.write_all(&payload).await;
    let _ = stream.shutdown().await;
}

// accept_hdr_async 的 callback 簽章由 tungstenite 決定，Err 的大小無法改
#[allow(clippy::result_large_err)]
async fn serve_ws(stream: TcpStream) {
    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(
        stream,
        |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
         mut res: tokio_tungstenite::tungstenite::handshake::server::Response| {
            if let Some(protocol) = req.headers().get("sec-websocket-protocol") {
                res.headers_mut()
                    .insert("sec-websocket-protocol", protocol.clone());
            }
            Ok(res)
        },
    )
    .await
    else {
        return;
    };
    while let Some(Ok(message)) = ws.next().await {
        let reply = match message {
            Message::Text(text) if text.as_str() == "big" => Message::text("x".repeat(200 * 1024)),
            Message::Text(text) if text.as_str() == "close" => {
                let _ = ws.close(None).await;
                return;
            }
            Message::Text(text) => Message::text(format!("pong:{text}")),
            Message::Binary(data) => Message::text(format!("binary:{}", data.len())),
            Message::Close(_) => return,
            _ => continue,
        };
        if ws.send(reply).await.is_err() {
            return;
        }
    }
}

// ── 扮演 Server ─────────────────────────────────────────────────────────────

struct FakeServer {
    relay: PreviewRelay,
    out: mpsc::Receiver<Outbound>,
    next_stream: u32,
    _registration: Option<orbis_runner::preview::RegistrationGuard>,
}

#[derive(Debug)]
enum Received {
    Frame(PreviewToServer),
    Data(PreviewDataKind, u32, Vec<u8>),
}

impl FakeServer {
    async fn new() -> Self {
        let port = start_dev_server().await;
        let registry = PreviewRegistry::new();
        let guard = Registration {
            registry: registry.clone(),
            run_id: RunId::from(RUN),
        }
        .register(port);
        let (relay, out) = PreviewRelay::new(registry);
        Self {
            relay,
            out,
            next_stream: 1,
            _registration: Some(guard),
        }
    }

    fn open(&mut self, kind: PreviewStreamKind, method: &str, path: &str, window: u32) -> u32 {
        self.open_for(RUN, kind, method, path, window, vec![])
    }

    fn open_for(
        &mut self,
        run: &str,
        kind: PreviewStreamKind,
        method: &str,
        path: &str,
        window: u32,
        headers: Vec<(String, String)>,
    ) -> u32 {
        let stream_id = self.next_stream;
        self.next_stream += 1;
        let mut all = vec![("Host".to_owned(), format!("{RUN}.preview.example.com"))];
        all.extend(headers);
        self.relay
            .handle_frame(PreviewFromServer::PreviewOpen(PreviewOpen {
                stream_id,
                run_id: RunId::from(run),
                kind,
                method: method.to_owned(),
                path: path.to_owned(),
                headers: all,
                window,
            }));
        stream_id
    }

    fn end(&mut self, stream_id: u32) {
        self.relay
            .handle_frame(PreviewFromServer::PreviewEnd(PreviewEnd { stream_id }));
    }

    fn window(&mut self, stream_id: u32, credit: u32) {
        self.relay
            .handle_frame(PreviewFromServer::PreviewWindow(PreviewWindow {
                stream_id,
                credit,
            }));
    }

    fn data(&mut self, kind: PreviewDataKind, stream_id: u32, payload: &[u8]) {
        self.relay.handle_data(
            &PreviewData {
                kind,
                stream_id,
                payload,
            }
            .encode(),
        );
    }

    async fn recv(&mut self) -> Received {
        let outbound = tokio::time::timeout(Duration::from_secs(15), self.out.recv())
            .await
            .expect("等不到 relay 送出的訊息")
            .expect("relay 的送出 channel 已關閉");
        match outbound {
            Outbound::Text(text) => Received::Frame(serde_json::from_str(&text).unwrap()),
            Outbound::Binary(bytes) => {
                let data = PreviewData::decode(&bytes).expect("binary 訊息格式正確");
                Received::Data(data.kind, data.stream_id, data.payload.to_vec())
            }
        }
    }

    /// 等一小段時間；沒有訊息時回傳 None。
    async fn try_recv(&mut self) -> Option<Received> {
        match tokio::time::timeout(Duration::from_millis(400), self.out.recv()).await {
            Err(_) => None,
            Ok(None) => panic!("relay 的送出 channel 已關閉"),
            Ok(Some(Outbound::Text(text))) => {
                Some(Received::Frame(serde_json::from_str(&text).unwrap()))
            }
            Ok(Some(Outbound::Binary(bytes))) => {
                let data = PreviewData::decode(&bytes).expect("binary 訊息格式正確");
                Some(Received::Data(
                    data.kind,
                    data.stream_id,
                    data.payload.to_vec(),
                ))
            }
        }
    }

    /// 等某條 stream 的 preview_reset。
    async fn reset_of(&mut self, stream_id: u32) -> PreviewResetReason {
        loop {
            if let Received::Frame(PreviewToServer::PreviewReset(r)) = self.recv().await
                && r.stream_id == stream_id
            {
                return r.reason;
            }
        }
    }

    /// 收完一個 HTTP 回應：每收到一段就補回同樣多的 credit（模擬寫給瀏覽器之後才補），
    /// 並檢查 Runner 從不超過 credit。`outstanding` 是目前 Runner 還能送的量。
    async fn http_response(
        &mut self,
        stream_id: u32,
        mut outstanding: u32,
    ) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut status = 0;
        let mut headers = vec![];
        let mut body = vec![];
        loop {
            match self.recv().await {
                Received::Frame(PreviewToServer::PreviewResponse(r)) => {
                    assert_eq!(r.stream_id, stream_id);
                    status = r.status;
                    headers = r.headers;
                }
                Received::Data(kind, id, payload) => {
                    assert_eq!((kind, id), (PreviewDataKind::Body, stream_id));
                    assert!(payload.len() <= PREVIEW_MAX_CHUNK);
                    let len = u32::try_from(payload.len()).unwrap();
                    assert!(len <= outstanding, "送出的資料超過 credit");
                    outstanding -= len;
                    body.extend_from_slice(&payload);
                    self.window(stream_id, len);
                    outstanding += len;
                }
                Received::Frame(PreviewToServer::PreviewEnd(e)) => {
                    assert_eq!(e.stream_id, stream_id);
                    return (status, headers, body);
                }
                other => panic!("預期 HTTP 回應，收到 {other:?}"),
            }
        }
    }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

// ── 測試 ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn http_請求轉給_dev_server_並改寫_host_與_origin() {
    let mut s = FakeServer::new().await;
    let id = s.open(
        PreviewStreamKind::Http,
        "GET",
        "/hello",
        PREVIEW_INITIAL_WINDOW,
    );
    s.end(id);
    let (status, headers, body) = s.http_response(id, PREVIEW_INITIAL_WINDOW).await;
    assert_eq!(status, 200);
    assert_eq!(body, b"hello preview");
    assert_eq!(header(&headers, "set-cookie"), Some("app=1"));
    assert_eq!(header(&headers, "connection"), None, "hop-by-hop 不轉回");

    let id = s.open_for(
        RUN,
        PreviewStreamKind::Http,
        "GET",
        "/headers",
        PREVIEW_INITIAL_WINDOW,
        vec![
            (
                "Origin".into(),
                format!("https://{RUN}.preview.example.com"),
            ),
            ("Cookie".into(), "app=1".into()),
        ],
    );
    s.end(id);
    let (_, _, body) = s.http_response(id, PREVIEW_INITIAL_WINDOW).await;
    let received: HashMap<String, String> = serde_json::from_slice(&body).unwrap();
    let port = received["host"].trim_start_matches("localhost:").to_owned();
    assert!(port.parse::<u16>().is_ok(), "{received:?}");
    assert_eq!(received["origin"], format!("http://localhost:{port}"));
    assert_eq!(
        received["x-forwarded-host"],
        format!("{RUN}.preview.example.com")
    );
    assert_eq!(received["cookie"], "app=1");
}

#[tokio::test]
async fn 大檔案依_credit_分段送出_沒有補_credit_就停下來() {
    let mut s = FakeServer::new().await;
    let window = 100 * 1024;
    let id = s.open(PreviewStreamKind::Http, "GET", "/big", window);
    s.end(id);
    // 先不補 credit：Runner 最多只送出 window 這麼多，然後停下來等
    let mut status = 0;
    let mut body = vec![];
    while let Some(received) = s.try_recv().await {
        match received {
            Received::Frame(PreviewToServer::PreviewResponse(r)) => status = r.status,
            Received::Data(PreviewDataKind::Body, _, payload) => body.extend_from_slice(&payload),
            other => panic!("非預期的訊息 {other:?}"),
        }
    }
    assert_eq!(status, 200);
    assert_eq!(
        body.len(),
        window as usize,
        "沒有補 credit 時最多送出 window"
    );
    // 補 credit 後繼續收完
    s.window(id, window);
    let (_, _, rest) = s.http_response(id, window).await;
    body.extend_from_slice(&rest);
    assert_eq!(body.len(), BIG_LEN);
    assert_eq!(sha(&body), sha(&big_body()));
}

#[tokio::test]
async fn post_的_body_依_credit_送給_dev_server() {
    let mut s = FakeServer::new().await;
    let payload = big_body()[..1024 * 1024].to_vec();
    let id = s.open_for(
        RUN,
        PreviewStreamKind::Http,
        "POST",
        "/echo",
        PREVIEW_INITIAL_WINDOW,
        vec![("Content-Length".into(), payload.len().to_string())],
    );
    // 扮演 Server：只送 Runner 給的 credit，收到 preview_window 才繼續送
    let mut credit = PREVIEW_INITIAL_WINDOW as usize;
    let mut sent = 0;
    while sent < payload.len() {
        if credit == 0 {
            match s.recv().await {
                Received::Frame(PreviewToServer::PreviewWindow(w)) if w.stream_id == id => {
                    credit += w.credit as usize;
                }
                other => panic!("body 送完前不會有其他訊息：{other:?}"),
            }
            continue;
        }
        let size = (payload.len() - sent).min(PREVIEW_MAX_CHUNK).min(credit);
        s.data(PreviewDataKind::Body, id, &payload[sent..sent + size]);
        sent += size;
        credit -= size;
    }
    s.end(id);
    // 略過剩下的 preview_window，收回應
    let response = loop {
        match s.recv().await {
            Received::Frame(PreviewToServer::PreviewWindow(_)) => {}
            Received::Frame(PreviewToServer::PreviewResponse(r)) => break r,
            other => panic!("非預期的訊息 {other:?}"),
        }
    };
    assert_eq!(response.status, 200);
    let (_, _, body) = s.http_response(id, PREVIEW_INITIAL_WINDOW).await;
    assert_eq!(
        String::from_utf8(body).unwrap(),
        format!("{} {}", payload.len(), sha(&payload))
    );
}

/// 收到 dev server 回的一則文字訊息（分段的會組回），途中的 preview_window 略過。
async fn ws_text(s: &mut FakeServer, id: u32) -> String {
    let mut message = vec![];
    loop {
        match s.recv().await {
            Received::Frame(PreviewToServer::PreviewWindow(_)) => {}
            Received::Data(PreviewDataKind::WsFragment, stream, payload) => {
                assert_eq!(stream, id);
                assert!(payload.len() <= PREVIEW_MAX_CHUNK);
                s.window(id, u32::try_from(payload.len()).unwrap());
                message.extend_from_slice(&payload);
            }
            Received::Data(PreviewDataKind::WsText, stream, payload) => {
                assert_eq!(stream, id);
                s.window(id, u32::try_from(payload.len()).unwrap());
                message.extend_from_slice(&payload);
                return String::from_utf8(message).unwrap();
            }
            other => panic!("非預期的訊息 {other:?}"),
        }
    }
}

#[tokio::test]
async fn websocket_雙向轉送_大訊息分段後組回() {
    let mut s = FakeServer::new().await;
    let id = s.open_for(
        RUN,
        PreviewStreamKind::Websocket,
        "GET",
        "/ws",
        PREVIEW_INITIAL_WINDOW,
        vec![("Sec-WebSocket-Protocol".into(), "vite-hmr".into())],
    );
    match s.recv().await {
        Received::Frame(PreviewToServer::PreviewResponse(r)) => {
            assert_eq!(r.status, 101);
            assert_eq!(
                header(&r.headers, "sec-websocket-protocol"),
                Some("vite-hmr")
            );
        }
        other => panic!("預期 101，收到 {other:?}"),
    }

    // Server → dev server 的文字訊息，dev server 回 pong
    s.data(PreviewDataKind::WsText, id, b"ping");
    assert_eq!(ws_text(&mut s, id).await, "pong:ping");

    // dev server → Server：200 KiB 的訊息拆成 ws_fragment…ws_text
    s.data(PreviewDataKind::WsText, id, b"big");
    let big = ws_text(&mut s, id).await;
    assert_eq!(big.len(), 200 * 1024);
    assert!(big.bytes().all(|b| b == b'x'));

    // Server → dev server：大 binary 訊息分段送出，dev server 收到完整的一則
    let large = vec![7u8; 150 * 1024];
    let (head, tail) = large.split_at(PREVIEW_MAX_CHUNK);
    let (middle, last) = tail.split_at(PREVIEW_MAX_CHUNK);
    s.data(PreviewDataKind::WsFragment, id, head);
    s.data(PreviewDataKind::WsFragment, id, middle);
    s.data(PreviewDataKind::WsBinary, id, last);
    assert_eq!(ws_text(&mut s, id).await, format!("binary:{}", large.len()));

    // dev server 關閉 → preview_ws_close
    s.data(PreviewDataKind::WsText, id, b"close");
    loop {
        match s.recv().await {
            Received::Frame(PreviewToServer::PreviewWindow(_)) => {}
            Received::Frame(PreviewToServer::PreviewWsClose(PreviewWsClose {
                stream_id, ..
            })) => {
                assert_eq!(stream_id, id);
                break;
            }
            other => panic!("非預期的訊息 {other:?}"),
        }
    }
}

#[tokio::test]
async fn preview_沒有在執行或違反_credit_時中止_stream() {
    let mut s = FakeServer::new().await;
    let other_run = "0192f0c4-7a1b-7c3d-8e9f-0a1b2c3d4e60";
    let id = s.open_for(
        other_run,
        PreviewStreamKind::Http,
        "GET",
        "/hello",
        PREVIEW_INITIAL_WINDOW,
        vec![],
    );
    assert_eq!(s.reset_of(id).await, PreviewResetReason::NotRunning);

    // 送出超過 Runner 給的 credit
    let id = s.open_for(
        RUN,
        PreviewStreamKind::Http,
        "POST",
        "/echo",
        PREVIEW_INITIAL_WINDOW,
        vec![("Content-Length".into(), "10000000".into())],
    );
    let chunk = vec![0u8; PREVIEW_MAX_CHUNK];
    for _ in 0..=(PREVIEW_INITIAL_WINDOW as usize / PREVIEW_MAX_CHUNK) {
        s.data(PreviewDataKind::Body, id, &chunk);
    }
    assert_eq!(s.reset_of(id).await, PreviewResetReason::ProtocolError);

    // Run 的 Preview 停止（取消登記）後，新的請求以 not_running 拒絕
    s._registration = None;
    let id = s.open(
        PreviewStreamKind::Http,
        "GET",
        "/hello",
        PREVIEW_INITIAL_WINDOW,
    );
    assert_eq!(s.reset_of(id).await, PreviewResetReason::NotRunning);
}
