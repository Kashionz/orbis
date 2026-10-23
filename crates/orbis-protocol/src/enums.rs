//! 跨元件共用的列舉。TS 端除了型別，`constants.ts` 也會產生對應的值陣列，
//! 讓 api-contract 的 zod schema 與 DB 的 enum 直接沿用，不必重抄一份。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

macro_rules! wire_enum {
    (
        $(#[$meta:meta])*
        $name:ident {
            $( $(#[$vmeta:meta])* $variant:ident => $wire:literal ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
        pub enum $name {
            $( $(#[$vmeta])* #[serde(rename = $wire)] $variant ),+
        }

        impl $name {
            /// 所有值，依宣告順序。
            pub const ALL: &'static [Self] = &[ $( Self::$variant ),+ ];

            /// 傳輸格式中的字串。
            pub const fn as_str(self) -> &'static str {
                match self {
                    $( Self::$variant => $wire ),+
                }
            }
        }
    };
}

/// 讓其他協定模組也能用同一個巨集定義列舉。
pub(crate) use wire_enum;

wire_enum! {
    /// Run 的狀態。Runner 以 `status_changed` Event 回報，Server 與 UI 沿用同一組值。
    RunStatus {
        /// 已建立，等待派工。
        Queued => "queued",
        /// 已送出 DispatchOffer，等待 Runner 接受。
        Dispatched => "dispatched",
        /// Runner 已接受，正在建立 Worktree、執行 setup、啟動 Agent。
        Starting => "starting",
        Running => "running",
        /// 正在執行 Server 要求的 Verification（RunControl `verify`），結束後回到 `awaiting_gate`（review）。
        Verifying => "verifying",
        /// 等待人回覆權限請求，Run 暫停。
        AwaitingPermission => "awaiting_permission",
        /// 偵測到 rate limit，暫停到額度恢復。
        RateLimited => "rate_limited",
        /// 等待 Plan Gate 或 Review Gate 的結果。
        AwaitingGate => "awaiting_gate",
        Completed => "completed",
        Failed => "failed",
        Canceled => "canceled",
    }
}

impl RunStatus {
    /// 是否為終止狀態（之後不會再有狀態變更）。
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Canceled)
    }
}

wire_enum! {
    /// Permission Policy 的等級（ARCHITECTURE §8），預設 `auto`。
    #[derive(Default)]
    PermissionPolicy {
        Manual => "manual",
        #[default]
        Auto => "auto",
        Yolo => "yolo",
    }
}

wire_enum! {
    /// Delegation 的模式（ARCHITECTURE §9）。不提供 `shared`。
    DelegationMode {
        /// 在父 Run 的 Worktree 中唯讀執行。
        Consult => "consult",
        /// 開出子 Worktree 與子分支。
        Branch => "branch",
    }
}

wire_enum! {
    /// Runner 的種類（ARCHITECTURE §6.1）。
    RunnerKind {
        Local => "local",
        Team => "team",
    }
}

wire_enum! {
    /// Gate 的種類（ARCHITECTURE §5）。
    GateKind {
        Plan => "plan",
        Review => "review",
    }
}

wire_enum! {
    /// 人對 Gate 的決定。Review Gate 的退回附帶的行內留言另外以 prompt 送回 Agent。
    GateDecision {
        Approved => "approved",
        Rejected => "rejected",
    }
}

wire_enum! {
    /// Run 為什麼產生。Server 與 UI（Child Run 樹）沿用同一組值。
    RunOrigin {
        /// 人派工。
        Dispatch => "dispatch",
        /// Agent 透過 Orbis MCP 的 `delegate` 產生的 Child Run（ARCHITECTURE §9）。
        Delegation => "delegation",
        /// 判定 `agent`／`browser` 類型 Acceptance Criterion 的 `consult` Child Run（§5.1）。
        Verification => "verification",
        /// 留言中的 @agent 產生的 `consult` Run（§12.3）。
        Mention => "mention",
        /// Feedback Loop 的修正：送回原 Run 的 session 的新 Run（§5.2）。
        FeedbackLoop => "feedback_loop",
    }
}

wire_enum! {
    /// 送給 Agent 的 prompt 的來源，UI 與 log 用來標示。
    PromptSource {
        /// 人直接送出的 prompt（派工的第一個 prompt、@agent 等）。
        User => "user",
        /// Plan Gate 退回時附的意見。
        PlanGate => "plan_gate",
        /// Review Gate 退回時打包的留言（diff 行內留言與 Preview 留言）。
        ReviewGate => "review_gate",
        /// Verification 失敗的原因（§5.1 的自動重試）。
        VerificationRetry => "verification_retry",
        /// PR 上的 review 留言（Feedback Loop）。
        FeedbackReview => "feedback_review",
        /// PR 的 CI 失敗（Feedback Loop）。
        FeedbackCi => "feedback_ci",
        /// Child Run 以 `ask_parent` 提出、由人在 Needs You 回答的問題。
        ChildQuestion => "child_question",
    }
}

wire_enum! {
    /// Acceptance Criterion 的類型（ARCHITECTURE §5.1）。
    AcceptanceCriterionKind {
        /// 在 Worktree 執行指令，exit code 為 0 就算通過。
        Command => "command",
        /// `consult` Run 讀 diff 與 Spec 後判定。
        Agent => "agent",
        /// Agent 透過 Playwright MCP 操作 Preview 後判定。
        Browser => "browser",
        /// 在 Review Gate 由人工打勾，不送給 Runner。
        Manual => "manual",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ALL` 必須包含每一個值；新增值時這裡的 match 會編譯失敗，提醒同步更新。
    #[test]
    fn all_lists_every_variant() {
        fn check<T: Copy + Eq + std::fmt::Debug>(all: &[T], expected: usize) {
            assert_eq!(all.len(), expected);
        }
        let run_status_count = |s: RunStatus| match s {
            RunStatus::Queued
            | RunStatus::Dispatched
            | RunStatus::Starting
            | RunStatus::Running
            | RunStatus::Verifying
            | RunStatus::AwaitingPermission
            | RunStatus::RateLimited
            | RunStatus::AwaitingGate
            | RunStatus::Completed
            | RunStatus::Failed
            | RunStatus::Canceled => 11,
        };
        check(RunStatus::ALL, run_status_count(RunStatus::Queued));
        let policy_count = |p: PermissionPolicy| match p {
            PermissionPolicy::Manual | PermissionPolicy::Auto | PermissionPolicy::Yolo => 3,
        };
        check(PermissionPolicy::ALL, policy_count(PermissionPolicy::Auto));
        let mode_count = |m: DelegationMode| match m {
            DelegationMode::Consult | DelegationMode::Branch => 2,
        };
        check(DelegationMode::ALL, mode_count(DelegationMode::Consult));
        let kind_count = |k: RunnerKind| match k {
            RunnerKind::Local | RunnerKind::Team => 2,
        };
        check(RunnerKind::ALL, kind_count(RunnerKind::Local));
        let gate_count = |g: GateKind| match g {
            GateKind::Plan | GateKind::Review => 2,
        };
        check(GateKind::ALL, gate_count(GateKind::Plan));
        let decision_count = |d: GateDecision| match d {
            GateDecision::Approved | GateDecision::Rejected => 2,
        };
        check(GateDecision::ALL, decision_count(GateDecision::Approved));
        let origin_count = |o: RunOrigin| match o {
            RunOrigin::Dispatch
            | RunOrigin::Delegation
            | RunOrigin::Verification
            | RunOrigin::Mention
            | RunOrigin::FeedbackLoop => 5,
        };
        check(RunOrigin::ALL, origin_count(RunOrigin::Dispatch));
        let source_count = |p: PromptSource| match p {
            PromptSource::User
            | PromptSource::PlanGate
            | PromptSource::ReviewGate
            | PromptSource::VerificationRetry
            | PromptSource::FeedbackReview
            | PromptSource::FeedbackCi
            | PromptSource::ChildQuestion => 7,
        };
        check(PromptSource::ALL, source_count(PromptSource::User));
        let criterion_count = |k: AcceptanceCriterionKind| match k {
            AcceptanceCriterionKind::Command
            | AcceptanceCriterionKind::Agent
            | AcceptanceCriterionKind::Browser
            | AcceptanceCriterionKind::Manual => 4,
        };
        check(
            AcceptanceCriterionKind::ALL,
            criterion_count(AcceptanceCriterionKind::Manual),
        );
    }

    #[test]
    fn as_str_matches_serde() {
        for s in RunStatus::ALL {
            assert_eq!(serde_json::to_value(s).unwrap(), s.as_str());
        }
        for p in PermissionPolicy::ALL {
            assert_eq!(serde_json::to_value(p).unwrap(), p.as_str());
        }
        for m in DelegationMode::ALL {
            assert_eq!(serde_json::to_value(m).unwrap(), m.as_str());
        }
        for k in RunnerKind::ALL {
            assert_eq!(serde_json::to_value(k).unwrap(), k.as_str());
        }
        for g in GateKind::ALL {
            assert_eq!(serde_json::to_value(g).unwrap(), g.as_str());
        }
        for d in GateDecision::ALL {
            assert_eq!(serde_json::to_value(d).unwrap(), d.as_str());
        }
        for o in RunOrigin::ALL {
            assert_eq!(serde_json::to_value(o).unwrap(), o.as_str());
        }
        for p in PromptSource::ALL {
            assert_eq!(serde_json::to_value(p).unwrap(), p.as_str());
        }
        for k in AcceptanceCriterionKind::ALL {
            assert_eq!(serde_json::to_value(k).unwrap(), k.as_str());
        }
    }

    #[test]
    fn default_permission_policy_is_auto() {
        assert_eq!(PermissionPolicy::default(), PermissionPolicy::Auto);
    }
}
