//! 重新產生 `packages/protocol/src/generated`。用法：`cargo gen-protocol [輸出目錄]`。

fn main() -> std::io::Result<()> {
    let out_dir = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(orbis_protocol::typescript::default_out_dir);
    orbis_protocol::typescript::generate(&out_dir)?;
    println!("generated {}", out_dir.display());
    Ok(())
}
