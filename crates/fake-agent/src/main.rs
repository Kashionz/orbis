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
    #[arg(long, required_unless_present = "hold")]
    script: Option<PathBuf>,

    /// 不講 ACP，只是一直執行到被結束（劇本的 `spawn_child` 步驟用來模擬背景程序）。
    #[arg(long, hide = true)]
    hold: bool,

    /// session 保存目錄：指定時支援 `session/load`（與 `session/resume`），
    /// 讓另一個 Fake Agent 程序從同一個 session 的下一個回合接續。
    #[arg(long, value_name = "DIR")]
    state_dir: Option<PathBuf>,

    /// 有保存目錄時不宣告 `session/resume`，只支援 `session/load`。
    #[arg(long)]
    no_resume: bool,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    if cli.hold {
        std::future::pending::<()>().await;
    }
    let Some(path) = cli.script else {
        return ExitCode::from(2);
    };
    let script = match Script::from_path(&path) {
        Ok(script) => script,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    let options = agent::Options {
        state_dir: cli.state_dir,
        resume: !cli.no_resume,
    };
    match agent::serve_stdio_with(script, options).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ACP 連線錯誤：{error:?}");
            ExitCode::FAILURE
        }
    }
}
