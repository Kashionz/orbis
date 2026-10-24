//! `login` 子指令：由 Runner 代為登入需要 ACP `authenticate` 的 Agent（目前是 Antigravity，
//! ARCHITECTURE §7）。
//!
//! Runner 只啟動 Agent 並呼叫 `authenticate`；開瀏覽器、保存認證都是 Agent 自己的事，
//! Runner 不讀也不存認證內容。
//!
//! 登入成功後在狀態目錄記一個「已登入」標記（只有時間）。需要由 Runner 代為登入的 Agent
//! 在有標記之前回報無法使用；Run 遇到 ACP auth_required 時清掉標記（ARCHITECTURE §7）。

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;

use crate::agent::Profiles;
use crate::agent::acp::AcpSession;
use crate::home::RunnerHome;

/// 等人在瀏覽器中完成登入的時間上限。
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// 「已登入」標記的位置：`<狀態目錄>/agents/<agent>.login`。
pub fn marker_path(home: &RunnerHome, agent: &str) -> PathBuf {
    home.agents_dir().join(format!("{agent}.login"))
}

/// 這台 Runner 是否已經代 `agent` 登入過（而且之後沒有遇到 auth_required）。
pub fn logged_in(home: &RunnerHome, agent: &str) -> bool {
    marker_path(home, agent).is_file()
}

/// 記下登入成功（內容只有時間）。
pub fn record(home: &RunnerHome, agent: &str) -> anyhow::Result<()> {
    let path = marker_path(home, agent);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("無法建立 {}", dir.display()))?;
    }
    let now = humantime::format_rfc3339_seconds(std::time::SystemTime::now()).to_string();
    std::fs::write(&path, now).with_context(|| format!("無法寫入 {}", path.display()))
}

/// Agent 回報需要登入：清掉標記，之後回報無法使用。
pub fn forget(home: &RunnerHome, agent: &str) {
    let path = marker_path(home, agent);
    if let Err(error) = std::fs::remove_file(&path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(path = %path.display(), %error, "無法刪除登入標記");
    }
}

/// 需要由 Runner 代為登入、卻還沒登入時的無法使用原因；不需要時回傳 `None`。
pub fn unavailable_reason(
    home: &RunnerHome,
    profile: &crate::agent::AgentProfile,
) -> Option<String> {
    (profile.auth_method.is_some() && !logged_in(home, &profile.id)).then(|| {
        format!(
            "需要先登入：執行 {}",
            crate::agent::login_command(&profile.id)
        )
    })
}

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
    result.with_context(|| format!("{agent} 登入失敗"))?;
    record(home, agent)
}
