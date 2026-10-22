//! `orbis-fake-agent --script <劇本 YAML 路徑>`：以 stdio 講 ACP v1 的 Fake Agent。

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use orbis_fake_agent::{Script, agent};

/// 依 YAML 劇本行動的 ACP v1 agent，只用於測試。
#[derive(Debug, Parser)]
#[command(version)]
struct Cli {
    /// 劇本 YAML 路徑。
    #[arg(long)]
    script: PathBuf,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let script = match Script::from_path(&cli.script) {
        Ok(script) => script,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    match agent::serve_stdio(script).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ACP 連線錯誤：{error:?}");
            ExitCode::FAILURE
        }
    }
}
