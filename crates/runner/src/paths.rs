//! 路徑正規化（ARCHITECTURE §6.4）。Runner 內所有路徑比較與回報都要先經過這裡。
//!
//! - 字面上正規化：去掉 `.`、解開 `..`、Windows 磁碟代號統一成大寫、`/` 統一成 `\`。
//! - WSL 的 `/mnt/<drive>/…` 與 Windows 的 `<DRIVE>:\…` 可以互相轉換。
//! - Windows 的路徑比較不分大小寫，其他平台區分。

use std::path::{Component, Path, PathBuf, Prefix};

/// 字面上正規化路徑，不碰檔案系統。
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                out.push(normalize_prefix(prefix.kind(), prefix.as_os_str()))
            }
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            // 不能跨過根目錄；相對路徑開頭的 `..` 保留。
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn normalize_prefix(kind: Prefix<'_>, raw: &std::ffi::OsStr) -> std::ffi::OsString {
    match kind {
        Prefix::Disk(letter) => format!("{}:", char::from(letter).to_ascii_uppercase()).into(),
        // `\\?\C:\…` 與 `C:\…` 是同一個位置，統一成一般形式，比較時才不會不一致。
        Prefix::VerbatimDisk(letter) => {
            format!("{}:", char::from(letter).to_ascii_uppercase()).into()
        }
        _ => raw.to_owned(),
    }
}

/// 正規化，並在檔案存在時解開 symlink／junction（Windows 上不帶 `\\?\` 前綴）。
/// 用在比較 Agent 回報的路徑與 Worktree 時，避免 `C:\Users\RUNNER~1` 這類別名造成誤判。
pub fn canonical(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(real) => normalize(&real),
        Err(_) => normalize(path),
    }
}

/// 解開路徑中「已存在的最深一層」的 symlink／junction，其餘部分字面接上。
/// 用來判斷一個還不存在的檔案（例如要寫入的目標）實際會落在哪裡。
///
/// 依序走過每一段，每接上一段就嘗試解開連結；`..` 套用在**已解開的實際路徑**上（不先字面化簡，
/// 否則 `link/../x` 會被誤判成連結旁邊的 `x`）。不存在的部分字面接上，但 `..` 退回存在的位置後，
/// 之後的部分仍會繼續解開（例如 `missing/../link/x`）。
pub fn resolve_existing(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => {
                out.push(part);
                if let Ok(real) = std::fs::canonicalize(&out) {
                    out = normalize(&real);
                }
            }
        }
    }
    normalize(&out)
}

/// `path` 是否等於 `base` 或在 `base` 之內（兩者都會先正規化）。
pub fn is_within(path: &Path, base: &Path) -> bool {
    let path = normalize(path);
    let base = normalize(base);
    let mut parts = path.components();
    base.components().all(|base_part| {
        parts
            .next()
            .is_some_and(|part| same_component(part, base_part))
    })
}

fn same_component(a: Component<'_>, b: Component<'_>) -> bool {
    if cfg!(windows) {
        a.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    } else {
        a == b
    }
}

/// 兩個路徑是否指向同一個位置（字面比較，Windows 不分大小寫）。
pub fn same_path(a: &Path, b: &Path) -> bool {
    is_within(a, b) && is_within(b, a)
}

/// `path` 相對於 `base`、以 `/` 分隔的路徑；`path` 不在 `base` 內時回傳 `None`。
pub fn relative_slash(path: &Path, base: &Path) -> Option<String> {
    if !is_within(path, base) {
        return None;
    }
    let path = normalize(path);
    let depth = normalize(base).components().count();
    let parts: Vec<String> = path
        .components()
        .skip(depth)
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

/// 給人看、也給 Event 用的路徑字串：Worktree 內用相對路徑（`/` 分隔），之外用正規化的絕對路徑
/// （協定 `ToolCallLocation::path` 的規則）。
pub fn display_for_event(path: &Path, worktree: &Path) -> String {
    let resolved = if path.is_absolute() {
        normalize(path)
    } else {
        normalize(&worktree.join(path))
    };
    relative_slash(&resolved, worktree).unwrap_or_else(|| resolved.to_string_lossy().into_owned())
}

/// WSL 的 `/mnt/<drive>/rest` 轉成 Windows 的 `<DRIVE>:\rest`；不是這種形式時回傳 `None`。
pub fn wsl_mount_to_windows(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/mnt/")?;
    let mut chars = rest.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    let after = chars.as_str();
    if !(after.is_empty() || after.starts_with('/')) {
        return None;
    }
    let tail = after.trim_start_matches('/').replace('/', "\\");
    Some(format!("{}:\\{tail}", drive.to_ascii_uppercase()))
}

/// Windows 的 `<drive>:\rest`（或 `/` 分隔）轉成 WSL 的 `/mnt/<drive>/rest`；不是這種形式時回傳 `None`。
pub fn windows_to_wsl_mount(path: &str) -> Option<String> {
    let mut chars = path.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    let rest = chars.as_str().strip_prefix(':')?;
    if !(rest.is_empty() || rest.starts_with('\\') || rest.starts_with('/')) {
        return None;
    }
    let tail = rest.trim_start_matches(['\\', '/']).replace('\\', "/");
    let mut out = format!("/mnt/{}", drive.to_ascii_lowercase());
    if !tail.is_empty() {
        out.push('/');
        out.push_str(&tail);
    }
    Some(out)
}

/// 目前是否跑在 WSL 中（Linux 核心版本字串含 `microsoft`）。
pub fn running_in_wsl() -> bool {
    cfg!(target_os = "linux")
        && std::fs::read_to_string("/proc/version")
            .is_ok_and(|v| v.to_ascii_lowercase().contains("microsoft"))
}

/// 是否為 WSL 掛載的 Windows 磁碟（`/mnt/<drive>/…`）。Worktree 不可以放在這裡（§6.2）。
pub fn is_wsl_windows_mount(path: &Path) -> bool {
    wsl_mount_to_windows(&path.to_string_lossy()).is_some()
}

/// 展開開頭的 `~`（家目錄）。
pub fn expand_home(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_owned();
    }
    match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        Some(rest) => home.join(rest),
        None => PathBuf::from(raw),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 正規化會解開點與上一層() {
        assert_eq!(
            normalize(Path::new("a/./b/../c")),
            PathBuf::from("a").join("c")
        );
        assert_eq!(normalize(Path::new("../a")), PathBuf::from("..").join("a"));
    }

    #[test]
    fn 判斷是否在目錄內() {
        let base = std::env::temp_dir().join("wt");
        assert!(is_within(&base.join("a").join("b.txt"), &base));
        assert!(is_within(&base, &base));
        assert!(!is_within(&base.join("..").join("other"), &base));
        // 前綴相同但不是同一個目錄
        assert!(!is_within(&std::env::temp_dir().join("wt2"), &base));
    }

    #[test]
    fn 相對路徑一律用斜線() {
        let base = std::env::temp_dir().join("wt");
        assert_eq!(
            relative_slash(&base.join("src").join("main.rs"), &base).as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(relative_slash(&base, &base).as_deref(), Some(""));
        assert_eq!(relative_slash(&std::env::temp_dir(), &base), None);
    }

    #[test]
    fn event_路徑在_worktree_外時用絕對路徑() {
        let base = std::env::temp_dir().join("wt");
        assert_eq!(display_for_event(Path::new("src/a.rs"), &base), "src/a.rs");
        let outside = std::env::temp_dir().join("other.txt");
        assert_eq!(
            display_for_event(&outside, &base),
            normalize(&outside).to_string_lossy()
        );
    }

    #[test]
    fn wsl_掛載路徑與_windows_路徑互轉() {
        assert_eq!(
            wsl_mount_to_windows("/mnt/c/Users/me/x").as_deref(),
            Some(r"C:\Users\me\x")
        );
        assert_eq!(wsl_mount_to_windows("/mnt/d").as_deref(), Some(r"D:\"));
        assert_eq!(wsl_mount_to_windows("/mnt/data/x"), None);
        assert_eq!(wsl_mount_to_windows("/home/me"), None);
        assert_eq!(
            windows_to_wsl_mount(r"c:\Users\me\x").as_deref(),
            Some("/mnt/c/Users/me/x")
        );
        assert_eq!(
            windows_to_wsl_mount("D:/a/b").as_deref(),
            Some("/mnt/d/a/b")
        );
        assert_eq!(windows_to_wsl_mount("relative"), None);
        assert!(is_wsl_windows_mount(Path::new("/mnt/c/ob")));
        assert!(!is_wsl_windows_mount(Path::new("/home/me/wt")));
    }

    #[test]
    fn 展開家目錄() {
        let home = Path::new("/home/me");
        assert_eq!(expand_home("~/wt", home), home.join("wt"));
        assert_eq!(expand_home("~", home), home);
        assert_eq!(expand_home("/abs", home), PathBuf::from("/abs"));
    }

    #[cfg(windows)]
    #[test]
    fn 磁碟代號大小寫不同仍是同一個路徑() {
        assert_eq!(
            normalize(Path::new(r"c:\Users\x")),
            PathBuf::from(r"C:\Users\x")
        );
        assert_eq!(
            normalize(Path::new(r"\\?\c:\Users\x")),
            PathBuf::from(r"C:\Users\x")
        );
        assert!(same_path(Path::new(r"c:\work\A"), Path::new(r"C:\WORK\a")));
        assert!(is_within(
            Path::new(r"c:/work/a/b.txt"),
            Path::new(r"C:\Work")
        ));
        assert_eq!(
            relative_slash(Path::new(r"c:\work\src\a.rs"), Path::new(r"C:\WORK")).as_deref(),
            Some("src/a.rs")
        );
    }

    #[test]
    fn 解開已存在部分的連結() {
        let dir = tempfile::Builder::new()
            .prefix("orbis paths ")
            .tempdir()
            .unwrap();
        let resolved = resolve_existing(&dir.path().join("not").join("yet.txt"));
        assert_eq!(resolved, canonical(dir.path()).join("not").join("yet.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn worktree_內指向外面的連結視為在外面() {
        let dir = tempfile::Builder::new()
            .prefix("orbis paths ")
            .tempdir()
            .unwrap();
        let wt = dir.path().join("wt");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, wt.join("link")).unwrap();
        let target = resolve_existing(&wt.join("link").join("secret.txt"));
        assert!(!is_within(&target, &canonical(&wt)));
        // `link/../x`：`..` 要套用在連結解開後的位置（outside 的上一層），不是 wt。
        let sneaky = resolve_existing(&wt.join("link").join("..").join("x"));
        assert_eq!(sneaky, canonical(dir.path()).join("x"));
        assert!(!is_within(&sneaky, &canonical(&wt)));
        // 先經過不存在的目錄再 `..` 回來，之後的連結仍要解開。
        let detour = resolve_existing(&wt.join("missing").join("..").join("link").join("y"));
        assert_eq!(detour, canonical(&outside).join("y"));
    }

    #[cfg(windows)]
    #[test]
    fn canonical_不帶_verbatim_前綴() {
        let dir = tempfile::Builder::new()
            .prefix("orbis paths ")
            .tempdir()
            .unwrap();
        let real = canonical(dir.path());
        assert!(
            !real.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            real.display()
        );
        assert!(same_path(&real, &canonical(&dir.path().join("."))));
    }
}
