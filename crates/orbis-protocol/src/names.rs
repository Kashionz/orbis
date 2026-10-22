//! 名稱常數。產品名稱、設定檔名、環境變數前綴只能從這裡取得，不可以寫死字串。
//!
//! TS 版在 `packages/api-contract/src/names.ts`，兩邊由測試比對
//! （`orbis-runner --print-names` 的輸出必須等於 TS 版）。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PRODUCT_NAME: &str = "Orbis";
/// 小寫識別字，用在執行檔名稱、分支前綴等需要小寫的地方。
pub const PRODUCT_SLUG: &str = "orbis";
/// Repo 內與家目錄下的設定目錄。
pub const CONFIG_DIR: &str = ".orbis";
/// `CONFIG_DIR` 內的設定檔名（ARCHITECTURE §6.3）。
pub const CONFIG_FILE: &str = "config.toml";
/// 所有環境變數的前綴。
pub const ENV_PREFIX: &str = "ORBIS_";
/// Run 分支名稱的前綴（ARCHITECTURE §6.2）。
pub const BRANCH_PREFIX: &str = "orbis/";
/// Windows 上的 Worktree 根目錄（盡量短，ARCHITECTURE §6.2）。
pub const WORKTREE_ROOT_WINDOWS: &str = r"C:\ob";
/// macOS／Linux 上的 Worktree 根目錄，`~` 代表家目錄。
pub const WORKTREE_ROOT_UNIX: &str = "~/.orbis/wt";

/// `~/<CONFIG_DIR>/` 下 Runner 的設定檔（給人編輯：Server 網址、Repo 對應、Agent 設定）。
pub const RUNNER_CONFIG_FILE: &str = "runner.toml";
/// `~/<CONFIG_DIR>/` 下 Runner 的狀態目錄（Runner token、port 分配、信任紀錄、Event 暫存）。
pub const RUNNER_STATE_DIR: &str = "runner";

/// Runner 讀取的環境變數：覆寫整個 `~/<CONFIG_DIR>`（設定檔與狀態目錄），供測試使用。
pub const ENV_HOME: &str = "ORBIS_HOME";
/// Runner 讀取的環境變數：只覆寫狀態目錄，`RUNNER_CONFIG_FILE` 仍從 `~/<CONFIG_DIR>/` 讀取。
/// Desktop 代管的 Runner 用它，避免和手動啟動的 Runner 共用 Runner token。
pub const ENV_RUNNER_STATE_DIR: &str = "ORBIS_RUNNER_STATE_DIR";

/// 注入到 Worktree 程序的環境變數（ARCHITECTURE §6.3）。
pub const ENV_ROOT_PATH: &str = "ORBIS_ROOT_PATH";
pub const ENV_WORKTREE_PATH: &str = "ORBIS_WORKTREE_PATH";
pub const ENV_PORT: &str = "ORBIS_PORT";
pub const ENV_RUN_ID: &str = "ORBIS_RUN_ID";
pub const ENV_TASK_KEY: &str = "ORBIS_TASK_KEY";

/// 由 `ENV_PREFIX` 組出完整的環境變數名稱，例如 `env_var("SERVER_URL")`。
/// 各元件自己的設定（資料庫網址、OAuth 等）一律用這個函式組名稱。
pub fn env_var(suffix: &str) -> String {
    format!("{ENV_PREFIX}{suffix}")
}

/// 所有名稱常數，`orbis-runner --print-names` 以 JSON 輸出這個結構。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Names {
    pub product_name: String,
    pub product_slug: String,
    pub config_dir: String,
    pub config_file: String,
    pub env_prefix: String,
    pub branch_prefix: String,
    pub worktree_root_windows: String,
    pub worktree_root_unix: String,
    pub runner_config_file: String,
    pub runner_state_dir: String,
    pub env: WorktreeEnvNames,
    pub runner_env: RunnerEnvNames,
}

/// Runner 讀取的環境變數名稱。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunnerEnvNames {
    pub home: String,
    pub state_dir: String,
}

/// 注入到 Worktree 程序的環境變數名稱。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEnvNames {
    pub root_path: String,
    pub worktree_path: String,
    pub port: String,
    pub run_id: String,
    pub task_key: String,
}

pub fn all() -> Names {
    Names {
        product_name: PRODUCT_NAME.into(),
        product_slug: PRODUCT_SLUG.into(),
        config_dir: CONFIG_DIR.into(),
        config_file: CONFIG_FILE.into(),
        env_prefix: ENV_PREFIX.into(),
        branch_prefix: BRANCH_PREFIX.into(),
        worktree_root_windows: WORKTREE_ROOT_WINDOWS.into(),
        worktree_root_unix: WORKTREE_ROOT_UNIX.into(),
        runner_config_file: RUNNER_CONFIG_FILE.into(),
        runner_state_dir: RUNNER_STATE_DIR.into(),
        runner_env: RunnerEnvNames {
            home: ENV_HOME.into(),
            state_dir: ENV_RUNNER_STATE_DIR.into(),
        },
        env: WorktreeEnvNames {
            root_path: ENV_ROOT_PATH.into(),
            worktree_path: ENV_WORKTREE_PATH.into(),
            port: ENV_PORT.into(),
            run_id: ENV_RUN_ID.into(),
            task_key: ENV_TASK_KEY.into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_derived_from_each_other() {
        assert_eq!(PRODUCT_SLUG, PRODUCT_NAME.to_lowercase());
        assert_eq!(CONFIG_DIR, format!(".{PRODUCT_SLUG}"));
        assert_eq!(ENV_PREFIX, format!("{}_", PRODUCT_SLUG.to_uppercase()));
        assert_eq!(BRANCH_PREFIX, format!("{PRODUCT_SLUG}/"));
        assert!(WORKTREE_ROOT_UNIX.starts_with(&format!("~/{CONFIG_DIR}/")));
    }

    #[test]
    fn worktree_env_names_use_the_prefix() {
        let env = all().env;
        for name in [
            &env.root_path,
            &env.worktree_path,
            &env.port,
            &env.run_id,
            &env.task_key,
        ] {
            assert!(name.starts_with(ENV_PREFIX), "{name} 沒有使用 ENV_PREFIX");
        }
        assert_eq!(env_var("PORT"), ENV_PORT);
        assert_eq!(env_var("HOME"), ENV_HOME);
        assert_eq!(env_var("RUNNER_STATE_DIR"), ENV_RUNNER_STATE_DIR);
    }
}
