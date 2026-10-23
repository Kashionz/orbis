//! 識別碼與時間戳。ID 一律是 UUID v7 字串；newtype 在 JSON 中就是字串本身，TS 端是 `string` 的別名。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
        pub struct $name(pub String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }
    };
}

string_id!(
    /// Run 的 ID。
    RunId
);
string_id!(
    /// Runner 的 ID，由 Server 在 Pairing 時發給 Runner。
    RunnerId
);
string_id!(
    /// 一次 Dispatch 的唯一 ID。過期 Dispatch 回報的結果會被拒絕（ARCHITECTURE §6.1）。
    DispatchId
);

/// RFC 3339 的 UTC 時間字串，例如 `2026-10-23T08:00:00.000Z`。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct Timestamp(pub String);

impl From<&str> for Timestamp {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

string_id!(
    /// Task 的 ID（UUID v7）。Task Key（例如 `ORB-12`）另外以字串傳遞。
    TaskId
);
string_id!(
    /// Blob 的 ID。由上傳的一方產生（UUID v7）。
    BlobId
);
string_id!(
    /// Tool call 的 ID，由 Agent 產生（不一定是 UUID），只在同一個 Run 內唯一。
    ToolCallId
);
string_id!(
    /// 權限請求的 ID，由 Runner 產生（UUID v7）。
    PermissionRequestId
);
string_id!(
    /// 一次 RunControl 的 ID，由 Server 產生（UUID v7），用來對應 Runner 回報的結果。
    RunControlId
);
string_id!(
    /// 一輪 Verification 的 ID，由 Server 產生（UUID v7），即 DB `verifications.id`。
    VerificationId
);
string_id!(
    /// Acceptance Criterion 的 ID（UUID v7）。
    AcceptanceCriterionId
);
string_id!(
    /// 一次 Orbis MCP 工具呼叫轉給 Server 的 ID，由 Runner 產生（UUID v7）。
    /// 重新連線後以同一個 ID 重送，Server 依此去除重複。
    OrbisCallId
);
string_id!(
    /// Child Run 以 `ask_parent` 提出的問題的 ID，由 Server 產生（UUID v7）。
    ChildQuestionId
);
