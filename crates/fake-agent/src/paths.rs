//! 路徑正規化與執行檔解析。
//!
//! Fake Agent 不依賴 Runner 的程式碼，所以在這裡放一份最小的實作：
//! 只做字面上的正規化（處理 `.`、`..`、Windows 磁碟代號大小寫），不碰檔案系統。

use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf, Prefix};

/// 字面上正規化路徑：去掉 `.`、解開 `..`、把 Windows 磁碟代號統一成大寫。
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

fn normalize_prefix(kind: Prefix<'_>, raw: &OsStr) -> OsString {
    match kind {
        Prefix::Disk(letter) => format!("{}:", char::from(letter).to_ascii_uppercase()).into(),
        Prefix::VerbatimDisk(letter) => {
            format!(r"\\?\{}:", char::from(letter).to_ascii_uppercase()).into()
        }
        _ => raw.to_owned(),
    }
}

/// 把劇本中的路徑解析成 `cwd` 內的絕對路徑。路徑跑出 `cwd` 時回傳錯誤訊息。
pub fn resolve_in_cwd(cwd: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = normalize(cwd);
    let candidate = normalize(&root.join(relative));
    if starts_with(&candidate, &root) {
        Ok(candidate)
    } else {
        Err(format!(
            "路徑 {relative} 不在 session cwd（{}）之內",
            root.display()
        ))
    }
}

/// Windows 的路徑不分大小寫，其他平台區分。
fn starts_with(path: &Path, base: &Path) -> bool {
    if cfg!(windows) {
        let mut path_parts = path.components();
        base.components().all(|base_part| {
            path_parts.next().is_some_and(|part| {
                part.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&base_part.as_os_str().to_string_lossy())
            })
        })
    } else {
        path.starts_with(base)
    }
}

/// 解析要 spawn 的執行檔。
///
/// - 含路徑分隔的指令（絕對或相對路徑）照原樣使用；Windows 上若沒有副檔名，依 `PATHEXT` 補上。
/// - 只有名稱的指令依 `path_var`（`PATH`）逐一搜尋；Windows 上同時嘗試 `PATHEXT` 的副檔名，
///   這樣 npm 安裝的 `.cmd` shim 也找得到。
/// - 找不到時回傳原本的指令，交給作業系統回報錯誤。
///
/// Rust 標準函式庫在 Windows 上 spawn `.cmd`／`.bat` 時會自己經過 `cmd.exe` 並處理參數跳脫，
/// 所以這裡只需要把完整路徑找出來。
pub fn resolve_command(
    command: &Path,
    path_var: Option<&OsStr>,
    pathext_var: Option<&OsStr>,
) -> PathBuf {
    let extensions = executable_extensions(pathext_var);
    let has_separator = command.components().count() > 1 || command.is_absolute();
    if has_separator {
        return with_extension_candidates(command, &extensions)
            .into_iter()
            .find(|candidate| candidate.is_file())
            .unwrap_or_else(|| command.to_owned());
    }
    let Some(path_var) = path_var else {
        return command.to_owned();
    };
    std::env::split_paths(path_var)
        .flat_map(|dir| with_extension_candidates(&dir.join(command), &extensions))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| command.to_owned())
}

fn executable_extensions(pathext_var: Option<&OsStr>) -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let raw = pathext_var
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_owned());
    raw.split(';')
        .map(str::trim)
        .filter(|ext| ext.starts_with('.') && ext.len() > 1)
        .map(str::to_ascii_lowercase)
        .collect()
}

fn with_extension_candidates(base: &Path, extensions: &[String]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if base.extension().is_some() || extensions.is_empty() {
        candidates.push(base.to_owned());
    }
    if base.extension().is_none() {
        for ext in extensions {
            let mut name = base.as_os_str().to_owned();
            name.push(ext);
            candidates.push(PathBuf::from(name));
        }
    }
    candidates
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
        assert_eq!(
            normalize(Path::new("../../a")),
            Path::new("..").join("..").join("a")
        );
    }

    #[test]
    fn 解析_cwd_內的相對路徑() {
        let cwd = std::env::temp_dir().join("w");
        let resolved = resolve_in_cwd(&cwd, "src/../README.md").unwrap();
        assert_eq!(resolved, normalize(&cwd.join("README.md")));
        assert!(resolved.is_absolute());
    }

    #[test]
    fn 拒絕跑出_cwd_的路徑() {
        let cwd = std::env::temp_dir().join("w");
        assert!(resolve_in_cwd(&cwd, "../outside.txt").is_err());
        assert!(resolve_in_cwd(&cwd, "a/../../outside.txt").is_err());
        let outside = std::env::temp_dir().join("other").join("x.txt");
        assert!(resolve_in_cwd(&cwd, &outside.to_string_lossy()).is_err());
    }

    #[test]
    fn 接受_cwd_內的絕對路徑() {
        let cwd = std::env::temp_dir().join("w");
        let inside = cwd.join("x.txt");
        assert_eq!(
            resolve_in_cwd(&cwd, &inside.to_string_lossy()).unwrap(),
            normalize(&inside)
        );
    }

    #[cfg(windows)]
    #[test]
    fn 磁碟代號大小寫不同仍視為同一個目錄() {
        assert_eq!(
            normalize(Path::new(r"c:\Users\x")),
            PathBuf::from(r"C:\Users\x")
        );
        let resolved = resolve_in_cwd(Path::new(r"c:\work"), r"C:\WORK\a.txt").unwrap();
        assert_eq!(resolved, PathBuf::from(r"C:\WORK\a.txt"));
    }

    #[test]
    fn 依_path_找到執行檔() {
        let dir = std::env::temp_dir().join(format!("fake agent resolve {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_name = if cfg!(windows) { "tool.cmd" } else { "tool" };
        let file = dir.join(file_name);
        std::fs::write(&file, "").unwrap();
        let path_var = std::env::join_paths([Path::new("does-not-exist"), dir.as_path()]).unwrap();

        let resolved = resolve_command(Path::new("tool"), Some(&path_var), None);
        assert_eq!(resolved, file);

        // 已經是完整路徑時照原樣使用。
        assert_eq!(resolve_command(&file, Some(&path_var), None), file);
        // 找不到時回傳原本的名稱。
        assert_eq!(
            resolve_command(Path::new("missing-tool"), Some(&path_var), None),
            PathBuf::from("missing-tool")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn 沒有副檔名的完整路徑會補上_pathext() {
        let dir = std::env::temp_dir().join(format!("fake agent ext {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("shim.cmd");
        std::fs::write(&file, "").unwrap();
        let resolved = resolve_command(&dir.join("shim"), None, Some(OsStr::new(".EXE;.CMD")));
        assert_eq!(resolved, file);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
