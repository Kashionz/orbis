//! `login` 子指令：由 Runner 代為登入需要 ACP `authenticate` 的 Agent（目前是 Antigravity，
//! ARCHITECTURE §7）。
//!
//! Runner 只啟動 Agent 並呼叫 `authenticate`；開瀏覽器、保存認證都是 Agent 自己的事，
//! Runner 不讀也不存認證內容。

use std::time::Duration;

use anyhow::Context;

use crate::agent::Profiles;
use crate::agent::acp::AcpSession;
use crate::home::RunnerHome;

/// 等人在瀏覽器中完成登入的時間上限。
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// 登入 `agent`。`method` 未指定時用 Agent Profile 預設的認證方式。
pub async fn login(
    home: &RunnerHome,
    agent: &str,
    method: Option<&str>,
    timeout: Duration,
) -> anyhow::Result<()> {
    let profiles = Profiles::from_settings(home.settings());
    let Some(profile) = profiles.get(agent) else {
        let ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
        anyhow::bail!("沒有 Agent「{agent}」，可以用的有：{}", ids.join("、"));
    };
    let Some(method) = method.or(profile.auth_method) else {
        anyhow::bail!("{agent} 的登入由它自己的 CLI 處理，不需要這個指令");
    };
    let agents_dir = home.agents_dir();
    profile
        .launch
        .ensure_installed(&agents_dir)
        .await
        .with_context(|| format!("無法安裝 {agent}"))?;
    let spec = profile.launch_spec(&agents_dir)?;
    // 在狀態目錄下一個全新的空目錄中啟動（Agent 會讀 cwd 的專案設定）。
    let cwd = home.state_dir().join("login").join(&profile.id);
    let _ = std::fs::remove_dir_all(&cwd);
    std::fs::create_dir_all(&cwd).with_context(|| format!("無法建立 {}", cwd.display()))?;
    let result = AcpSession::login(profile, spec, &cwd, method, timeout).await;
    let _ = std::fs::remove_dir_all(&cwd);
    result.with_context(|| format!("{agent} 登入失敗"))
}
