//! 送出前遮蔽看起來像 secret 的字串（ARCHITECTURE §14）。
//!
//! 兩種來源：
//! - 常見格式（GitHub、OpenAI、Anthropic、AWS、Slack 的 token、JWT、PEM 私鑰、`password=…` 這類 key=value）。
//! - 這個 Run 已知的值，例如從 `copy` 複製進 Worktree 的 `.env` 檔中的值。

use std::sync::LazyLock;

use regex::Regex;

/// 遮蔽後的替代文字。
pub const MASK: &str = "[REDACTED]";

/// 已知值至少要這麼長才遮蔽，避免把 `1`、`true` 這種值到處換掉。
const MIN_KNOWN_SECRET_LEN: usize = 6;

static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // PEM 私鑰（整段）
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        // GitHub token
        r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b",
        // Anthropic、OpenAI
        r"\bsk-ant-[A-Za-z0-9_\-]{20,}",
        r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}",
        // AWS access key id
        r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
        // Slack
        r"\bxox[abprs]-[A-Za-z0-9\-]{10,}",
        // Google API key
        r"\bAIza[0-9A-Za-z_\-]{35}\b",
        // JWT
        r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
        // HTTP Authorization header
        r"(?i)\b(?:authorization:\s*(?:bearer|basic|token))\s+[A-Za-z0-9._~+/=\-]{8,}",
        // URL 中的帳號密碼：scheme://user:pass@host
        r"(?i)\b[a-z][a-z0-9+.\-]*://[^\s:/@]+:[^\s@/]{3,}@",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("遮蔽用的 regex 必須合法"))
    .collect()
});

/// key=value／key: value 形式，key 看起來像 secret 的名稱時只遮蔽 value。
static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b([A-Z0-9_.\-]*(?:password|passwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|client[_\-]?secret)[A-Z0-9_.\-]*)(["']?\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{4,})"#,
    )
    .expect("遮蔽用的 regex 必須合法")
});

/// 一個 Run 的遮蔽器。
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    /// 已知的 secret 值，依長度由長到短，避免短的值先替換掉長值的一部分。
    known: Vec<String>,
}

impl Redactor {
    pub fn new() -> Self {
        Self::default()
    }

    /// 加入已知的 secret 值（例如 `.env` 中的值）。
    pub fn add_known(&mut self, value: &str) {
        let value = value.trim();
        if value.len() >= MIN_KNOWN_SECRET_LEN && !self.known.iter().any(|k| k == value) {
            self.known.push(value.to_owned());
            self.known.sort_by_key(|k| std::cmp::Reverse(k.len()));
        }
    }

    /// 從 dotenv 格式的內容加入每一個值。
    pub fn add_dotenv(&mut self, content: &str) {
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            let line = line.strip_prefix("export ").unwrap_or(line);
            if let Some((_, value)) = line.split_once('=') {
                let value = value.trim().trim_matches(['"', '\'']);
                self.add_known(value);
            }
        }
    }

    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for known in &self.known {
            if out.contains(known.as_str()) {
                out = out.replace(known.as_str(), MASK);
            }
        }
        for pattern in PATTERNS.iter() {
            if pattern.is_match(&out) {
                out = pattern.replace_all(&out, MASK).into_owned();
            }
        }
        if KEY_VALUE.is_match(&out) {
            out = KEY_VALUE
                .replace_all(&out, |caps: &regex::Captures<'_>| {
                    if caps[3].contains(MASK) {
                        caps[0].to_owned()
                    } else {
                        format!("{}{}{MASK}", &caps[1], &caps[2])
                    }
                })
                .into_owned();
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redact(text: &str) -> String {
        Redactor::new().redact(text)
    }

    #[test]
    fn 遮蔽常見格式的_token() {
        let cases = [
            "ghp_0123456789abcdefghijABCDEFGHIJ012345",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
            "sk-proj-abcdefghijklmnopqrstuvwxyz0123",
            "AKIAIOSFODNN7EXAMPLE",
            "xoxb-1234567890-abcdefghij",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ];
        for secret in cases {
            let text = format!("value: {secret} end");
            let out = redact(&text);
            assert!(!out.contains(secret), "{secret} 沒有被遮蔽：{out}");
            assert!(out.contains(MASK));
        }
    }

    #[test]
    fn 遮蔽私鑰與網址中的密碼() {
        let pem =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(redact(pem), MASK);
        let out = redact("git clone https://user:hunter22@github.com/acme/web.git");
        assert!(!out.contains("hunter22"), "{out}");
        assert!(out.contains("github.com/acme/web.git"), "{out}");
    }

    #[test]
    fn key_value_只遮蔽值() {
        assert_eq!(
            redact("DB_PASSWORD=supersecret"),
            format!("DB_PASSWORD={MASK}")
        );
        assert_eq!(
            redact(r#""api_key": "abcd1234efgh""#).matches(MASK).count(),
            1
        );
        assert_eq!(redact("Authorization: Bearer abcdefgh12345678"), MASK);
    }

    #[test]
    fn 一般文字不受影響() {
        let text = "pnpm test 通過 12 個測試，token 數量 1200，路徑 D:\\work\\web";
        assert_eq!(redact(text), text);
    }

    #[test]
    fn 遮蔽_env_檔中的已知值() {
        let mut redactor = Redactor::new();
        redactor.add_dotenv("# 註解\nDATABASE_URL=postgres://localhost/db\nexport STRIPE=\"rk_live_abcdef\"\nDEBUG=1\n");
        let out = redactor.redact("連到 postgres://localhost/db，金鑰 rk_live_abcdef，DEBUG=1");
        assert!(!out.contains("postgres://localhost/db"), "{out}");
        assert!(!out.contains("rk_live_abcdef"), "{out}");
        assert!(out.contains("DEBUG=1"), "太短的值不遮蔽：{out}");
    }
}
