//! WebSocket 上的 frame。每個 frame 是一個 JSON 物件，以 `type` 欄位區分種類。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::connection::{Heartbeat, Hello, HelloAck, HelloRejected};

/// Runner 送給 Server 的 frame。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunnerToServer {
    Hello(Hello),
    Heartbeat(Heartbeat),
}

/// Server 送給 Runner 的 frame。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerToRunner {
    HelloAck(HelloAck),
    HelloRejected(HelloRejected),
}
