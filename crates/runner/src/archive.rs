//! 封存 Run（ARCHITECTURE §6.2、RunControl `archive`）。
//!
//! Server 在 Run 結束後送 `archive`，這時 Run 已經不在記憶體中：依本機的 Worktree 紀錄
//! （[`RunWorktreeRecord`]）重建 Worktree 資訊，執行 archive hook 後刪除 Worktree，連同 `branch`
//! 模式的 Child Run 一起處理。`consult` 模式的 Child Run 沒有自己的 Worktree，沒有紀錄。
//!
//! - archive hook 只用紀錄中 config commit 的設定檔，而且只在那份設定檔已「永遠允許」時執行：
//!   Run 期間的「允許這次」已經失效，Run 結束後也沒有人可以問。沒有核准時拒絕，Worktree 不刪。
//! - 還有執行中的 Run 在用同一個 Worktree（例如 Feedback Loop 的新 Run）時拒絕。
//! - 已經刪掉的 Worktree（或沒有紀錄的 Run）視為封存完成，重送的 `archive` 不會失敗。

use std::collections::BTreeMap;
use std::path::Path;

use orbis_protocol::control::RunControlRejectReason;

use crate::git::Git;
use crate::home::{RunWorktreeRecord, RunnerHome};
use crate::repo_config::{self, LoadedConfig};
use crate::worktree::{Worktree, WorktreeManager};

/// 封存失敗：回給 Server 的 `rejected`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveError {
    pub reason: RunControlRejectReason,
    pub message: String,
}

fn failed(message: impl Into<String>) -> ArchiveError {
    ArchiveError {
        reason: RunControlRejectReason::Failed,
        message: message.into(),
    }
}

/// 封存 `run_id` 與它的 `branch` 模式 Child Run。`in_use` 回傳正在使用某個 Worktree 的執行中 Run。
pub async fn archive(
    home: &RunnerHome,
    worktrees: &WorktreeManager,
    run_id: &str,
    in_use: impl Fn(&Path) -> Option<String>,
) -> Result<(), ArchiveError> {
    let records = home.run_worktrees();
    // 先處理最深的 Child Run，最後才是自己。
    let mut order = vec![run_id.to_owned()];
    let mut i = 0;
    while i < order.len() {
        let parent = order[i].clone();
        order.extend(
            records
                .iter()
                .filter(|(_, r)| r.parent_run_id.as_deref() == Some(parent.as_str()))
                .map(|(id, _)| id.clone()),
        );
        i += 1;
    }
    for id in order.iter().rev() {
        if let Some(record) = records.get(id) {
            archive_one(home, worktrees, id, record, &records, &in_use).await?;
        }
    }
    Ok(())
}

async fn archive_one(
    home: &RunnerHome,
    worktrees: &WorktreeManager,
    run_id: &str,
    record: &RunWorktreeRecord,
    records: &BTreeMap<String, RunWorktreeRecord>,
    in_use: &impl Fn(&Path) -> Option<String>,
) -> Result<(), ArchiveError> {
    // 同一個 Worktree 的所有紀錄（Feedback Loop 的 Run 沿用前一個 Run 的 Worktree）一起處理。
    let sharing: Vec<String> = records
        .iter()
        .filter(|(_, r)| crate::paths::same_path(&r.path, &record.path))
        .map(|(id, _)| id.clone())
        .collect();
    let forget = |ids: &[String]| {
        home.forget_run_worktrees(ids)
            .map_err(|e| failed(format!("無法更新 Worktree 紀錄：{e:#}")))
    };
    if !record.path.join(".git").exists() {
        return forget(&sharing);
    }
    if let Some(user) = in_use(&record.path) {
        return Err(ArchiveError {
            reason: RunControlRejectReason::InvalidState,
            message: format!("Run {user} 還在使用這個 Worktree，先結束它再封存"),
        });
    }
    let config_text = Git::new(&record.root_checkout)
        .show_file(&record.config_commit, &repo_config::config_path())
        .await
        .map_err(|e| failed(format!("讀不到設定檔：{e}")))?
        .unwrap_or_default();
    let config = LoadedConfig::parse(&config_text)
        .map_err(|e| failed(format!("{} 的格式不正確：{e}", repo_config::config_path())))?;
    let has_hook = config
        .config
        .worktree
        .archive
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty());
    let trusted = home
        .is_trusted(&record.clone_url, &config.hash)
        .map_err(|e| failed(format!("{e:#}")))?;
    if has_hook && !trusted {
        return Err(failed(format!(
            "{} 的 archive 腳本沒有「永遠允許」的核准，Run 結束後無法執行；Worktree 沒有刪除",
            repo_config::config_path()
        )));
    }
    let wt = Worktree {
        path: record.path.clone(),
        root_checkout: record.root_checkout.clone(),
        member_checkout: false,
        branch: record.branch.clone(),
        base_commit: record.base_commit.clone(),
        base_ref: record.base_ref.clone(),
        default_branch: record.default_branch.clone(),
        config_commit: record.config_commit.clone(),
        config,
        port: record.port,
        run_id: run_id.into(),
        task_key: record.task_key.clone(),
        scripts_approved: trusted,
        remote_alignment: Default::default(),
    };
    let removal = worktrees.remove(&wt).await.map_err(|e| failed(e.message))?;
    tracing::info!(
        run_id,
        branch_kept = removal.branch_kept,
        "已封存 Run 的 Worktree"
    );
    forget(&sharing)
}
