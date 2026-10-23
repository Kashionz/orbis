//! rate limit 的辨識與 Credential 層級的暫停（ARCHITECTURE §7、issue #33）。
//!
//! 各 Agent 回報額度用完的方式不同：
//!
//! | Agent | 形式 |
//! |---|---|
//! | Claude Code | `usage_update` 的 `_meta["_claude/rateLimit"]`：`status` 為 `rejected`，`resetsAt` 是 epoch 秒；回合本身可能照常結束 |
//! | Codex | 回合以 JSON-RPC 錯誤結束，`data.codexErrorInfo` 是 `usageLimitExceeded` 或 `rateLimitExceeded`，訊息是「try again in …」 |
//! | Gemini CLI | 錯誤訊息含 `RESOURCE_EXHAUSTED`、quota、429，常附「Please retry in 12.3s」 |
//! | Grok Build、其他 | 錯誤訊息含 rate limit、429、too many requests |
//!
//! 某個 Run 撞到 rate limit 時，同一組 Credential 到恢復時間之前不接受新的 Dispatch（[`RateLimits`]）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;

/// 偵測到的 rate limit。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimit {
    /// 預估恢復的時間；讀不出來時為 `None`。
    pub resets_at: Option<SystemTime>,
}

/// 辨識 JSON-RPC 錯誤是不是 rate limit。
pub fn from_error(error: &agent_client_protocol::Error) -> Option<RateLimit> {
    let data = error.data.as_ref();
    let field = |key: &str| data.and_then(|d| d.get(key));
    let typed = field("type").and_then(|t| t.as_str()) == Some("rate_limit");
    let codex = field("codexErrorInfo").is_some_and(|info| {
        let is_limit = |s: &str| matches!(s, "usageLimitExceeded" | "rateLimitExceeded");
        match info {
            serde_json::Value::String(s) => is_limit(s),
            serde_json::Value::Object(map) => map.keys().any(|k| is_limit(k)),
            _ => false,
        }
    });
    let texts: Vec<&str> = std::iter::once(error.message.as_str())
        .chain(
            ["message", "additionalDetails"]
                .into_iter()
                .filter_map(|k| field(k).and_then(|v| v.as_str())),
        )
        .collect();
    if !(typed || codex || texts.iter().any(|t| looks_like_rate_limit(t))) {
        return None;
    }
    let explicit = field("retry_after_ms")
        .and_then(serde_json::Value::as_u64)
        .map(|ms| SystemTime::now() + Duration::from_millis(ms))
        .or_else(|| {
            ["resets_at", "resetsAt"]
                .into_iter()
                .find_map(|k| field(k).and_then(serde_json::Value::as_u64))
                .and_then(epoch)
        });
    Some(RateLimit {
        resets_at: explicit.or_else(|| texts.iter().find_map(|t| resets_at_in_text(t))),
    })
}

/// Claude Code 的 `usage_update._meta["_claude/rateLimit"]`：`status` 為 `rejected` 時是 rate limit。
pub fn from_claude_meta(meta: &serde_json::Map<String, serde_json::Value>) -> Option<RateLimit> {
    let info = meta.get("_claude/rateLimit")?;
    if info.get("status").and_then(|s| s.as_str()) != Some("rejected") {
        return None;
    }
    Some(RateLimit {
        resets_at: info
            .get("resetsAt")
            .and_then(serde_json::Value::as_u64)
            .and_then(epoch),
    })
}

fn looks_like_rate_limit(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "rate limit",
        "rate_limit",
        "ratelimit",
        "429",
        "usage limit",
        "resource_exhausted",
        "quota exceeded",
        "quota_exceeded",
        "insufficient_quota",
        "too many requests",
    ]
    .iter()
    .any(|p| lower.contains(p))
}

/// epoch 秒（或毫秒）轉成時間。
fn epoch(value: u64) -> Option<SystemTime> {
    // 13 位數以上視為毫秒。
    let secs = if value >= 1_000_000_000_000 {
        value / 1000
    } else {
        value
    };
    UNIX_EPOCH.checked_add(Duration::from_secs(secs))
}

/// 從訊息中讀出恢復時間：`…|<epoch 秒>`（Claude Code）、`retry in 12.3s`、
/// `try again in 2 hours 5 minutes`、`retry after 30 seconds`。
fn resets_at_in_text(text: &str) -> Option<SystemTime> {
    static EPOCH: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static AFTER: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let epoch_re = EPOCH.get_or_init(|| Regex::new(r"\|(\d{10,13})\b").expect("固定的正規表示式"));
    if let Some(caps) = epoch_re.captures(text) {
        return caps[1].parse().ok().and_then(epoch);
    }
    let after_re = AFTER.get_or_init(|| {
        Regex::new(r"(?i)(?:retry|try again)\D{0,12}?(?:in|after)\s+([0-9][0-9a-z .,]*)")
            .expect("固定的正規表示式")
    });
    let caps = after_re.captures(text)?;
    parse_duration(&caps[1]).map(|d| SystemTime::now() + d)
}

/// `2 hours 5 minutes`、`1h 5m`、`12.3s`、`1500ms`。讀不到任何單位時回傳 `None`。
fn parse_duration(text: &str) -> Option<Duration> {
    static PART: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let part = PART.get_or_init(|| {
        Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b")
            .expect("固定的正規表示式")
    });
    let mut total = 0.0_f64;
    let mut found = false;
    for caps in part.captures_iter(text) {
        let value: f64 = caps[1].parse().ok()?;
        let unit = caps[2].to_ascii_lowercase();
        let secs = match unit.as_str() {
            "ms" => value / 1000.0,
            u if u.starts_with("millisecond") => value / 1000.0,
            u if u.starts_with('s') => value,
            u if u.starts_with('m') => value * 60.0,
            u if u.starts_with('h') => value * 3600.0,
            _ => value * 86400.0,
        };
        total += secs;
        found = true;
    }
    found.then(|| Duration::from_secs_f64(total))
}

/// 各組 Credential 的 rate limit：到恢復時間之前不接受新的 Dispatch。
#[derive(Debug, Default)]
pub struct RateLimits {
    until: Mutex<HashMap<String, SystemTime>>,
}

impl RateLimits {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, SystemTime>> {
        self.until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 記下 `credential` 在 `until` 之前額度用完；到時間時以 `changed` 通知（AgentAvailability 要重送）。
    pub fn set(
        self: &Arc<Self>,
        credential: &str,
        until: SystemTime,
        changed: Arc<tokio::sync::Notify>,
    ) {
        {
            let mut map = self.lock();
            let entry = map.entry(credential.to_owned()).or_insert(until);
            if *entry < until {
                *entry = until;
            }
        }
        changed.notify_one();
        let wait = until
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO);
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            changed.notify_one();
        });
    }

    /// `credential` 目前是否在 rate limit 中；是的話回傳恢復時間。
    pub fn active(&self, credential: &str) -> Option<SystemTime> {
        let mut map = self.lock();
        match map.get(credential) {
            Some(until) if *until > SystemTime::now() => Some(*until),
            Some(_) => {
                map.remove(credential);
                None
            }
            None => None,
        }
    }
}

/// 給人看的時間（RFC 3339，UTC）。
pub fn display_time(time: SystemTime) -> String {
    humantime::format_rfc3339_seconds(time).to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn error(message: &str, data: serde_json::Value) -> agent_client_protocol::Error {
        agent_client_protocol::Error::new(-32603, message.to_owned()).data(data)
    }

    fn secs_from_now(limit: &RateLimit) -> u64 {
        limit
            .resets_at
            .unwrap()
            .duration_since(SystemTime::now())
            .unwrap_or_default()
            .as_secs_f64()
            .round() as u64
    }

    #[test]
    fn 辨識各_agent_的_rate_limit() {
        // Fake Agent／一般格式
        let fake = from_error(&error(
            "Rate limit exceeded",
            json!({ "type": "rate_limit", "retry_after_ms": 5000 }),
        ))
        .unwrap();
        assert_eq!(secs_from_now(&fake), 5);
        // Codex
        let codex = from_error(&error(
            "Internal error",
            json!({
                "message": "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.",
                "codexErrorInfo": "usageLimitExceeded",
            }),
        ))
        .unwrap();
        assert_eq!(secs_from_now(&codex), 2 * 3600 + 5 * 60);
        let codex_object = from_error(&error(
            "Internal error",
            json!({ "codexErrorInfo": { "rateLimitExceeded": {} } }),
        ))
        .unwrap();
        assert_eq!(codex_object.resets_at, None);
        // Gemini CLI
        let gemini = from_error(&error(
            "[API Error: RESOURCE_EXHAUSTED: Quota exceeded for metric. Please retry in 12.5s.]",
            serde_json::Value::Null,
        ))
        .unwrap();
        assert!((12..=13).contains(&secs_from_now(&gemini)));
        // Claude Code 的訊息
        let claude = from_error(&error(
            "Claude AI usage limit reached|1700000000",
            serde_json::Value::Null,
        ))
        .unwrap();
        assert_eq!(claude.resets_at, epoch(1_700_000_000));
        // 其他
        assert!(
            from_error(&error(
                "HTTP 429 Too Many Requests",
                serde_json::Value::Null
            ))
            .is_some()
        );
        assert!(from_error(&error("file not found", json!({ "path": "x" }))).is_none());
    }

    #[test]
    fn claude_code_的_rate_limit_事件() {
        let meta = |status: &str| {
            json!({ "_claude/rateLimit": { "status": status, "resetsAt": 1_700_000_000_u64 } })
                .as_object()
                .unwrap()
                .clone()
        };
        assert_eq!(
            from_claude_meta(&meta("rejected")),
            Some(RateLimit {
                resets_at: epoch(1_700_000_000)
            })
        );
        assert_eq!(from_claude_meta(&meta("allowed_warning")), None);
        assert_eq!(from_claude_meta(&serde_json::Map::new()), None);
    }

    #[test]
    fn 解析等待時間() {
        assert_eq!(parse_duration("1h 5m"), Some(Duration::from_secs(3900)));
        assert_eq!(parse_duration("1500ms"), Some(Duration::from_millis(1500)));
        assert_eq!(parse_duration("30 seconds"), Some(Duration::from_secs(30)));
        assert_eq!(parse_duration("soon"), None);
        assert!(resets_at_in_text("Please retry after 30 seconds").is_some());
        assert!(resets_at_in_text("no hint here").is_none());
    }

    #[tokio::test]
    async fn credential_的_rate_limit_到時間就解除() {
        let limits = Arc::new(RateLimits::default());
        let changed = Arc::new(tokio::sync::Notify::new());
        limits.set(
            "c",
            SystemTime::now() + Duration::from_millis(300),
            changed.clone(),
        );
        assert!(limits.active("c").is_some());
        assert!(limits.active("other").is_none());
        changed.notified().await; // set 本身的通知
        tokio::time::timeout(Duration::from_secs(5), changed.notified())
            .await
            .expect("到時間要通知");
        assert!(limits.active("c").is_none());
    }
}
