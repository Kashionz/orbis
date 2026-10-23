//! 與 Server 的 WebSocket 連線（ARCHITECTURE §6.1、§14）。
//!
//! - [`run`]：斷線後以指數退避重新連線，直到被要求結束或被 Server 以 HelloRejected 拒絕。
//! - 每條連線：送 Hello（已保存 Runner token 就用它，否則用 Pairing token）→ HelloAck
//!   （第一次 Pairing 時保存 Server 發的 Runner token）→ AgentAvailability → 持續送 Heartbeat、
//!   補送與送出 Event、處理 Server 送來的 frame。
//! - Event 一律先進 [`crate::outbox::Outbox`]；blob 先以 HTTP PUT 上傳成功才送參照它的 Event。

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use orbis_protocol::PROTOCOL_VERSION;
use orbis_protocol::connection::{Hello, HelloAck, HelloRejectReason, HelloRejected, Pairing};
use orbis_protocol::frame::{RunnerToServer, ServerToRunner};
use orbis_protocol::ids::Timestamp;
use rand::Rng;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};

use crate::config::ConnectConfig;
use crate::contract::{RUNNER_BLOB_PATH, SidecarState};
use crate::home::StoredToken;
use crate::outbox::Spooled;
use crate::supervisor::Supervisor;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Server 以 HelloRejected 拒絕連線。重新連線也不會成功，呼叫端不應重試。
#[derive(Debug, Clone, PartialEq)]
pub struct Rejected(pub HelloRejected);

impl fmt::Display for Rejected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = serde_json::to_value(self.0.reason)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        write!(
            f,
            "Server 拒絕連線（{reason}，Server 協定版本 {}，Runner 協定版本 {PROTOCOL_VERSION}）：{}",
            self.0.server_protocol_version, self.0.message
        )
    }
}

impl std::error::Error for Rejected {}

impl Rejected {
    /// 需要重新 Pairing（換一個 Pairing token）才能連上。
    pub fn needs_pairing(&self) -> bool {
        matches!(
            self.0.reason,
            HelloRejectReason::InvalidPairingToken | HelloRejectReason::InvalidRunnerToken
        )
    }
}

/// 缺少可用的身分：沒有保存的 Runner token，也沒有 Pairing token。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedsPairing;

impl fmt::Display for NeedsPairing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "這台 Runner 還沒有和 Server 完成 Pairing：請指定 --pairing-token 或設定環境變數 {}",
            orbis_protocol::names::env_var(crate::config::ENV_PAIRING_TOKEN)
        )
    }
}

impl std::error::Error for NeedsPairing {}

/// 重新連線的指數退避：1 秒起跳、每次加倍、上限 60 秒，加上 ±20% 的 jitter。
#[derive(Debug, Clone)]
pub struct Backoff {
    attempt: u32,
    base: Duration,
    max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(Duration::from_secs(1), Duration::from_secs(60))
    }
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Self {
            attempt: 0,
            base,
            max,
        }
    }

    /// 下一次等待的時間（不含 jitter）。
    pub fn next_delay(&mut self) -> Duration {
        let factor = 2u32.saturating_pow(self.attempt.min(16));
        self.attempt = self.attempt.saturating_add(1);
        self.base.saturating_mul(factor).min(self.max)
    }

    /// 加上 ±20% 的 jitter，避免許多 Runner 同時重連。
    pub fn next_with_jitter(&mut self) -> Duration {
        let delay = self.next_delay();
        let jitter = rand::rng().random_range(0.8..=1.2);
        delay.mul_f64(jitter)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// 連線狀態的回報（sidecar 用）。
pub type StateSender = watch::Sender<(SidecarState, Option<String>)>;

/// 持續連線直到 `shutdown` 變成 `true`。被 Server 拒絕時回傳 [`Rejected`]。
pub async fn run(
    config: &ConnectConfig,
    supervisor: Arc<Supervisor>,
    mut frames: mpsc::UnboundedReceiver<RunnerToServer>,
    state: StateSender,
    mut shutdown: watch::Receiver<bool>,
    backoff_base: Duration,
) -> anyhow::Result<()> {
    let mut backoff = Backoff::new(backoff_base, Duration::from_secs(60));
    let mut runner_id = None;
    loop {
        state.send_replace((SidecarState::Connecting, runner_id.clone()));
        info!(url = %config.url, name = %config.runner.name, "連線到 Server");
        let outcome = connect_once(config, &supervisor, &mut frames, &state, &mut shutdown).await;
        match outcome {
            Ok(ConnectionEnd::Shutdown) => return Ok(()),
            Ok(ConnectionEnd::Disconnected { connected, id }) => {
                if connected {
                    backoff.reset();
                }
                if id.is_some() {
                    runner_id = id;
                }
            }
            Err(e) => {
                if let Some(rejected) = e.downcast_ref::<Rejected>() {
                    // 保存的 Runner token 失效、但還有 Pairing token：清掉 token 改用 Pairing 重試一次。
                    if rejected.0.reason == HelloRejectReason::InvalidRunnerToken
                        && config.repair_with_pairing_token
                        && config.pairing_token.is_some()
                        && supervisor.home().runner_token(&config.url)?.is_some()
                    {
                        warn!("Runner token 已失效，改用 Pairing token 重新 Pairing");
                        supervisor.home().forget_runner_token(&config.url)?;
                        continue;
                    }
                    return Err(e);
                }
                if e.downcast_ref::<NeedsPairing>().is_some() {
                    return Err(e);
                }
                warn!(error = format!("{e:#}"), "連線中斷");
            }
        }
        state.send_replace((SidecarState::Offline, runner_id.clone()));
        let delay = backoff.next_with_jitter();
        info!(delay_ms = delay.as_millis() as u64, "稍後重新連線");
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            _ = shutdown.wait_for(|s| *s) => return Ok(()),
        }
    }
}

enum ConnectionEnd {
    Shutdown,
    Disconnected {
        /// 是否曾完成交握（完成過就重設退避時間）。
        connected: bool,
        id: Option<String>,
    },
}

async fn connect_once(
    config: &ConnectConfig,
    supervisor: &Arc<Supervisor>,
    frames: &mut mpsc::UnboundedReceiver<RunnerToServer>,
    state: &StateSender,
    shutdown: &mut watch::Receiver<bool>,
) -> anyhow::Result<ConnectionEnd> {
    let home = supervisor.home().clone();
    let stored = home.runner_token(&config.url)?;
    let pairing = match (&stored, &config.pairing_token) {
        (Some(token), _) => Pairing::RunnerToken {
            runner_id: token.runner_id.clone(),
            token: token.token.clone(),
        },
        (None, Some(token)) => Pairing::PairingToken {
            token: token.clone(),
        },
        (None, None) => return Err(NeedsPairing.into()),
    };
    let (ws, _) = tokio_tungstenite::connect_async(config.url.as_str())
        .await
        .with_context(|| format!("無法連線到 {}", config.url))?;
    let mut conn = Connection { ws };
    let ack = handshake(&mut conn, config, pairing).await?;
    let token = match (&ack.runner_token, stored) {
        (Some(token), _) => {
            home.save_runner_token(
                &config.url,
                StoredToken {
                    runner_id: ack.runner_id.clone(),
                    token: token.clone(),
                },
            )?;
            info!(runner_id = %ack.runner_id, "Pairing 完成，已保存 Runner token");
            token.clone()
        }
        (None, Some(stored)) => stored.token,
        (None, None) => bail!("Server 沒有發給 Runner token"),
    };
    info!(
        runner_id = %ack.runner_id,
        heartbeat_interval_ms = ack.heartbeat_interval_ms,
        "Server 接受連線"
    );
    if ack.heartbeat_interval_ms == 0 {
        bail!("Server 指定的 heartbeat_interval_ms 是 0");
    }
    let id = Some(ack.runner_id.to_string());
    state.send_replace((SidecarState::Connected, id.clone()));
    supervisor.on_connected(&ack.resume);
    let session = Session {
        conn,
        supervisor: supervisor.clone(),
        uploader: BlobUploader::new(&config.http_base, token),
        heartbeat: Duration::from_millis(ack.heartbeat_interval_ms.into()),
    };
    match session.run(frames, shutdown).await {
        Ok(true) => Ok(ConnectionEnd::Shutdown),
        Ok(false) => Ok(ConnectionEnd::Disconnected {
            connected: true,
            id,
        }),
        Err(e) => {
            warn!(error = format!("{e:#}"), "連線中斷");
            Ok(ConnectionEnd::Disconnected {
                connected: true,
                id,
            })
        }
    }
}

/// 單一 WebSocket 連線上的 frame 收送。
pub struct Connection {
    ws: Ws,
}

impl Connection {
    pub async fn send(&mut self, frame: &RunnerToServer) -> anyhow::Result<()> {
        debug!(frame = frame.type_name(), "送出 frame");
        self.send_text(serde_json::to_string(frame)?).await
    }

    /// 送出一個以 `type` 區分的 frame（給還在等契約、不在 [`RunnerToServer`] 中的形狀用）。
    pub async fn send_typed(
        &mut self,
        ty: &str,
        body: &impl serde::Serialize,
    ) -> anyhow::Result<()> {
        let mut value = serde_json::to_value(body)?;
        let object = value.as_object_mut().context("frame 必須是 JSON 物件")?;
        object.insert("type".into(), ty.into());
        debug!(frame = ty, "送出 frame");
        self.send_text(serde_json::to_string(&value)?).await
    }

    async fn send_text(&mut self, text: String) -> anyhow::Result<()> {
        self.ws
            .send(Message::text(text))
            .await
            .context("送出 frame 失敗")
    }

    /// 收下一個 frame。連線正常關閉時回傳 `None`；無法解析的訊息記 log 後略過。
    pub async fn recv(&mut self) -> anyhow::Result<Option<ServerToRunner>> {
        while let Some(message) = self.ws.next().await {
            match message.context("接收 frame 失敗")? {
                Message::Text(text) => match serde_json::from_str::<ServerToRunner>(&text) {
                    Ok(frame) => {
                        debug!(frame = frame.type_name(), "收到 frame");
                        return Ok(Some(frame));
                    }
                    Err(e) => warn!(error = %e, "無法解析 Server 送來的 frame，略過"),
                },
                Message::Close(frame) => {
                    debug!(?frame, "Server 關閉連線");
                    return Ok(None);
                }
                // Ping 由 tungstenite 自動回 Pong
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
                Message::Binary(_) => warn!("收到 binary 訊息，協定只使用 JSON 文字，略過"),
            }
        }
        Ok(None)
    }
}

/// 送出 Hello，等待 Server 的回應。
pub async fn handshake(
    conn: &mut Connection,
    config: &ConnectConfig,
    pairing: Pairing,
) -> anyhow::Result<HelloAck> {
    conn.send(&RunnerToServer::Hello(Hello {
        protocol_version: PROTOCOL_VERSION,
        runner: config.runner.clone(),
        pairing,
    }))
    .await?;

    match conn.recv().await? {
        Some(ServerToRunner::HelloAck(ack)) => Ok(ack),
        Some(ServerToRunner::HelloRejected(rejected)) => Err(Rejected(rejected).into()),
        Some(other) => bail!("預期 hello_ack，卻收到 {}", other.type_name()),
        None => bail!("Server 在回應 Hello 之前就關閉了連線"),
    }
}

/// 以 HTTP PUT 上傳 blob（ARCHITECTURE §14）。
struct BlobUploader {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl BlobUploader {
    fn new(http_base: &str, token: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            base: format!("{http_base}{RUNNER_BLOB_PATH}"),
            token,
        }
    }

    async fn upload(
        &self,
        run_id: &str,
        blob: &orbis_protocol::event::BlobRef,
        bytes: Vec<u8>,
    ) -> anyhow::Result<()> {
        // 大小由 Server 依 body 長度驗證。
        let url = format!("{}/{}", self.base, blob.blob_id);
        let response = self
            .client
            .put(&url)
            .query(&[("run_id", run_id), ("sha256", blob.sha256.as_str())])
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, &blob.media_type)
            .body(bytes)
            .send()
            .await
            .with_context(|| format!("上傳 blob {} 失敗", blob.blob_id))?;
        if !response.status().is_success() {
            bail!(
                "上傳 blob {} 失敗：HTTP {}",
                blob.blob_id,
                response.status()
            );
        }
        Ok(())
    }
}

/// 交握完成後的連線。
struct Session {
    conn: Connection,
    supervisor: Arc<Supervisor>,
    uploader: BlobUploader,
    heartbeat: Duration,
}

impl Session {
    /// 回傳 `Ok(true)` 表示收到結束要求，`Ok(false)` 表示 Server 關閉了連線。
    async fn run(
        mut self,
        frames: &mut mpsc::UnboundedReceiver<RunnerToServer>,
        shutdown: &mut watch::Receiver<bool>,
    ) -> anyhow::Result<bool> {
        let availability = self.supervisor.availability().await;
        self.conn
            .send(&RunnerToServer::AgentAvailability(availability))
            .await?;

        let mut heartbeat = tokio::time::interval(self.heartbeat);
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let outbox = self.supervisor.outbox().clone();
        loop {
            // 先把能送的 Event 送完（依 seq），再等下一件事。
            while let Some(item) = outbox.next_unsent() {
                self.send_event(&item).await?;
            }
            tokio::select! {
                _ = heartbeat.tick() => {
                    let hb = self.supervisor.heartbeat();
                    self.conn.send_typed("heartbeat", &hb).await?;
                }
                () = outbox.notified() => {}
                Some(frame) = frames.recv() => self.conn.send(&frame).await?,
                frame = self.conn.recv() => match frame? {
                    Some(frame) => self.handle(frame).await?,
                    None => return Ok(false),
                },
                _ = shutdown.wait_for(|s| *s) => {
                    let _ = self.conn.ws.close(None).await;
                    return Ok(true);
                }
            }
        }
    }

    async fn send_event(&mut self, item: &Spooled) -> anyhow::Result<()> {
        let outbox = self.supervisor.outbox().clone();
        for blob in &item.blobs {
            if outbox.is_uploaded(&blob.blob_id) {
                continue;
            }
            let bytes = outbox.blob_bytes(&blob.blob_id)?;
            self.uploader
                .upload(item.frame.run_id.as_str(), blob, bytes)
                .await?;
            outbox.mark_uploaded(&blob.blob_id);
        }
        self.conn.send_typed("event", &item.frame).await?;
        outbox.mark_sent(&item.frame.run_id, item.frame.seq);
        Ok(())
    }

    async fn handle(&mut self, frame: ServerToRunner) -> anyhow::Result<()> {
        match frame {
            ServerToRunner::HelloAck(_) | ServerToRunner::HelloRejected(_) => {
                warn!(frame = frame.type_name(), "交握已完成，略過");
            }
            ServerToRunner::DispatchOffer(offer) => {
                let reply = self.supervisor.handle_offer(*offer).await;
                self.conn.send(&reply).await?;
                // 接受後 Run 的並行狀況改變，送一次新的完整清單。
                if matches!(reply, RunnerToServer::DispatchAccept(_)) {
                    let availability = self.supervisor.availability().await;
                    self.conn
                        .send(&RunnerToServer::AgentAvailability(availability))
                        .await?;
                }
            }
            ServerToRunner::RunControl(control) => self.supervisor.handle_control(control),
            ServerToRunner::EventAck(ack) => {
                debug!(run_id = %ack.run_id, seq = ack.seq, "收到 event_ack");
                self.supervisor.outbox().ack(&ack.run_id, ack.seq);
            }
        }
        Ok(())
    }
}

/// 目前時間，RFC 3339 UTC（毫秒精度）。
pub fn now() -> Timestamp {
    timestamp(SystemTime::now())
}

fn timestamp(time: SystemTime) -> Timestamp {
    Timestamp(humantime::format_rfc3339_millis(time).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_rfc3339_utc_with_millis() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_millis(1_792_742_400_123);
        assert_eq!(timestamp(t).0, "2026-10-23T08:00:00.123Z");
    }

    #[test]
    fn rejected_message_includes_reason_and_server_message() {
        let text = Rejected(HelloRejected {
            reason: HelloRejectReason::VersionMismatch,
            server_protocol_version: 2,
            message: "請更新 Runner".into(),
        })
        .to_string();
        assert!(text.contains("version_mismatch"), "{text}");
        assert!(text.contains("請更新 Runner"), "{text}");
    }

    #[test]
    fn 退避時間加倍並有上限() {
        let mut b = Backoff::default();
        let delays: Vec<u64> = (0..8).map(|_| b.next_delay().as_secs()).collect();
        assert_eq!(delays, [1, 2, 4, 8, 16, 32, 60, 60]);
        b.reset();
        assert_eq!(b.next_delay().as_secs(), 1);
        for _ in 0..100 {
            let d = Backoff::default().next_with_jitter().as_millis();
            assert!((800..=1200).contains(&d), "{d}");
        }
    }
}
