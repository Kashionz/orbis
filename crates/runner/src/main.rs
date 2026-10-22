use clap::Parser;

/// Orbis Runner。
#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    /// 以 JSON 輸出名稱常數後結束（供跨語言一致性測試使用）。
    #[arg(long)]
    print_names: bool,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if cli.print_names {
        println!(
            "{}",
            serde_json::to_string_pretty(&orbis_protocol::names::all())?
        );
        return Ok(());
    }
    anyhow::bail!("尚未實作：連線到 Server（見 docs/prompts/00-foundation.md 交付項目 7）")
}
