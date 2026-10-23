//! 由 Runner 代管安裝的 npm 套件（Claude Code 的 ACP adapter）。
//!
//! 安裝在 `<狀態目錄>/agents/<套件>@<版本>/`，以 `npm install --prefix` 安裝精確版本，
//! 之後以 `node <entry>` 啟動。npm 透過 `.cmd` shim 解析（Windows）。

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};

use crate::process::{self, ProcessSpec};

/// 安裝目錄名稱：把 `@scope/name` 的 `/` 換掉，避免多一層目錄。
fn prefix_dir(agents_dir: &Path, package: &str, version: &str) -> PathBuf {
    agents_dir.join(format!("{}@{version}", package.replace('/', "__")))
}

/// 安裝目錄的 `node_modules`。
pub fn node_modules(agents_dir: &Path, package: &str, version: &str) -> PathBuf {
    prefix_dir(agents_dir, package, version).join("node_modules")
}

/// 套件進入點的完整路徑。
pub fn entry_path(agents_dir: &Path, package: &str, version: &str, entry: &str) -> PathBuf {
    let mut path = node_modules(agents_dir, package, version);
    for part in package.split('/') {
        path.push(part);
    }
    for part in entry.split('/') {
        path.push(part);
    }
    path
}

/// 確保套件已安裝；已安裝時不做任何事。
pub async fn ensure_installed(
    agents_dir: &Path,
    package: &str,
    version: &str,
    entry: &str,
) -> anyhow::Result<PathBuf> {
    let entry_file = entry_path(agents_dir, package, version, entry);
    if entry_file.is_file() {
        return Ok(entry_file);
    }
    let prefix = prefix_dir(agents_dir, package, version);
    std::fs::create_dir_all(&prefix).with_context(|| format!("無法建立 {}", prefix.display()))?;
    let spec = ProcessSpec::new("npm")
        .args(["install", "--prefix"])
        .arg(prefix.as_os_str())
        .args(["--no-audit", "--no-fund", "--omit=dev", "--save-exact"])
        .arg(format!("{package}@{version}"))
        .cwd(&prefix);
    tracing::info!(package, version, "安裝 ACP adapter");
    let output = process::run(&spec).await?;
    if !output.success() || !entry_file.is_file() {
        bail!("安裝 {package}@{version} 失敗：{}", output.combined());
    }
    Ok(entry_file)
}

/// `node --version` 的主版本；找不到 Node 時回傳 `None`。
pub async fn node_major_version() -> Option<u32> {
    let output = process::run(&ProcessSpec::new("node").arg("--version"))
        .await
        .ok()?;
    parse_node_major(&output.stdout)
}

fn parse_node_major(raw: &str) -> Option<u32> {
    raw.trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 進入點路徑包含版本() {
        let path = entry_path(Path::new("/a"), "@scope/pkg", "1.2.3", "dist/index.js");
        let text = path.to_string_lossy().replace('\\', "/");
        assert_eq!(
            text,
            "/a/@scope__pkg@1.2.3/node_modules/@scope/pkg/dist/index.js"
        );
    }

    #[test]
    fn 解析_node_版本() {
        assert_eq!(parse_node_major("v24.1.0\n"), Some(24));
        assert_eq!(parse_node_major("22.0.0"), Some(22));
        assert_eq!(parse_node_major("garbage"), None);
    }
}
