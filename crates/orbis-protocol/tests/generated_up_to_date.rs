//! `packages/protocol/src/generated` 必須與 Rust 型別的產生結果一致（ADR-0003）。
//! 失敗時執行 `cargo gen-protocol` 後 commit。

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

fn read_dir(dir: &Path) -> BTreeMap<String, String> {
    fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("讀不到 {}: {e}", dir.display()))
        .map(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            // 不受 Windows 上 git 轉換換行的影響
            let content = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
            (name, content)
        })
        .collect()
}

#[test]
fn committed_typescript_matches_rust_types() {
    let fresh = std::env::temp_dir().join(format!("orbis-protocol-gen-{}", std::process::id()));
    orbis_protocol::typescript::generate(&fresh).unwrap();

    let expected = read_dir(&fresh);
    let committed = read_dir(&orbis_protocol::typescript::default_out_dir());
    fs::remove_dir_all(&fresh).ok();

    let expected_names: Vec<_> = expected.keys().collect();
    let committed_names: Vec<_> = committed.keys().collect();
    assert_eq!(
        committed_names, expected_names,
        "packages/protocol/src/generated 的檔案清單過期，請執行 `cargo gen-protocol`"
    );
    for (name, content) in &expected {
        assert_eq!(
            &committed[name], content,
            "packages/protocol/src/generated/{name} 過期，請執行 `cargo gen-protocol`"
        );
    }
}
