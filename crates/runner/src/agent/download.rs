//! 由 Runner 代管下載的 zip 封裝（Antigravity 的 `agy_acp_server`，ARCHITECTURE §7）。
//!
//! 從固定網址下載鎖定版本的 zip，比對寫死在程式中的 sha256，解到
//! `<狀態目錄>/agents/<名稱>@<版本>/` 後直接啟動（不經過 shell）。先在同一層的暫存目錄中
//! 下載與解開，完成後才改名，中途失敗或兩個 Run 同時安裝都不會留下不完整的目錄。

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use sha2::{Digest, Sha256};

/// 下載大小的上限：超過就放棄，避免錯誤的回應塞滿磁碟。
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
/// 連線逾時（下載本身不設上限，大檔案在慢速網路上需要時間）。
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// 網路中斷時最多下載幾次。
const DOWNLOAD_ATTEMPTS: u32 = 3;
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

/// 一個平台的發佈版本。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveBuild {
    /// `<os>-<arch>`，見 [`current_target`]。
    pub target: &'static str,
    pub url: &'static str,
    /// zip 檔的 sha256（小寫十六進位）。
    pub sha256: &'static str,
    /// zip 內的執行檔（`/` 分隔的相對路徑）。
    pub command: &'static str,
    pub args: &'static [&'static str],
}

/// 這台電腦的平台：`windows`／`darwin`／`linux` 加上 `x86_64`／`aarch64`
/// （與 ACP Registry 的 binary 發佈相同的寫法）。
pub fn current_target() -> Option<String> {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "darwin",
        "linux" => "linux",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        _ => return None,
    };
    Some(format!("{os}-{arch}"))
}

/// 這台電腦可以用的發佈版本。
pub fn build_for(builds: &[ArchiveBuild]) -> Option<&ArchiveBuild> {
    let target = current_target()?;
    builds.iter().find(|b| b.target == target)
}

/// 安裝目錄。
pub fn install_dir(agents_dir: &Path, name: &str, version: &str) -> PathBuf {
    agents_dir.join(format!("{name}@{version}"))
}

/// 安裝後執行檔的完整路徑。
pub fn command_path(agents_dir: &Path, name: &str, version: &str, build: &ArchiveBuild) -> PathBuf {
    let mut path = install_dir(agents_dir, name, version);
    for part in build.command.split('/') {
        path.push(part);
    }
    path
}

/// 確保已安裝；已安裝時不做任何事。回傳執行檔的路徑。
pub async fn ensure_installed(
    agents_dir: &Path,
    name: &str,
    version: &str,
    build: &ArchiveBuild,
) -> anyhow::Result<PathBuf> {
    let command = command_path(agents_dir, name, version, build);
    if command.is_file() {
        return Ok(command);
    }
    std::fs::create_dir_all(agents_dir)
        .with_context(|| format!("無法建立 {}", agents_dir.display()))?;
    let staging = agents_dir.join(format!("{name}@{version}.partial-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&staging).with_context(|| format!("無法建立 {}", staging.display()))?;
    let result = install_into(&staging, agents_dir, name, version, build).await;
    let _ = std::fs::remove_dir_all(&staging);
    result?;
    if !command.is_file() {
        bail!("{name}@{version} 解開後找不到 {}", build.command);
    }
    Ok(command)
}

async fn install_into(
    staging: &Path,
    agents_dir: &Path,
    name: &str,
    version: &str,
    build: &ArchiveBuild,
) -> anyhow::Result<()> {
    tracing::info!(name, version, url = build.url, "下載 ACP server");
    let archive = staging.join("download.zip");
    download(build.url, &archive, build.sha256).await?;
    let unpacked = staging.join("unpacked");
    let target = unpacked.clone();
    tokio::task::spawn_blocking(move || unpack(&archive, &target))
        .await
        .context("解壓縮的工作中斷")??;
    let mut command = unpacked.clone();
    for part in build.command.split('/') {
        command.push(part);
    }
    if !command.is_file() {
        bail!("{name}@{version} 的封裝中沒有 {}", build.command);
    }
    make_executable(&command)?;
    let dest = install_dir(agents_dir, name, version);
    if let Err(error) = std::fs::rename(&unpacked, &dest) {
        // 另一個 Run 同時裝好了：沿用它的。
        if command_path(agents_dir, name, version, build).is_file() {
            return Ok(());
        }
        return Err(error).with_context(|| format!("無法把安裝目錄改名成 {}", dest.display()));
    }
    Ok(())
}

/// 下載到 `file`，同時計算 sha256；和 `expected` 不同時刪除檔案並回傳錯誤。
/// 網路中斷時重試（實機上遇過 CDN 在傳輸中途重設連線）；sha256 不符不重試。
async fn download(url: &str, file: &Path, expected: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .context("無法建立 HTTP client")?;
    let mut attempt = 1;
    let actual = loop {
        match download_once(&client, url, file).await {
            Ok(actual) => break actual,
            Err(error) if attempt < DOWNLOAD_ATTEMPTS => {
                tracing::warn!(url, attempt, "下載失敗，稍後重試：{error:#}");
                tokio::time::sleep(RETRY_DELAY).await;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    };
    if !actual.eq_ignore_ascii_case(expected) {
        let _ = std::fs::remove_file(file);
        bail!("{url} 的 sha256 不符（預期 {expected}，實際 {actual}），不安裝");
    }
    Ok(())
}

/// 下載一次，回傳內容的 sha256（小寫十六進位）。
async fn download_once(client: &reqwest::Client, url: &str, file: &Path) -> anyhow::Result<String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("無法下載 {url}"))?
        .error_for_status()
        .with_context(|| format!("無法下載 {url}"))?;
    let mut out =
        std::fs::File::create(file).with_context(|| format!("無法建立 {}", file.display()))?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .with_context(|| format!("下載 {url} 時中斷"))?
    {
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            bail!("{url} 超過 {MAX_DOWNLOAD_BYTES} bytes，放棄下載");
        }
        hasher.update(&chunk);
        out.write_all(&chunk)
            .with_context(|| format!("無法寫入 {}", file.display()))?;
    }
    out.flush()?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// 解開 zip。`zip` 只寫入封裝內的相對路徑（`..` 與絕對路徑會被拒絕）。
fn unpack(archive: &Path, dest: &Path) -> anyhow::Result<()> {
    let file =
        std::fs::File::open(archive).with_context(|| format!("無法開啟 {}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).context("下載的檔案不是 zip")?;
    zip.extract(dest)
        .with_context(|| format!("無法解開到 {}", dest.display()))?;
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    std::fs::set_permissions(path, permissions)
        .with_context(|| format!("無法設定 {} 為可執行", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    /// 只有一個執行檔的 zip。
    fn zip_with(command: &str, content: &[u8]) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            writer
                .start_file(command, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    /// 以 HTTP 回應固定內容的本機 server，回傳網址與收到的請求數。
    async fn serve(body: Vec<u8>) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        serve_flaky(body, 0).await
    }

    /// 同 [`serve`]，但前 `broken` 個請求只送一半的內容就關閉連線（模擬傳輸中途被重設）。
    async fn serve_flaky(
        body: Vec<u8>,
        broken: usize,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/agy.zip", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request).await;
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let sent = if n < broken {
                    &body[..body.len() / 2]
                } else {
                    &body[..]
                };
                let _ = socket.write_all(sent).await;
                let _ = socket.shutdown().await;
            }
        });
        (url, hits)
    }

    #[tokio::test]
    async fn 傳輸中途中斷時重試() {
        let zip = zip_with("bin/agent.exe", b"agent");
        let (url, hits) = serve_flaky(zip.clone(), 1).await;
        let build = build(url, sha256_hex(&zip));
        let agents = tempfile::tempdir().unwrap();
        ensure_installed(agents.path(), "agy", "1.0.0", &build)
            .await
            .unwrap();
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    fn build(url: String, sha256: String) -> ArchiveBuild {
        ArchiveBuild {
            target: "test",
            url: Box::leak(url.into_boxed_str()),
            sha256: Box::leak(sha256.into_boxed_str()),
            command: "bin/agent.exe",
            args: &[],
        }
    }

    #[tokio::test]
    async fn 下載並驗證_sha256_後解開_已安裝時不再下載() {
        let zip = zip_with("bin/agent.exe", b"agent");
        let (url, hits) = serve(zip.clone()).await;
        let build = build(url, sha256_hex(&zip));
        let agents = tempfile::tempdir().unwrap();
        let command = ensure_installed(agents.path(), "agy", "1.0.0", &build)
            .await
            .unwrap();
        assert_eq!(command, command_path(agents.path(), "agy", "1.0.0", &build));
        let mut content = String::new();
        std::fs::File::open(&command)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "agent");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&command).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "要可以執行：{mode:o}");
        }
        ensure_installed(agents.path(), "agy", "1.0.0", &build)
            .await
            .unwrap();
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        let leftovers: Vec<_> = std::fs::read_dir(agents.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, ["agy@1.0.0"], "暫存目錄要清掉");
    }

    #[tokio::test]
    async fn sha256_不符時不安裝() {
        let zip = zip_with("bin/agent.exe", b"agent");
        let (url, _) = serve(zip).await;
        let build = build(url, "0".repeat(64));
        let agents = tempfile::tempdir().unwrap();
        let error = ensure_installed(agents.path(), "agy", "1.0.0", &build)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("sha256 不符"), "{error:#}");
        assert_eq!(
            std::fs::read_dir(agents.path()).unwrap().count(),
            0,
            "不能留下安裝目錄或暫存檔"
        );
    }

    #[tokio::test]
    async fn 封裝中沒有執行檔時回報錯誤() {
        let zip = zip_with("other.txt", b"x");
        let (url, _) = serve(zip.clone()).await;
        let build = build(url, sha256_hex(&zip));
        let agents = tempfile::tempdir().unwrap();
        let error = ensure_installed(agents.path(), "agy", "1.0.0", &build)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("bin/agent.exe"), "{error:#}");
        assert!(!install_dir(agents.path(), "agy", "1.0.0").exists());
    }

    #[test]
    fn 平台名稱與_acp_registry_相同() {
        let target = current_target().unwrap();
        let (os, arch) = target.split_once('-').unwrap();
        assert!(["windows", "darwin", "linux"].contains(&os), "{target}");
        assert!(["x86_64", "aarch64"].contains(&arch), "{target}");
    }
}
