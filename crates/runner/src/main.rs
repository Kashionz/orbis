use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use orbis_protocol::connection::HelloRejectReason;
use orbis_protocol::names;
use orbis_protocol::sidecar::SidecarConnectionState;
use orbis_runner::config::{ConfigArgs, ConnectConfig, ENV_LOG};
use orbis_runner::connection::{NeedsPairing, Rejected};
use orbis_runner::home::RunnerHome;
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
    /// token 是 base64url，可能以 `-` 開頭，所以值不會被當成另一個參數（issue #21）。
    #[arg(long, value_name = "TOKEN", allow_hyphen_values = true)]
    pairing_token: Option<String>,

    /// 在 UI 上顯示的名稱，預設是主機名稱。
    #[arg(long)]
    name: Option<String>,

    /// 本機目錄（設定檔 runner.toml 與狀態目錄），預設是家目錄下的設定目錄。
    /// 未指定時讀取環境變數 <前綴>HOME。環境變數 <前綴>RUNNER_STATE_DIR 只覆寫狀態目錄。
    #[arg(long, value_name = "DIR", global = true)]
    home: Option<PathBuf>,

    /// 由 Desktop 代管：stdout 輸出 JSON 狀態、從 stdin 讀指令，stdin 關閉時結束。
    #[arg(long)]
    sidecar: bool,

    /// 以 stdio 提供 Orbis MCP server（Runner 注入到 Agent 的 session，ARCHITECTURE §9）。
    #[arg(long, hide = true)]
    mcp_bridge: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, clap::Subcommand)]
enum Command {
    /// 登入需要由 Runner 代為登入的 Agent（例如 antigravity）。Agent 自己開瀏覽器並保存認證，
    /// Runner 不讀也不存認證內容。
    Login {
        /// Agent Profile 的 id。
        agent: String,
        /// ACP 的認證方式，預設是 Agent Profile 指定的方式。
        #[arg(long)]
        method: Option<String>,
    },
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
    if cli.mcp_bridge {
        // stdout 是 MCP 的通道，不輸出 log。
        return match orbis_runner::orbis_mcp::bridge::serve_stdio().await {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e:#}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    init_tracing();
    if let Some(Command::Login { agent, method }) = &cli.command {
        return match login(cli.home.clone(), agent, method.as_deref()).await {
            Ok(()) => {
                println!("{agent} 已登入");
                std::process::ExitCode::SUCCESS
            }
            Err(e) => {
                error!("{e:#}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    let code = match run(cli).await {
        Ok(()) => ExitCode::Normal,
        Err(e) => {
            error!("{e:#}");
            exit_code(&e)
        }
    };
    // 直接結束：sidecar 讀 stdin 的阻塞執行緒會讓 runtime 一直等下去（例如 Runner token 被撤銷時
    // 要以結束碼離開，但 Desktop 還沒關 stdin）。Run 的程序樹已在 `run` 中結束。
    std::process::exit(code as i32)
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

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 開啟 Runner 的本機目錄（`--home`、環境變數 `<前綴>HOME`、預設位置）。
fn open_home(home: Option<PathBuf>) -> anyhow::Result<RunnerHome> {
    RunnerHome::open_with(
        home.or_else(|| env_path(names::ENV_HOME)),
        env_path(names::ENV_RUNNER_STATE_DIR),
    )
}

async fn login(home: Option<PathBuf>, agent: &str, method: Option<&str>) -> anyhow::Result<()> {
    let home = open_home(home)?;
    info!(agent, "啟動 Agent 並開始登入，請在開啟的瀏覽器中完成");
    orbis_runner::login::login(&home, agent, method, orbis_runner::login::LOGIN_TIMEOUT).await
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    // Windows 上 PATH 的 git 必須是 Git for Windows（不是 WSL 的 git），否則所有 Worktree 操作都會失敗。
    orbis_runner::git::check_native_git().await?;
    let home = Arc::new(open_home(cli.home)?);
    info!(
        home = %home.root().display(),
        state_dir = %home.state_dir().display(),
        "Runner 本機目錄"
    );
    let config = ConnectConfig::resolve(
        ConfigArgs {
            server: cli.server,
            pairing_token: cli.pairing_token,
            name: cli.name,
        },
        home.settings(),
        |name| std::env::var(name).ok(),
    )?;
    let config = ConnectConfig {
        repair_with_pairing_token: !cli.sidecar,
        ..config
    };
    let (supervisor, frames) = Supervisor::new(home)?;
    let (shutdown_tx, shutdown) = watch::channel(false);
    let (state_tx, state) = watch::channel((SidecarConnectionState::Connecting, None));

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
