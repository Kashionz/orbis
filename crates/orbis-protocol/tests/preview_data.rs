//! Preview binary 訊息的 golden 測試：`tests/preview_data.json` 與 TS 端
//! （`packages/protocol/src/preview-data.ts`）共用，鎖定兩邊的編碼一致。

use std::fs;
use std::path::Path;

use orbis_protocol::preview::{PreviewData, PreviewDataKind};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    kind: String,
    stream_id: u32,
    payload_hex: String,
    bytes_hex: String,
}

fn hex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "hex 長度必須是偶數：{text}");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn cases() -> Vec<Case> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/preview_data.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn preview_data_matches_golden_bytes() {
    let cases = cases();
    assert!(!cases.is_empty());
    for case in cases {
        let kind = *PreviewDataKind::ALL
            .iter()
            .find(|k| k.as_str() == case.kind)
            .unwrap_or_else(|| panic!("{}：不認得的 kind {}", case.name, case.kind));
        let payload = hex(&case.payload_hex);
        let bytes = hex(&case.bytes_hex);
        let data = PreviewData {
            kind,
            stream_id: case.stream_id,
            payload: &payload,
        };
        assert_eq!(data.encode(), bytes, "{}：編碼結果不同", case.name);
        assert_eq!(
            PreviewData::decode(&bytes),
            Ok(data),
            "{}：解碼結果不同",
            case.name
        );
    }
}

#[test]
fn every_kind_has_a_golden_case() {
    let cases = cases();
    for kind in PreviewDataKind::ALL {
        assert!(
            cases.iter().any(|c| c.kind == kind.as_str()),
            "{} 沒有 golden case",
            kind.as_str()
        );
    }
}
