//! 傳輸格式的 golden 測試：`tests/fixtures/*.json` 鎖定 JSON 的確切形狀。
//! 每個 fixture 都要能反序列化，再序列化回完全相同的 JSON。
//! fixture 檔名的前綴決定用哪個 frame 型別解析。

use std::fs;
use std::path::Path;

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
