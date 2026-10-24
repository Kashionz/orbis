//! 從 Server 下載 blob（ARCHITECTURE §14）：`GET <server><RUNNER_BLOB_PATH>/<blob_id>`，以 Runner
//! token 認證。用於 prompt 中的圖片，例如 Review Gate 退回時附上的 Preview 截圖（issue #17）。
//!
//! Server 網址與 Runner token 要等連線交握完才知道，由連線設定（[`BlobFetcher::set_access`]）。

use std::sync::Mutex;

use anyhow::{Context, bail};
use orbis_protocol::RUNNER_BLOB_PATH;
use orbis_protocol::event::BlobRef;
use sha2::{Digest, Sha256};

/// 一次最多下載的大小（與上傳的上限相同，ARCHITECTURE §14）。
const MAX_BLOB_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct BlobFetcher {
    client: reqwest::Client,
    /// （Server 的 HTTP base URL, Runner token）。
    access: Mutex<Option<(String, String)>>,
}

impl BlobFetcher {
    /// 連線交握後設定 Server 網址與 Runner token。
    pub fn set_access(&self, http_base: &str, token: &str) {
        *self
            .access
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((http_base.to_owned(), token.to_owned()));
    }

    /// 下載 blob，並驗證大小與 SHA-256 與參照相符。
    pub async fn fetch(&self, blob: &BlobRef) -> anyhow::Result<Vec<u8>> {
        if blob.size > MAX_BLOB_BYTES {
            bail!("blob {} 太大（{} bytes）", blob.blob_id, blob.size);
        }
        let (base, token) = self
            .access
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .context("還沒有連上 Server，無法下載 blob")?;
        let url = format!("{base}{RUNNER_BLOB_PATH}/{}", blob.blob_id);
        let response = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .with_context(|| format!("下載 blob {} 失敗", blob.blob_id))?;
        if !response.status().is_success() {
            bail!(
                "下載 blob {} 失敗：HTTP {}",
                blob.blob_id,
                response.status()
            );
        }
        let bytes = response.bytes().await?.to_vec();
        if bytes.len() as u64 != blob.size {
            bail!(
                "blob {} 的大小不符：預期 {}，收到 {}",
                blob.blob_id,
                blob.size,
                bytes.len()
            );
        }
        let sha = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if sha != blob.sha256 {
            bail!("blob {} 的 SHA-256 不符", blob.blob_id);
        }
        Ok(bytes)
    }
}
