//! 模型目錄（ARCHITECTURE §7）：Agent Profile 內建的靜態清單，與各 Agent 最近一次真實 session 回報的
//! config option（類別 `model`、`thought_level`）。
//!
//! - 沒有 session 版本時回報 Profile 的清單（`source = profile`）；有了之後以 session 版本為準
//!   （`source = session`），存在狀態目錄的 `agents/catalog.json`，Runner 重新啟動後仍然有效。
//! - 同一份檔案也記下 Agent 自己處理登入時的登入狀態（最近一次 session 建立成功或遇到 `auth_required`）。
//! - 推理強度的套用：Profile 的 `effort_values`（快速、標準、深度各自對應的 thought level 值）優先，
//!   沒有時依值的名稱判斷（[`effort_by_name`]）。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use agent_client_protocol::schema::v1 as acp;
use orbis_protocol::availability::{EffortSupport, ModelInfo, ModelSource, ModelTag};
use orbis_protocol::enums::Effort;
use serde::{Deserialize, Serialize};

use crate::agent::AgentProfile;

/// 狀態目錄中模型目錄的檔名（在 `agents/` 下）。
const CATALOG_FILE: &str = "catalog.json";

/// Agent Profile 內建的一個模型。
#[derive(Debug, Clone, PartialEq)]
pub struct ProfileModel {
    pub id: String,
    pub name: String,
    pub tag: Option<ModelTag>,
    pub effort: EffortSupport,
}

impl ProfileModel {
    pub fn new(id: &str, name: &str, tag: Option<ModelTag>, effort: EffortSupport) -> Self {
        Self {
            id: id.to_owned(),
            name: name.to_owned(),
            tag,
            effort,
        }
    }
}

/// 快速、標準、深度各自對應的值（thought level 的 config option 值，或啟動參數）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerEffort<T> {
    pub fast: T,
    pub std: T,
    pub deep: T,
}

impl<T> PerEffort<T> {
    pub fn get(&self, effort: Effort) -> &T {
        match effort {
            Effort::Fast => &self.fast,
            Effort::Std => &self.std,
            Effort::Deep => &self.deep,
        }
    }
}

/// select 類型的 config option 中的一個值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionValue {
    pub id: String,
    pub name: String,
}

/// config option 的類別（只區分模型目錄用得到的兩類）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionCategory {
    Model,
    ThoughtLevel,
    Other,
}

/// 一個 select 類型的 config option（群組展開成一個清單）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectOption {
    pub id: String,
    pub category: OptionCategory,
    pub current: String,
    pub values: Vec<OptionValue>,
}

/// ACP 的 config option 中 select 類型的選項；boolean 類型與不認得的形狀略過。
pub fn select_options(options: &[acp::SessionConfigOption]) -> Vec<SelectOption> {
    options
        .iter()
        .filter_map(|option| {
            let acp::SessionConfigKind::Select(select) = &option.kind else {
                return None;
            };
            let values = match &select.options {
                acp::SessionConfigSelectOptions::Ungrouped(values) => values.clone(),
                acp::SessionConfigSelectOptions::Grouped(groups) => {
                    groups.iter().flat_map(|g| g.options.clone()).collect()
                }
                _ => Vec::new(),
            };
            let category = match &option.category {
                Some(acp::SessionConfigOptionCategory::Model) => OptionCategory::Model,
                Some(acp::SessionConfigOptionCategory::ThoughtLevel) => {
                    OptionCategory::ThoughtLevel
                }
                _ => OptionCategory::Other,
            };
            Some(SelectOption {
                id: option.id.0.to_string(),
                category,
                current: select.current_value.0.to_string(),
                values: values
                    .into_iter()
                    .map(|v| OptionValue {
                        id: v.value.0.to_string(),
                        name: v.name,
                    })
                    .collect(),
            })
        })
        .collect()
}

/// 某個類別的第一個 select 選項。
pub fn option_of(options: &[SelectOption], category: OptionCategory) -> Option<&SelectOption> {
    options.iter().find(|o| o.category == category)
}

/// 沒有 Profile 對應時，依 thought level 值的名稱判斷推理強度。
pub fn effort_by_name(value: &str) -> Option<Effort> {
    match value.to_ascii_lowercase().as_str() {
        "low" | "minimal" | "fast" | "none" => Some(Effort::Fast),
        "medium" | "std" | "standard" | "default" => Some(Effort::Std),
        "high" | "max" | "xhigh" | "deep" => Some(Effort::Deep),
        _ => None,
    }
}

/// 推理強度要設成 thought level 選項的哪個值；選項中沒有對應的值時為 `None`。
pub fn effort_value(
    profile: &AgentProfile,
    thought: &SelectOption,
    effort: Effort,
) -> Option<String> {
    let has = |id: &str| thought.values.iter().any(|v| v.id == id);
    if let Some(values) = &profile.effort_values {
        let wanted = values.get(effort);
        if has(wanted) {
            return Some(wanted.clone());
        }
    }
    thought
        .values
        .iter()
        .find(|v| effort_by_name(&v.id) == Some(effort))
        .map(|v| v.id.clone())
}

/// 一個 Agent 最近一次真實 session 回報的模型與 thought level。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCatalog {
    pub models: Vec<OptionValue>,
    /// thought level 選項的值；Agent 沒有這個選項時為空。
    pub thought_levels: Vec<String>,
}

impl SessionCatalog {
    /// 從 config option 取出模型與 thought level；沒有模型的選項時為 `None`（不取代 Profile 的清單）。
    pub fn from_options(options: &[SelectOption]) -> Option<Self> {
        let model = option_of(options, OptionCategory::Model)?;
        Some(Self {
            models: model.values.clone(),
            thought_levels: option_of(options, OptionCategory::ThoughtLevel)
                .map(|t| t.values.iter().map(|v| v.id.clone()).collect())
                .unwrap_or_default(),
        })
    }
}

/// `catalog.json` 中一個 Agent 的紀錄。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogEntry {
    #[serde(default)]
    pub session: Option<SessionCatalog>,
    /// Agent 自己處理登入時：最近一次 session 建立成功為 `true`，遇到 `auth_required` 為 `false`。
    #[serde(default)]
    pub signed_in: Option<bool>,
}

/// 狀態目錄中的模型目錄（`agents/catalog.json`）。
#[derive(Debug)]
pub struct CatalogStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl CatalogStore {
    pub fn new(agents_dir: PathBuf) -> Self {
        Self {
            path: agents_dir.join(CATALOG_FILE),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> BTreeMap<String, CatalogEntry> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn get(&self, agent: &str) -> CatalogEntry {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.read().remove(agent).unwrap_or_default()
    }

    /// 修改一個 Agent 的紀錄；內容有變化時寫回並回傳 `true`。
    fn update(&self, agent: &str, change: impl FnOnce(&mut CatalogEntry)) -> bool {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut all = self.read();
        let entry = all.entry(agent.to_owned()).or_default();
        let before = entry.clone();
        change(entry);
        if *entry == before {
            return false;
        }
        let written = serde_json::to_vec_pretty(&all)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| crate::home::write_atomic(&self.path, &bytes, false));
        if let Err(error) = written {
            tracing::warn!(path = %self.path.display(), %error, "無法保存模型目錄");
        }
        true
    }

    /// 記下 session 回報的 config option；沒有模型的選項時不取代 Profile 的清單。
    pub fn record_session(&self, agent: &str, options: &[SelectOption]) -> bool {
        let Some(session) = SessionCatalog::from_options(options) else {
            return false;
        };
        self.update(agent, |entry| entry.session = Some(session))
    }

    pub fn record_signed_in(&self, agent: &str, signed_in: bool) -> bool {
        self.update(agent, |entry| entry.signed_in = Some(signed_in))
    }
}

/// AgentAvailability 的模型清單：有 session 版本就用它，否則用 Profile 的清單。
pub fn model_infos(profile: &AgentProfile, entry: &CatalogEntry) -> Vec<ModelInfo> {
    let Some(session) = &entry.session else {
        return profile
            .models
            .iter()
            .map(|m| ModelInfo {
                id: m.id.clone(),
                name: m.name.clone(),
                tag: m.tag,
                effort: m.effort,
                source: ModelSource::Profile,
            })
            .collect();
    };
    session
        .models
        .iter()
        .map(|value| {
            let known = profile.models.iter().find(|m| m.id == value.id);
            ModelInfo {
                id: value.id.clone(),
                name: if value.name.trim().is_empty() {
                    value.id.clone()
                } else {
                    value.name.clone()
                },
                tag: known.and_then(|m| m.tag),
                effort: match known {
                    Some(m) => m.effort,
                    None if session.thought_levels.is_empty() => EffortSupport::Unsupported,
                    None => EffortSupport::Adjustable,
                },
                source: ModelSource::Session,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(
        category: acp::SessionConfigOptionCategory,
        id: &str,
        values: &[&str],
    ) -> acp::SessionConfigOption {
        acp::SessionConfigOption::select(
            id.to_owned(),
            id.to_owned(),
            values[0].to_owned(),
            values
                .iter()
                .map(|v| acp::SessionConfigSelectOption::new((*v).to_owned(), format!("{v} 名稱")))
                .collect::<Vec<_>>(),
        )
        .category(category)
    }

    #[test]
    fn 取出模型與推理強度的選項() {
        let options = select_options(&[
            config(
                acp::SessionConfigOptionCategory::Model,
                "model",
                &["sonnet", "opus"],
            ),
            config(
                acp::SessionConfigOptionCategory::ThoughtLevel,
                "thought",
                &["low", "medium", "high"],
            ),
            acp::SessionConfigOption::boolean("fast_mode", "Fast", false),
        ]);
        assert_eq!(options.len(), 2, "boolean 選項略過");
        let model = option_of(&options, OptionCategory::Model).unwrap();
        assert_eq!(model.current, "sonnet");
        assert_eq!(model.values[1].id, "opus");
        let session = SessionCatalog::from_options(&options).unwrap();
        assert_eq!(session.thought_levels, ["low", "medium", "high"]);
    }

    #[test]
    fn 推理強度的值_profile_優先再依名稱() {
        let thought = SelectOption {
            id: "thought".into(),
            category: OptionCategory::ThoughtLevel,
            current: "medium".into(),
            values: ["minimal", "medium", "xhigh", "turbo"]
                .iter()
                .map(|v| OptionValue {
                    id: (*v).into(),
                    name: (*v).into(),
                })
                .collect(),
        };
        let mut profile = AgentProfile::claude_code();
        profile.effort_values = None;
        assert_eq!(
            effort_value(&profile, &thought, Effort::Fast).as_deref(),
            Some("minimal")
        );
        assert_eq!(
            effort_value(&profile, &thought, Effort::Deep).as_deref(),
            Some("xhigh")
        );
        profile.effort_values = Some(PerEffort {
            fast: "turbo".into(),
            std: "medium".into(),
            deep: "not-offered".into(),
        });
        assert_eq!(
            effort_value(&profile, &thought, Effort::Fast).as_deref(),
            Some("turbo")
        );
        assert_eq!(
            effort_value(&profile, &thought, Effort::Deep).as_deref(),
            Some("xhigh"),
            "Profile 的值不在選項中時依名稱"
        );
    }

    #[test]
    fn 模型清單_沒有_session_時用_profile_有了就用_session() {
        let profile = AgentProfile::claude_code();
        let from_profile = model_infos(&profile, &CatalogEntry::default());
        assert!(!from_profile.is_empty());
        assert!(
            from_profile
                .iter()
                .all(|m| m.source == ModelSource::Profile)
        );

        let known = profile.models[0].clone();
        let entry = CatalogEntry {
            session: Some(SessionCatalog {
                models: vec![
                    OptionValue {
                        id: known.id.clone(),
                        name: "名稱".into(),
                    },
                    OptionValue {
                        id: "new-model".into(),
                        name: String::new(),
                    },
                ],
                thought_levels: Vec::new(),
            }),
            signed_in: None,
        };
        let from_session = model_infos(&profile, &entry);
        assert_eq!(from_session.len(), 2);
        assert!(
            from_session
                .iter()
                .all(|m| m.source == ModelSource::Session)
        );
        assert_eq!(
            from_session[0].tag, known.tag,
            "Profile 認得的模型沿用 tag 與推理強度"
        );
        assert_eq!(from_session[0].effort, known.effort);
        assert_eq!(from_session[1].name, "new-model", "沒有名稱時用 id");
        assert_eq!(
            from_session[1].effort,
            EffortSupport::Unsupported,
            "沒有 thought level 選項"
        );
    }

    #[test]
    fn 保存與讀回() {
        let dir = tempfile::tempdir().unwrap();
        let store = CatalogStore::new(dir.path().join("agents"));
        assert_eq!(store.get("a"), CatalogEntry::default());
        assert!(store.record_signed_in("a", true));
        assert!(!store.record_signed_in("a", true), "沒有變化");
        let options =
            select_options(&[config(acp::SessionConfigOptionCategory::Model, "m", &["x"])]);
        assert!(store.record_session("a", &options));
        let again = CatalogStore::new(dir.path().join("agents"));
        let entry = again.get("a");
        assert_eq!(entry.signed_in, Some(true));
        assert_eq!(entry.session.unwrap().models[0].id, "x");
        assert!(!store.record_session("b", &[]), "沒有模型的選項時不記");
    }
}
