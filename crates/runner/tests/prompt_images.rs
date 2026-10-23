//! prompt 中的圖片（issue #17、ARCHITECTURE §14）：Agent 支援圖片時，Runner 從 Server 下載 blob
//! 以 ACP 圖片送出；不支援或下載失敗時改成說明文字。

mod support;

use base64::Engine as _;
use orbis_protocol::event::{BlobRef, ContentBlock};
use support::flow::Env;
use support::server::{fake_agent_toml, offer, send_offer};
use support::{runner_script, toml_string};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake screenshot";

fn screenshot() -> BlobRef {
    BlobRef {
        blob_id: "blob-1".into(),
        sha256: orbis_runner::repo_config::sha256_hex(PNG),
        size: PNG.len() as u64,
        media_type: "image/png".into(),
    }
}

/// 派一個帶截圖的 prompt，回傳 Agent 回報收到的 prompt（每個區塊一行）。
async fn prompt_seen_by_agent(image_capable: bool, blob_on_server: bool) -> Vec<String> {
    let mut env = Env::new(&[("README.md", "a\n")], |wt| {
        let toml = fake_agent_toml(wt, &runner_script("echo-prompt.yaml"));
        if image_capable {
            toml.replace(
                "args = [\"--script\", ",
                &format!("args = [{}, \"--script\", ", toml_string("--image")),
            )
        } else {
            toml
        }
    })
    .await;
    if blob_on_server {
        env.server
            .blobs
            .lock()
            .unwrap()
            .insert("blob-1".into(), PNG.to_vec());
    }
    let _runner = env.spawn();
    let mut conn = env.server.accept().await;
    conn.handshake(Vec::new(), Some("rt_test")).await;
    let mut o = offer("r1", "d-r1", env.remote.dispatch_repo("web"), "fake", "");
    o.prompt = vec![
        ContentBlock::Text {
            text: "請看這張截圖".into(),
        },
        ContentBlock::Image(screenshot()),
    ];
    conn.send(&send_offer(o)).await;
    let chunk = conn.wait_event("message_chunk").await;
    conn.wait_status("awaiting_gate").await;
    chunk["content"]["text"]
        .as_str()
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_支援圖片時下載_blob_以圖片送出() {
    let lines = prompt_seen_by_agent(true, true).await;
    let expected = format!(
        "image:image/png:{}",
        base64::engine::general_purpose::STANDARD.encode(PNG)
    );
    assert_eq!(lines, ["text:請看這張截圖".to_owned(), expected]);
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_不支援圖片時改成說明文字() {
    let lines = prompt_seen_by_agent(false, true).await;
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(
        lines[1].starts_with("text:[圖片 blob-1") && lines[1].contains("image/png"),
        "{lines:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn 下載失敗時改成說明文字並註明() {
    let lines = prompt_seen_by_agent(true, false).await;
    assert!(lines[1].starts_with("text:[圖片 blob-1"), "{lines:?}");
    assert!(
        lines.iter().any(|l| l.contains("無法下載這張圖片")),
        "{lines:?}"
    );
}
