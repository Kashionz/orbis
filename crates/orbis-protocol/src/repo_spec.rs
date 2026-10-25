//! 本機 Repo 的 Repo Spec 提交（協定版本 3，ARCHITECTURE §12.1、ADR-0013）。
//!
//! GitHub Repo 的 Spec 由 Server 以 GitHub App 開 PR；本機 Repo 沒有 PR，Spec 直接 commit 到基準分支。
//! Server 碰不到本機 checkout，所以把內容交給**提交者自己**、`runner.toml` 有對應這個 Repo 的
//! Local Runner：Server 送 [`RepoSpecCommit`]，Runner 回 [`RepoSpecCommitResult`]（以 `commit_id` 對應）。
//! 這不屬於任何 Run，所以不用 RunControl。Runner 不在線時 Server 直接回錯誤，不排隊。
//!
//! commit 的位置與本機合併（RunControl `merge_local`）相同：基準分支沒有簽出時在暫時的 worktree 中
//! commit；已簽出且工作目錄乾淨時直接在 checkout 中 commit；工作目錄有未 commit 的變更時不 commit。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::enums::wire_enum;
use crate::ids::RepoSpecCommitId;

/// 把一份 Spec 的內容 commit 到本機 Repo 的基準分支（Server→Runner）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RepoSpecCommit {
    pub commit_id: RepoSpecCommitId,
    /// 本機 Repo 的名稱（`runner.toml` 的 key）。
    pub repo: String,
    /// 基準分支。
    pub base_branch: String,
    /// Repo 內的相對路徑，以 `/` 分隔。Server 已檢查只能是 `.github/` 以外的 `.md` 檔。
    pub path: String,
    /// 檔案的完整新內容（UTF-8）。
    pub content: String,
    /// commit 訊息（Server 組好，含 `Co-authored-by`）。
    pub message: String,
}

/// [`RepoSpecCommit`] 的結果（Runner→Server）。每個 `repo_spec_commit` 恰好回一次。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RepoSpecCommitResult {
    pub commit_id: RepoSpecCommitId,
    #[serde(flatten)]
    pub outcome: RepoSpecCommitOutcome,
}

/// 結果，以 `outcome` 區分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum RepoSpecCommitOutcome {
    /// 已 commit。
    Committed {
        /// 新的 commit SHA（40 個十六進位字元）。
        commit_sha: String,
    },
    /// 內容和基準分支上的檔案相同，沒有 commit。
    Unchanged {
        /// 基準分支目前的 HEAD。
        commit_sha: String,
    },
    /// 沒有 commit。
    Failed {
        reason: RepoSpecCommitFailure,
        /// 給人看的說明（已遮蔽 secret），例如 git 的輸出。
        message: String,
    },
}

wire_enum! {
    /// Repo Spec 提交失敗的原因。
    RepoSpecCommitFailure {
        /// `runner.toml` 中沒有這個 Repo 的對應。
        RepoUnavailable => "repo_unavailable",
        /// 基準分支已在 checkout 中簽出，而且工作目錄有未 commit 的變更。
        WorkingTreeDirty => "working_tree_dirty",
        /// 其他 git 操作失敗。
        Failed => "failed",
    }
}
