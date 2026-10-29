//! Persisted desktop settings and recent-file bookkeeping.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{detection::CustomEntry, paths::path_key};

pub const SETTINGS_VERSION: u32 = 1;
pub const RECENT_LIMIT: usize = 5;
pub const DEFAULT_HISTORY_LIMIT: usize = crate::history::DEFAULT_RETENTION;
pub const MIN_HISTORY_LIMIT: usize = 1;
pub const MAX_HISTORY_LIMIT: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemeMode {
    /// Parses a stored theme value, falling back to `system` for anything else.
    ///
    /// @param value - The untrusted stored value.
    /// @returns The matching theme mode.
    pub fn from_stored(value: Option<&str>) -> Self {
        match value {
            Some("light") => Self::Light,
            Some("dark") => Self::Dark,
            _ => Self::System,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub version: u32,
    pub theme: ThemeMode,
    pub close_to_tray: bool,
    pub soft_wrap: bool,
    pub history_limit: usize,
    pub hidden_tools: Vec<String>,
    pub recent_files: Vec<String>,
    pub custom: Vec<CustomEntry>,
    pub workspaces: Vec<Workspace>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            theme: ThemeMode::System,
            close_to_tray: false,
            soft_wrap: true,
            history_limit: DEFAULT_HISTORY_LIMIT,
            hidden_tools: Vec::new(),
            recent_files: Vec::new(),
            custom: Vec::new(),
            workspaces: Vec::new(),
        }
    }
}

/// Clamps a stored history limit into the supported range.
///
/// @param value - The untrusted stored value.
/// @returns A retention between one and the maximum.
pub fn clamp_history_limit(value: usize) -> usize {
    value.clamp(MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT)
}

impl AppSettings {
    /// Parses settings from stored JSON, defaulting each field whose stored
    /// value has the wrong shape instead of discarding the whole file.
    ///
    /// @param text - The raw settings file contents.
    /// @returns The complete settings object.
    pub fn from_json(text: &str) -> Self {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            return Self::default();
        };
        let Some(object) = value.as_object() else {
            return Self::default();
        };
        Self {
            version: SETTINGS_VERSION,
            theme: ThemeMode::from_stored(object.get("theme").and_then(|theme| theme.as_str())),
            close_to_tray: object.get("closeToTray").and_then(|flag| flag.as_bool()) == Some(true),
            soft_wrap: object.get("softWrap").and_then(|flag| flag.as_bool()) != Some(false),
            history_limit: object
                .get("historyLimit")
                .and_then(|limit| limit.as_u64())
                .map_or(DEFAULT_HISTORY_LIMIT, |limit| {
                    clamp_history_limit(usize::try_from(limit).unwrap_or(MAX_HISTORY_LIMIT))
                }),
            hidden_tools: string_array(object.get("hiddenTools")),
            recent_files: string_array(object.get("recentFiles")),
            custom: custom_entries(object.get("custom")),
            workspaces: workspace_entries(object.get("workspaces")),
        }
    }

    /// Serializes settings in the same camelCase shape the desktop UI reads.
    ///
    /// @returns The pretty-printed settings JSON.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("settings always serialize")
    }
}

fn string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|array| array.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn workspace_entries(value: Option<&serde_json::Value>) -> Vec<Workspace> {
    value
        .and_then(|array| array.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|entry| {
                    let entry = entry.as_object()?;
                    let id = entry.get("id")?.as_str()?;
                    let name = entry.get("name")?.as_str()?;
                    let path = entry.get("path")?.as_str()?;
                    Some(Workspace {
                        id: id.to_owned(),
                        name: name.to_owned(),
                        path: PathBuf::from(path),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn custom_entries(value: Option<&serde_json::Value>) -> Vec<CustomEntry> {
    value
        .and_then(|array| array.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|entry| {
                    let entry = entry.as_object()?;
                    let id = entry.get("id")?.as_str()?;
                    let name = entry.get("name")?.as_str()?;
                    let path = entry.get("path")?.as_str()?;
                    Some(CustomEntry {
                        id: id.to_owned(),
                        name: name.to_owned(),
                        path: PathBuf::from(path),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Promotes a path to the front of the recent-file list and caps it.
///
/// @param list - The current recent-file list.
/// @param file_path - The path to promote.
/// @returns The updated list with the path first and at most five entries.
pub fn push_recent(list: &[String], file_path: &str) -> Vec<String> {
    let key = path_key(Path::new(file_path));
    let mut next = Vec::with_capacity(RECENT_LIMIT);
    next.push(file_path.to_owned());
    for entry in list {
        if next.len() >= RECENT_LIMIT {
            break;
        }
        if path_key(Path::new(entry)) != key {
            next.push(entry.clone());
        }
    }
    next
}

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("failed to {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

impl SettingsError {
    fn io(operation: &'static str, path: &Path, source: io::Error) -> Self {
        Self::Io {
            operation,
            path: path.to_path_buf(),
            source,
        }
    }
}

/// Reads and atomically replaces one settings file.
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    /// Creates a store for a settings file that may not exist yet.
    ///
    /// @param path - Absolute path of the settings file.
    /// @returns The store.
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Loads settings, returning defaults when the file is missing or corrupt.
    ///
    /// @returns The complete settings object.
    pub fn load(&self) -> AppSettings {
        fs::read_to_string(&self.path)
            .map(|text| AppSettings::from_json(&text))
            .unwrap_or_default()
    }

    /// Writes settings through a temporary file in the same folder.
    ///
    /// @param settings - The settings to persist.
    /// @throws When the settings folder cannot be created or the replacement
    /// write fails.
    pub fn save(&self, settings: &AppSettings) -> Result<(), SettingsError> {
        let parent = self.path.parent().ok_or_else(|| SettingsError::Io {
            operation: "resolve the settings folder of",
            path: self.path.clone(),
            source: io::Error::new(io::ErrorKind::InvalidInput, "settings path has no parent"),
        })?;
        fs::create_dir_all(parent)
            .map_err(|source| SettingsError::io("create the settings folder", parent, source))?;
        let temp = temp_path(&self.path);
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|source| SettingsError::io("create", &temp, source))?;
            file.write_all(settings.to_json().as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(|source| SettingsError::io("write", &temp, source))?;
            drop(file);
            fs::rename(&temp, &self.path)
                .map_err(|source| SettingsError::io("replace", &self.path, source))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
}

fn temp_path(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "settings.json".to_owned());
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".{name}.tmp-{}-{nonce}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_corrupt_files_load_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(temp.path().join("settings.json"));
        assert_eq!(store.load(), AppSettings::default());

        fs::write(temp.path().join("settings.json"), "{ not json").unwrap();
        assert_eq!(store.load(), AppSettings::default());

        fs::write(temp.path().join("settings.json"), "[1, 2]").unwrap();
        assert_eq!(store.load(), AppSettings::default());
    }

    #[test]
    fn invalid_fields_fall_back_individually() {
        let settings = AppSettings::from_json(
            r#"{
                "theme": "neon",
                "closeToTray": "yes",
                "softWrap": false,
                "hiddenTools": ["claude-code", 4, null],
                "recentFiles": "not-an-array",
                "historyLimit": 5000,
                "custom": [{"id": "custom-1", "name": "Mine", "path": "C:\\x\\y.json"}, {"id": 2}],
                "workspaces": [{"id": "workspace-1", "name": "Project", "path": "C:\\work\\app"}, {"name": "No id"}]
            }"#,
        );
        assert_eq!(settings.theme, ThemeMode::System);
        assert!(!settings.close_to_tray);
        assert!(!settings.soft_wrap);
        assert_eq!(settings.history_limit, MAX_HISTORY_LIMIT);
        assert_eq!(settings.hidden_tools, ["claude-code"]);
        assert!(settings.recent_files.is_empty());
        assert_eq!(settings.custom.len(), 1);
        assert_eq!(settings.custom[0].name, "Mine");
        assert_eq!(settings.workspaces.len(), 1);
        assert_eq!(settings.workspaces[0].name, "Project");
    }

    #[test]
    fn history_limit_defaults_and_clamps() {
        let settings = AppSettings::from_json(r#"{"historyLimit": 0}"#);
        assert_eq!(settings.history_limit, MIN_HISTORY_LIMIT);
        let settings = AppSettings::from_json(r#"{"historyLimit": 12}"#);
        assert_eq!(settings.history_limit, 12);
        let settings = AppSettings::from_json(r#"{"historyLimit": -3}"#);
        assert_eq!(settings.history_limit, DEFAULT_HISTORY_LIMIT);
    }

    #[test]
    fn round_trips_through_disk() {
        let temp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(temp.path().join("nested").join("settings.json"));
        let mut settings = AppSettings {
            theme: ThemeMode::Dark,
            close_to_tray: true,
            hidden_tools: vec!["aider".into()],
            recent_files: vec![r"C:\configs\settings.json".into()],
            custom: vec![CustomEntry {
                id: "custom-1".into(),
                name: "Mine".into(),
                path: PathBuf::from(r"C:\custom\config.json"),
            }],
            ..AppSettings::default()
        };
        store.save(&settings).unwrap();
        assert_eq!(store.load(), settings);

        settings.theme = ThemeMode::Light;
        store.save(&settings).unwrap();
        assert_eq!(store.load(), settings);
        assert_eq!(
            fs::read_dir(store.path.parent().unwrap()).unwrap().count(),
            1,
            "temporary files must not be left behind"
        );
    }

    #[test]
    fn recent_files_are_promoted_deduplicated_and_capped() {
        let list: Vec<String> = (0..6)
            .map(|index| format!(r"C:\configs\file-{index}.json"))
            .collect();
        let next = push_recent(&list, r"C:\configs\file-3.json");
        assert_eq!(next.len(), RECENT_LIMIT);
        assert_eq!(next[0], r"C:\configs\file-3.json");
        assert_eq!(
            next.iter()
                .filter(|entry| *entry == r"C:\configs\file-3.json")
                .count(),
            1
        );
    }
}
