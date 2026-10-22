//! 傳輸格式的 golden 測試：`tests/fixtures/*.json` 鎖定 JSON 的確切形狀。
//! 每個 fixture 都要能反序列化，再序列化回完全相同的 JSON。
//! fixture 檔名的前綴決定用哪個 frame 型別解析。

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use orbis_protocol::control::{RunControlActionName, RunControlOutcome};
use orbis_protocol::event::{EventEnvelope, EventKindName};
use orbis_protocol::frame::{RunnerToServer, ServerToRunner};
use serde::Serialize;
use serde::de::DeserializeOwned;

fn fixtures(prefix: &str) -> Vec<(String, serde_json::Value)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut out: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            name.starts_with(prefix) && name.ends_with(".json")
        })
        .map(|p| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            let value = serde_json::from_str(&fs::read_to_string(&p).unwrap())
                .unwrap_or_else(|e| panic!("{name} 不是合法 JSON: {e}"));
            (name, value)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(!out.is_empty(), "沒有 {prefix}*.json fixture");
    out
}

fn round_trip<T: Serialize + DeserializeOwned>(prefix: &str) {
    for (name, value) in fixtures(prefix) {
        let parsed: T = serde_json::from_value(value.clone())
            .unwrap_or_else(|e| panic!("{name} 無法反序列化: {e}"));
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(back, value, "{name} 序列化回來的 JSON 不同");
    }
}

#[test]
fn runner_to_server_fixtures_round_trip() {
    round_trip::<RunnerToServer>("runner_to_server.");
}

#[test]
fn server_to_runner_fixtures_round_trip() {
    round_trip::<ServerToRunner>("server_to_runner.");
}

#[test]
fn every_fixture_has_a_known_prefix() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for entry in fs::read_dir(dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        assert!(
            name.starts_with("runner_to_server.") || name.starts_with("server_to_runner."),
            "{name} 的前綴必須是 runner_to_server. 或 server_to_runner."
        );
    }
}

/// fixture 檔名是 `<方向>.<frame type>[.<kind 或 action>][.<情境>].json`，
/// 回傳每個 fixture 解析後的 frame 與檔名切出的片段。
fn parsed<T: DeserializeOwned>(prefix: &str) -> Vec<(String, Vec<String>, T)> {
    fixtures(prefix)
        .into_iter()
        .map(|(name, value)| {
            let parts = name
                .trim_end_matches(".json")
                .split('.')
                .skip(1)
                .map(str::to_owned)
                .collect();
            let frame = serde_json::from_value(value).unwrap();
            (name, parts, frame)
        })
        .collect()
}

#[test]
fn fixture_names_match_frame_type() {
    for (name, parts, frame) in parsed::<RunnerToServer>("runner_to_server.") {
        assert_eq!(parts[0], frame.type_name(), "{name} 的檔名與 type 不符");
    }
    for (name, parts, frame) in parsed::<ServerToRunner>("server_to_runner.") {
        assert_eq!(parts[0], frame.type_name(), "{name} 的檔名與 type 不符");
    }
}

#[test]
fn every_frame_type_has_a_fixture() {
    let runner_types: BTreeSet<_> = parsed::<RunnerToServer>("runner_to_server.")
        .into_iter()
        .map(|(_, _, f)| f.type_name())
        .collect();
    let expected: BTreeSet<_> = [
        "hello",
        "heartbeat",
        "agent_availability",
        "dispatch_accept",
        "dispatch_reject",
        "event",
        "run_control_result",
    ]
    .into();
    assert_eq!(runner_types, expected);

    let server_types: BTreeSet<_> = parsed::<ServerToRunner>("server_to_runner.")
        .into_iter()
        .map(|(_, _, f)| f.type_name())
        .collect();
    let expected: BTreeSet<_> = [
        "hello_ack",
        "hello_rejected",
        "dispatch_offer",
        "run_control",
        "event_ack",
    ]
    .into();
    assert_eq!(server_types, expected);
}

#[test]
fn every_event_kind_has_a_fixture() {
    let mut seen = BTreeSet::new();
    for (name, parts, frame) in parsed::<RunnerToServer>("runner_to_server.event.") {
        let RunnerToServer::Event(frame) = frame else {
            panic!("{name} 不是 event frame");
        };
        let kind = frame.event.kind.name();
        assert_eq!(parts[1], kind.as_str(), "{name} 的檔名與 kind 不符");
        let tag = serde_json::to_value(&frame.event.kind).unwrap()["kind"].clone();
        assert_eq!(
            tag,
            kind.as_str(),
            "{name}：EventKind::name() 與 serde 的 tag 不一致"
        );
        seen.insert(kind.as_str());
    }
    for kind in EventKindName::ALL {
        assert!(
            seen.contains(kind.as_str()),
            "Event kind {} 沒有 fixture",
            kind.as_str()
        );
    }
}

#[test]
fn every_run_control_action_has_a_fixture() {
    let mut seen = BTreeSet::new();
    for (name, parts, frame) in parsed::<ServerToRunner>("server_to_runner.run_control.") {
        let ServerToRunner::RunControl(control) = frame else {
            panic!("{name} 不是 run_control frame");
        };
        let action = control.action.name();
        assert_eq!(parts[1], action.as_str(), "{name} 的檔名與 action 不符");
        let tag = serde_json::to_value(&control.action).unwrap()["action"].clone();
        assert_eq!(
            tag,
            action.as_str(),
            "{name}：RunControlAction::name() 與 serde 的 tag 不一致"
        );
        seen.insert(action.as_str());
    }
    for action in RunControlActionName::ALL {
        assert!(
            seen.contains(action.as_str()),
            "RunControl 動作 {} 沒有 fixture",
            action.as_str()
        );
    }
}

#[test]
fn every_run_control_outcome_has_a_fixture() {
    let outcomes: BTreeSet<_> = parsed::<RunnerToServer>("runner_to_server.run_control_result.")
        .into_iter()
        .map(|(name, parts, frame)| {
            let RunnerToServer::RunControlResult(result) = frame else {
                panic!("{name} 不是 run_control_result frame");
            };
            let outcome = match result.outcome {
                RunControlOutcome::Applied => "applied",
                RunControlOutcome::BranchPushed { .. } => "branch_pushed",
                RunControlOutcome::Rejected { .. } => "rejected",
            };
            assert_eq!(parts[1], outcome, "{name} 的檔名與 outcome 不符");
            outcome
        })
        .collect();
    assert_eq!(
        outcomes,
        ["applied", "branch_pushed", "rejected"].into(),
        "每一種 outcome 都要有 fixture"
    );
}

/// 存進 `run_events` 的 EventEnvelope 不含 frame 的 `type` 與 `dispatch_id`。
#[test]
fn event_envelope_is_the_frame_without_type_and_dispatch_id() {
    for (name, value) in fixtures("runner_to_server.event.") {
        let RunnerToServer::Event(frame) = serde_json::from_value(value.clone()).unwrap() else {
            panic!("{name} 不是 event frame");
        };
        let mut expected = value.as_object().unwrap().clone();
        expected.remove("type");
        expected.remove("dispatch_id");
        let envelope = serde_json::to_value(&frame.event).unwrap();
        assert_eq!(envelope, serde_json::Value::Object(expected), "{name}");
        let back: EventEnvelope = serde_json::from_value(envelope).unwrap();
        assert_eq!(back, frame.event, "{name}");
    }
}
