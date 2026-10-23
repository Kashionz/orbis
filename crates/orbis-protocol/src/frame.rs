//! WebSocket 上的 frame。每個 frame 是一個 JSON 物件，以 `type` 欄位區分種類。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::availability::AgentAvailability;
use crate::connection::{Heartbeat, Hello, HelloAck, HelloRejected};
use crate::control::{RunControl, RunControlResult};
use crate::dispatch::{DispatchAccept, DispatchOffer, DispatchReject};
use crate::event::{EventAck, EventFrame};
use crate::preview::{
    PreviewEnd, PreviewOpen, PreviewReset, PreviewResponse, PreviewWindow, PreviewWsClose,
};
use crate::tool::{ToolCallFrame, ToolResultFrame};

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
    /// Orbis MCP 工具呼叫（協定版本 2），見 [`crate::tool`]。
    ToolCall(ToolCallFrame),
    // Preview 通道的控制訊息（協定版本 2），見 [`crate::preview`]。
    PreviewResponse(PreviewResponse),
    PreviewWindow(PreviewWindow),
    PreviewEnd(PreviewEnd),
    PreviewReset(PreviewReset),
    PreviewWsClose(PreviewWsClose),
}

/// Server 送給 Runner 的 frame。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerToRunner {
    HelloAck(HelloAck),
    HelloRejected(HelloRejected),
    // 比其他 frame 大很多，放進 Box 避免整個列舉都變大。
    DispatchOffer(Box<DispatchOffer>),
    RunControl(RunControl),
    EventAck(EventAck),
    /// Orbis MCP 工具呼叫的結果（協定版本 2），見 [`crate::tool`]。
    ToolResult(ToolResultFrame),
    // Preview 通道的控制訊息（協定版本 2），見 [`crate::preview`]。
    PreviewOpen(PreviewOpen),
    PreviewWindow(PreviewWindow),
    PreviewEnd(PreviewEnd),
    PreviewReset(PreviewReset),
    PreviewWsClose(PreviewWsClose),
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
            Self::ToolCall(_) => "tool_call",
            Self::PreviewResponse(_) => "preview_response",
            Self::PreviewWindow(_) => "preview_window",
            Self::PreviewEnd(_) => "preview_end",
            Self::PreviewReset(_) => "preview_reset",
            Self::PreviewWsClose(_) => "preview_ws_close",
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
            Self::ToolResult(_) => "tool_result",
            Self::PreviewOpen(_) => "preview_open",
            Self::PreviewWindow(_) => "preview_window",
            Self::PreviewEnd(_) => "preview_end",
            Self::PreviewReset(_) => "preview_reset",
            Self::PreviewWsClose(_) => "preview_ws_close",
        }
    }
}
