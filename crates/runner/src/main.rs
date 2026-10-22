use clap::Parser;
use orbis_protocol::names;
use orbis_runner::config::{ConfigArgs, ConnectConfig, ENV_LOG};
use tracing::info;
use tracing_subscriber::EnvFilter;

/// Orbis Runner。
#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    /// 以 JSON 輸出名稱常數後結束（供跨語言一致性測試使用）。
    #[arg(long)]
    print_names: bool,

    /// Server 的 base URL，例如 http://localhost:4000。未指定時讀取環境變數 <前綴>SERVER_URL。
    #[arg(long, value_name = "URL")]
    server: Option<String>,

    /// 第一次連線用的 Pairing token。未指定時讀取環境變數 <前綴>PAIRING_TOKEN。
    #[arg(long, value_name = "TOKEN")]
    pairing_token: Option<String>,

    /// 在 UI 上顯示的名稱，預設是主機名稱。
    #[arg(long)]
    name: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if cli.print_names {
        println!("{}", serde_json::to_string_pretty(&names::all())?);
        return Ok(());
    }

    init_tracing();
    let config = ConnectConfig::resolve(
        ConfigArgs {
            server: cli.server,
            pairing_token: cli.pairing_token,
            name: cli.name,
        },
        |name| std::env::var(name).ok(),
    )?;

    tokio::select! {
        result = orbis_runner::connection::run(&config) => result,
        _ = tokio::signal::ctrl_c() => {
            info!("收到中斷訊號，結束");
            Ok(())
        }
    }
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
