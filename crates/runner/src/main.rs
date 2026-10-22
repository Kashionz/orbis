use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use orbis_protocol::connection::HelloRejectReason;
use orbis_protocol::names;
use orbis_runner::config::{ConfigArgs, ConnectConfig, ENV_LOG};
use orbis_runner::connection::{NeedsPairing, Rejected};
use orbis_runner::contract::SidecarState;
use orbis_runner::home::{ENV_HOME, RunnerHome};
use orbis_runner::sidecar::{self, ExitCode};
use orbis_runner::supervisor::Supervisor;
use tokio::sync::watch;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

/// Orbis Runner。
#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    /// 以 JSON 輸出名稱常數後結束（供跨語言一致性測試使用）。
    #[arg(long)]
    print_names: bool,

    /// Server 的 base URL，例如 http://localhost:4000。未指定時讀取環境變數 <前綴>SERVER_URL，
    /// 再來是 runner.toml 的 server。
    #[arg(long, value_name = "URL")]
    server: Option<String>,

    /// 第一次連線用的 Pairing token。未指定時讀取環境變數 <前綴>PAIRING_TOKEN。
    /// 已經和這個 Server 完成 Pairing（本機有 Runner token）時忽略。
    #[arg(long, value_name = "TOKEN")]
    pairing_token: Option<String>,

    /// 在 UI 上顯示的名稱，預設是主機名稱。
    #[arg(long)]
    name: Option<String>,

    /// 本機目錄（設定檔 runner.toml 與狀態目錄），預設是家目錄下的設定目錄。
    /// 未指定時讀取環境變數 <前綴>HOME。
    #[arg(long, value_name = "DIR")]
    home: Option<PathBuf>,

    /// 由 Desktop 代管：stdout 輸出 JSON 狀態、從 stdin 讀指令，stdin 關閉時結束。
    #[arg(long)]
    sidecar: bool,
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    if cli.print_names {
        match serde_json::to_string_pretty(&names::all()) {
            Ok(json) => println!("{json}"),
            Err(e) => {
                eprintln!("{e}");
                return std::process::ExitCode::FAILURE;
            }
        }
        return std::process::ExitCode::SUCCESS;
    }
    init_tracing();
    let code = match run(cli).await {
        Ok(()) => ExitCode::Normal,
        Err(e) => {
            error!("{e:#}");
            exit_code(&e)
        }
    };
    std::process::ExitCode::from(code as u8)
}

fn exit_code(e: &anyhow::Error) -> ExitCode {
    if let Some(rejected) = e.downcast_ref::<Rejected>() {
        if rejected.0.reason == HelloRejectReason::VersionMismatch {
            return ExitCode::VersionMismatch;
        }
        if rejected.needs_pairing() {
            return ExitCode::NeedsPairing;
        }
    }
    if e.downcast_ref::<NeedsPairing>().is_some() {
        return ExitCode::NeedsPairing;
    }
    ExitCode::Error
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    let home_dir = cli.home.or_else(|| {
        std::env::var_os(names::env_var(ENV_HOME))
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    });
    let home = Arc::new(RunnerHome::open(home_dir)?);
    info!(home = %home.root().display(), "Runner 本機目錄");
    let config = ConnectConfig::resolve(
        ConfigArgs {
            server: cli.server,
            pairing_token: cli.pairing_token,
            name: cli.name,
        },
        home.settings(),
        |name| std::env::var(name).ok(),
    )?;
    let (supervisor, frames) = Supervisor::new(home)?;
    let (shutdown_tx, shutdown) = watch::channel(false);
    let (state_tx, state) = watch::channel((SidecarState::Connecting, None));

    if cli.sidecar {
        tokio::spawn(sidecar::report_status(supervisor.clone(), state));
        tokio::spawn(sidecar::read_commands(
            supervisor.clone(),
            shutdown_tx.clone(),
        ));
    }
    {
        let shutdown_tx = shutdown_tx.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                info!("收到中斷訊號，結束");
                shutdown_tx.send_replace(true);
            }
        });
    }

    let result = orbis_runner::connection::run(
        &config,
        supervisor.clone(),
        frames,
        state_tx,
        shutdown,
        Duration::from_secs(1),
    )
    .await;
    supervisor.shutdown().await;
    result
}

/// log 輸出到 stderr；過濾條件取自環境變數 `<前綴>LOG`，預設 `info`。
fn init_tracing() {
    let filter =
        EnvFilter::try_from_env(names::env_var(ENV_LOG)).unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}
