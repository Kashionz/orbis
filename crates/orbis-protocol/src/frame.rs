//! WebSocket 上的 frame。每個 frame 是一個 JSON 物件，以 `type` 欄位區分種類。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::availability::AgentAvailability;
use crate::connection::{Heartbeat, Hello, HelloAck, HelloRejected};
use crate::control::{RunControl, RunControlResult};
use crate::dispatch::{DispatchAccept, DispatchOffer, DispatchReject};
use crate::event::{EventAck, EventFrame};

/// Runner 送給 Server 的 frame。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunnerToServer {
    Hello(Hello),
    Heartbeat(Heartbeat),
    AgentAvailability(AgentAvailability),
    DispatchAccept(DispatchAccept),
    DispatchReject(DispatchReject),
    Event(EventFrame),
    RunControlResult(RunControlResult),
}

/// Server 送給 Runner 的 frame。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerToRunner {
    HelloAck(HelloAck),
    HelloRejected(HelloRejected),
    DispatchOffer(DispatchOffer),
    RunControl(RunControl),
    EventAck(EventAck),
}

impl RunnerToServer {
    /// 這個 frame 的 `type` 值。新增 frame 時這裡的 match 會編譯失敗，提醒同步補 fixture。
    pub const fn type_name(&self) -> &'static str {
        match self {
            Self::Hello(_) => "hello",
            Self::Heartbeat(_) => "heartbeat",
            Self::AgentAvailability(_) => "agent_availability",
            Self::DispatchAccept(_) => "dispatch_accept",
            Self::DispatchReject(_) => "dispatch_reject",
            Self::Event(_) => "event",
            Self::RunControlResult(_) => "run_control_result",
        }
    }
}

impl ServerToRunner {
    /// 這個 frame 的 `type` 值。新增 frame 時這裡的 match 會編譯失敗，提醒同步補 fixture。
    pub const fn type_name(&self) -> &'static str {
        match self {
            Self::HelloAck(_) => "hello_ack",
            Self::HelloRejected(_) => "hello_rejected",
            Self::DispatchOffer(_) => "dispatch_offer",
            Self::RunControl(_) => "run_control",
            Self::EventAck(_) => "event_ack",
        }
    }
}
