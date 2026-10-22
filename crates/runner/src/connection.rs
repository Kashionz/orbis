//! 與 Server 的 WebSocket 連線（ARCHITECTURE §6.1）。
//!
//! 一次連線分成兩段：
//! 1. [`handshake`]：送 Hello，等 HelloAck 或 HelloRejected。
//! 2. [`Session::run`]：依 `heartbeat_interval_ms` 送 Heartbeat、回報 AgentAvailability、
//!    處理 Server 送來的 frame。
//!
//! 斷線重連、Runner token 保存、Dispatch 的實際處理由 A1 接上；這裡只負責單一連線。

use std::fmt;
use std::time::{Duration, SystemTime};

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use orbis_protocol::PROTOCOL_VERSION;
use orbis_protocol::availability::AgentAvailability;
use orbis_protocol::connection::{Heartbeat, Hello, HelloAck, HelloRejected};
use orbis_protocol::control::{
    RunControl, RunControlOutcome, RunControlRejectReason, RunControlResult,
};
use orbis_protocol::dispatch::{DispatchOffer, DispatchReject, DispatchRejectReason};
use orbis_protocol::frame::{RunnerToServer, ServerToRunner};
use orbis_protocol::ids::Timestamp;
use tokio::net::TcpStream;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};

use crate::config::ConnectConfig;

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

/// 連上 Server、完成 Hello 交握並持續運作，直到連線結束或發生錯誤。
/// 被 Server 拒絕時回傳的錯誤可以 `downcast_ref::<Rejected>()`。
pub async fn run(config: &ConnectConfig) -> anyhow::Result<()> {
    info!(url = %config.url, name = %config.runner.name, "連線到 Server");
    let (ws, _) = tokio_tungstenite::connect_async(config.url.as_str())
        .await
        .with_context(|| format!("無法連線到 {}", config.url))?;
    let mut conn = Connection { ws };
    let ack = handshake(&mut conn, config).await?;
    info!(
        runner_id = %ack.runner_id,
        heartbeat_interval_ms = ack.heartbeat_interval_ms,
        "Server 接受連線"
    );
    Session::new(conn, &ack)?.run().await
}

/// 單一 WebSocket 連線上的 frame 收送。
pub struct Connection {
    ws: Ws,
}

impl Connection {
    pub async fn send(&mut self, frame: &RunnerToServer) -> anyhow::Result<()> {
        let text = serde_json::to_string(frame)?;
        debug!(frame = frame.type_name(), "送出 frame");
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
pub async fn handshake(conn: &mut Connection, config: &ConnectConfig) -> anyhow::Result<HelloAck> {
    conn.send(&RunnerToServer::Hello(Hello {
        protocol_version: PROTOCOL_VERSION,
        runner: config.runner.clone(),
        pairing: config.pairing.clone(),
    }))
    .await?;

    match conn.recv().await? {
        Some(ServerToRunner::HelloAck(ack)) => Ok(ack),
        Some(ServerToRunner::HelloRejected(rejected)) => Err(Rejected(rejected).into()),
        Some(other) => bail!("預期 hello_ack，卻收到 {}", other.type_name()),
        None => bail!("Server 在回應 Hello 之前就關閉了連線"),
    }
}

/// 交握完成後的連線。
pub struct Session {
    conn: Connection,
    heartbeat_interval: Duration,
}

impl Session {
    pub fn new(conn: Connection, ack: &HelloAck) -> anyhow::Result<Self> {
        if ack.heartbeat_interval_ms == 0 {
            bail!("Server 指定的 heartbeat_interval_ms 是 0");
        }
        Ok(Self {
            conn,
            heartbeat_interval: Duration::from_millis(ack.heartbeat_interval_ms.into()),
        })
    }

    /// 回報 AgentAvailability 後持續送 Heartbeat，直到連線結束。
    pub async fn run(mut self) -> anyhow::Result<()> {
        self.conn
            .send(&RunnerToServer::AgentAvailability(agent_availability()))
            .await?;

        let mut heartbeat = tokio::time::interval(self.heartbeat_interval);
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    self.conn.send(&RunnerToServer::Heartbeat(Heartbeat {
                        ts: now(),
                        active_run_ids: Vec::new(),
                    })).await?;
                }
                frame = self.conn.recv() => match frame? {
                    Some(frame) => self.handle(frame).await?,
                    None => bail!("Server 關閉了連線"),
                },
            }
        }
    }

    async fn handle(&mut self, frame: ServerToRunner) -> anyhow::Result<()> {
        match frame {
            ServerToRunner::HelloAck(_) | ServerToRunner::HelloRejected(_) => {
                warn!(frame = frame.type_name(), "交握已完成，略過");
            }
            ServerToRunner::DispatchOffer(offer) => self.reject_dispatch(&offer).await?,
            ServerToRunner::RunControl(control) => self.reject_control(&control).await?,
            ServerToRunner::EventAck(ack) => {
                debug!(run_id = %ack.run_id, seq = ack.seq, "收到 event_ack");
            }
        }
        Ok(())
    }

    /// 骨架還沒有任何 Agent，一律以 `agent_unavailable` 拒絕，讓 Server 不必等到 Offer 過期。
    // TODO(A1)：建立 Worktree、啟動 Agent。
    async fn reject_dispatch(&mut self, offer: &DispatchOffer) -> anyhow::Result<()> {
        warn!(dispatch_id = %offer.dispatch_id, agent = %offer.agent, "沒有可用的 Agent，拒絕 Dispatch");
        self.conn
            .send(&RunnerToServer::DispatchReject(DispatchReject {
                dispatch_id: offer.dispatch_id.clone(),
                reason: DispatchRejectReason::AgentUnavailable,
                message: format!("這台 Runner 沒有可用的 Agent {}", offer.agent),
            }))
            .await
    }

    /// 骨架不會執行任何 Run，所有 RunControl 都以 `unknown_run` 拒絕。
    // TODO(A1)：交給對應的 Run 處理。
    async fn reject_control(&mut self, control: &RunControl) -> anyhow::Result<()> {
        warn!(run_id = %control.run_id, action = control.action.name().as_str(), "沒有這個 Run，拒絕 RunControl");
        self.conn
            .send(&RunnerToServer::RunControlResult(RunControlResult {
                control_id: control.control_id.clone(),
                run_id: control.run_id.clone(),
                dispatch_id: control.dispatch_id.clone(),
                outcome: RunControlOutcome::Rejected {
                    reason: RunControlRejectReason::UnknownRun,
                    message: format!("這台 Runner 上沒有 Run {}", control.run_id),
                },
            }))
            .await
    }
}

/// 這台 Runner 能跑的 Agent。
// TODO(A1)：依 Agent Profile 偵測已安裝的 Agent。
fn agent_availability() -> AgentAvailability {
    AgentAvailability {
        agents: Vec::new(),
        credentials: Vec::new(),
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
    use orbis_protocol::connection::HelloRejectReason;

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
}
