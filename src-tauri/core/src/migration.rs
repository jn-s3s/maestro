//! Import of settings and encrypted snapshots from the Electron build.
//!
//! The importer only reads the Electron data root. It never renames, rewrites
//! or deletes legacy files, so the Electron build keeps working unchanged and
//! rolling back is just running Electron again.

use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    detection::CustomEntry,
    history::{HistoryStore, MAX_SNAPSHOT_BYTES},
    paths::{canonical_or_lexical, metadata_is_link, path_key},
    settings::{AppSettings, RECENT_LIMIT, SETTINGS_VERSION},
};

/// Folder name the Electron build uses below the roaming app-data folder.
pub const LEGACY_DIR_NAME: &str = "maestro";
/// Marker prefix on Electron encrypted snapshots.
pub const LEGACY_SNAPSHOT_PREFIX: &str = "maestro-enc:v1:";
/// Record written into the Tauri data root after each successful import.
pub const RECORD_FILE: &str = "migration.json";
/// Version stored in [`RECORD_FILE`].
pub const RECORD_VERSION: u32 = 1;
const MAX_WARNINGS: usize = 20;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

#[derive(Debug, Error)]
pub enum LegacyKeyError {
    #[error("Electron profile key file is corrupt")]
    Corrupt,
    #[error("Electron profile key is not DPAPI protected")]
    UnsupportedProtection,
    #[error("Electron profile key could not be unwrapped for this Windows account")]
    Unwrap,
    #[error("Electron profile key is not 256 bits")]
    KeyLength,
    #[error("Electron profile key protection is only available on Windows")]
    UnsupportedPlatform,
}

#[derive(Debug, Error)]
pub enum LegacySnapshotError {
    #[error("legacy snapshot wrapper version is not supported")]
    UnsupportedVersion,
    #[error("legacy snapshot base64 is invalid")]
    InvalidBase64,
    #[error("legacy snapshot is truncated")]
    Truncated,
    #[error("legacy snapshot authentication failed")]
    Authentication,
    #[error("decrypted legacy snapshot is not UTF-8")]
    NotUtf8,
    #[error("legacy snapshot is encrypted but no Electron profile key is available")]
    MissingKey,
    #[error("Electron profile key is not 256 bits")]
    KeyLength,
}

/// The AES key Electron safe storage uses in one user profile.
pub struct LegacyProfileKey([u8; 32]);

impl LegacyProfileKey {
    /// Unwraps the DPAPI-protected profile key from `Local State`.
    ///
    /// @param encoded - The base64 `os_crypt.encrypted_key` value.
    /// @returns The 256-bit AES key.
    /// @throws When the wrapper, protection or key length is unsupported.
    pub fn from_encoded(encoded: &str) -> Result<Self, LegacyKeyError> {
        let wrapped = STANDARD
            .decode(encoded)
            .map_err(|_| LegacyKeyError::Corrupt)?;
        let protected = wrapped
            .strip_prefix(b"DPAPI")
            .ok_or(LegacyKeyError::UnsupportedProtection)?;
        let raw = unwrap_dpapi(protected)?;
        let bytes: [u8; 32] = raw.try_into().map_err(|_| LegacyKeyError::KeyLength)?;
        Ok(Self(bytes))
    }

    /// Reads the profile key from `<legacy_root>\Local State`.
    ///
    /// @param legacy_root - The Electron data root.
    /// @returns The key, or `None` when the profile never used encryption.
    /// @throws When the file exists but cannot be parsed or unwrapped.
    pub fn load(legacy_root: &Path) -> Result<Option<Self>, LegacyKeyError> {
        let path = legacy_root.join("Local State");
        let bytes = match read_bounded(&path, crate::MAX_FILE_BYTES) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(LegacyKeyError::Corrupt),
        };
        let text = String::from_utf8(bytes).map_err(|_| LegacyKeyError::Corrupt)?;
        let state: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| LegacyKeyError::Corrupt)?;
        let Some(encoded) = state
            .get("os_crypt")
            .and_then(|crypt| crypt.get("encrypted_key"))
            .and_then(|key| key.as_str())
        else {
            return Ok(None);
        };
        Self::from_encoded(encoded).map(Some)
    }
}

/// Decrypts one stored Electron snapshot. Plain text passes through unchanged,
/// matching the Electron decoder.
///
/// @param stored - The stored snapshot text.
/// @param key - The profile key, required only for encrypted snapshots.
/// @returns The plaintext snapshot.
/// @throws When a marked blob cannot be decoded or authentication fails.
pub fn decode_snapshot(
    stored: &str,
    key: Option<&LegacyProfileKey>,
) -> Result<String, LegacySnapshotError> {
    let Some(encoded) = stored.strip_prefix(LEGACY_SNAPSHOT_PREFIX) else {
        if stored.starts_with("maestro-enc:") {
            return Err(LegacySnapshotError::UnsupportedVersion);
        }
        return Ok(stored.to_owned());
    };
    let key = key.ok_or(LegacySnapshotError::MissingKey)?;
    let encrypted = STANDARD
        .decode(encoded)
        .map_err(|_| LegacySnapshotError::InvalidBase64)?;
    let payload = encrypted
        .strip_prefix(b"v10")
        .ok_or(LegacySnapshotError::UnsupportedVersion)?;
    if payload.len() < NONCE_LEN + TAG_LEN {
        return Err(LegacySnapshotError::Truncated);
    }
    let cipher = Aes256Gcm::new_from_slice(&key.0).map_err(|_| LegacySnapshotError::KeyLength)?;
    let (nonce, ciphertext) = payload.split_at(NONCE_LEN);
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| LegacySnapshotError::Authentication)?;
    String::from_utf8(plaintext).map_err(|_| LegacySnapshotError::NotUtf8)
}

/// Reads the Electron settings file, ignoring a missing or corrupt file.
///
/// @param legacy_root - The Electron data root.
/// @returns The parsed settings, or `None` when there is nothing usable.
pub fn read_legacy_settings(legacy_root: &Path) -> Option<AppSettings> {
    let bytes = read_bounded(&legacy_root.join("settings.json"), crate::MAX_FILE_BYTES).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.as_object()?;
    Some(AppSettings::from_json(&text))
}

/// Merges Electron settings into the current Tauri settings.
///
/// Behavior flags come from Electron, Tauri-only fields are preserved, and
/// list fields are combined without duplicates.
///
/// @param current - Settings already stored by the Tauri app.
/// @param legacy - Settings read from the Electron data root.
/// @returns The merged settings.
pub fn merge_settings(current: &AppSettings, legacy: &AppSettings) -> AppSettings {
    AppSettings {
        version: SETTINGS_VERSION,
        theme: legacy.theme,
        close_to_tray: legacy.close_to_tray,
        soft_wrap: legacy.soft_wrap,
        history_limit: current.history_limit,
        hidden_tools: merge_unique(&current.hidden_tools, &legacy.hidden_tools),
        recent_files: merge_recent(&current.recent_files, &legacy.recent_files),
        custom: merge_custom(&current.custom, &legacy.custom),
        workspaces: current.workspaces.clone(),
    }
}

fn merge_unique(current: &[String], legacy: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(current.len() + legacy.len());
    for entry in current.iter().chain(legacy) {
        if !out.contains(entry) {
            out.push(entry.clone());
        }
    }
    out
}

fn merge_recent(current: &[String], legacy: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(RECENT_LIMIT);
    for entry in current.iter().chain(legacy) {
        if out.len() >= RECENT_LIMIT {
            break;
        }
        let key = path_key(Path::new(entry));
        if out
            .iter()
            .all(|existing| path_key(Path::new(existing)) != key)
        {
            out.push(entry.clone());
        }
    }
    out
}

fn merge_custom(current: &[CustomEntry], legacy: &[CustomEntry]) -> Vec<CustomEntry> {
    let mut paths = HashSet::new();
    let mut ids = HashSet::new();
    let mut out = Vec::with_capacity(current.len() + legacy.len());
    for entry in current {
        if paths.insert(path_key(&entry.path)) {
            ids.insert(entry.id.clone());
            out.push(entry.clone());
        }
    }
    for entry in legacy {
        if !paths.insert(path_key(&entry.path)) {
            continue;
        }
        let mut id = entry.id.clone();
        let mut attempt = 1usize;
        while ids.contains(&id) {
            id = format!("{}-imported-{attempt}", entry.id);
            attempt += 1;
        }
        ids.insert(id.clone());
        out.push(CustomEntry {
            id,
            name: entry.name.clone(),
            path: entry.path.clone(),
        });
    }
    out
}

/// Reports whether the Electron data root holds anything worth importing.
///
/// @param legacy_root - The Electron data root.
/// @returns True when a settings file or backup folder exists.
pub fn legacy_data_available(legacy_root: &Path) -> bool {
    legacy_root.join("settings.json").is_file() || legacy_root.join("backups").is_dir()
}

/// Counts snapshots and results of one history import.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryImport {
    pub snapshots_imported: usize,
    pub snapshots_existing: usize,
    pub snapshots_skipped: usize,
    pub files_matched: usize,
    pub unmatched_folders: usize,
    pub warnings: Vec<String>,
}

/// Persisted result of the last migration, shown in Settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    pub version: u32,
    pub completed_at: i64,
    pub source: String,
    pub settings_imported: bool,
    pub snapshots_imported: usize,
    pub snapshots_existing: usize,
    pub snapshots_skipped: usize,
    pub files_matched: usize,
    pub unmatched_folders: usize,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Reads the migration record, returning `None` when it is missing or corrupt.
///
/// @param data_root - The Tauri data root.
/// @returns The last import record.
pub fn read_record(data_root: &Path) -> Option<ImportRecord> {
    let text = fs::read_to_string(data_root.join(RECORD_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Writes the migration record through a temporary file in the same folder.
///
/// @param data_root - The Tauri data root.
/// @param record - The record to persist.
/// @throws When the folder or file cannot be written.
pub fn write_record(data_root: &Path, record: &ImportRecord) -> Result<(), String> {
    fs::create_dir_all(data_root)
        .map_err(|error| format!("Create the data folder for {RECORD_FILE}: {error}"))?;
    let path = data_root.join(RECORD_FILE);
    let temp = temp_path(&path);
    let text = serde_json::to_string_pretty(record)
        .map_err(|error| format!("Serialize {RECORD_FILE}: {error}"))?;
    let result = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        if path.exists() {
            crate::files::replace_existing(&temp, &path)
        } else {
            fs::rename(&temp, &path)
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error| format!("Write {RECORD_FILE}: {error}"))
}

/// Imports every snapshot whose per-file backup folder matches a registered
/// file. Legacy folders without a matching file are counted and left alone.
///
/// @param legacy_root - The Electron data root.
/// @param history - Target history store in the Tauri data root.
/// @param candidates - Absolute paths of registered files.
/// @param key - Electron profile key, when the profile has one.
/// @returns Import counts and non-fatal warnings.
pub fn import_history(
    legacy_root: &Path,
    history: &HistoryStore,
    candidates: &[PathBuf],
    key: Option<&LegacyProfileKey>,
) -> HistoryImport {
    let mut report = HistoryImport::default();
    let backup_root = legacy_root.join("backups");
    if !backup_root.is_dir() {
        return report;
    }

    let mut seen_paths = HashSet::new();
    let mut matched_folders = HashSet::new();
    for file in candidates {
        let canonical = canonical_or_lexical(file);
        if !seen_paths.insert(path_key(&canonical)) {
            continue;
        }
        let target_dir = history.backup_dir(&canonical);
        let Some(folder_name) = target_dir.file_name() else {
            continue;
        };
        let legacy_dir = backup_root.join(folder_name);
        let Ok(metadata) = fs::symlink_metadata(&legacy_dir) else {
            continue;
        };
        if metadata_is_link(&metadata) || !metadata.is_dir() {
            continue;
        }
        matched_folders.insert(folder_name.to_os_string());
        report.files_matched += 1;
        import_folder(&legacy_dir, &canonical, history, key, &mut report);
    }

    report.unmatched_folders = count_unmatched_folders(&backup_root, &matched_folders);
    report
}

fn import_folder(
    legacy_dir: &Path,
    file: &Path,
    history: &HistoryStore,
    key: Option<&LegacyProfileKey>,
    report: &mut HistoryImport,
) {
    let Ok(entries) = fs::read_dir(legacy_dir) else {
        return;
    };
    let mut named: Vec<(std::ffi::OsString, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        named.push((entry.file_name(), entry.path()));
    }
    named.sort_by(|a, b| a.0.cmp(&b.0));

    for (name, path) in named {
        let name = name.to_string_lossy();
        if name == "_meta.json" || name.starts_with("_meta.json.") {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            report.snapshots_skipped += 1;
            continue;
        };
        if metadata_is_link(&metadata) || !metadata.file_type().is_file() {
            report.snapshots_skipped += 1;
            continue;
        }
        let stored = match read_bounded(&path, MAX_SNAPSHOT_BYTES) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(_) => {
                    report.snapshots_skipped += 1;
                    push_warning(report, format!("{name}: snapshot is not valid UTF-8"));
                    continue;
                }
            },
            Err(error) => {
                report.snapshots_skipped += 1;
                push_warning(report, format!("{name}: {error}"));
                continue;
            }
        };
        let content = match decode_snapshot(&stored, key) {
            Ok(content) => content,
            Err(error) => {
                report.snapshots_skipped += 1;
                push_warning(report, format!("{name}: {error}"));
                continue;
            }
        };
        match history.import_entry(file, name.as_ref(), &content) {
            Ok(true) => report.snapshots_imported += 1,
            Ok(false) => report.snapshots_existing += 1,
            Err(error) => {
                report.snapshots_skipped += 1;
                push_warning(report, format!("{name}: {error}"));
            }
        }
    }
}

fn count_unmatched_folders(backup_root: &Path, matched: &HashSet<std::ffi::OsString>) -> usize {
    let Ok(entries) = fs::read_dir(backup_root) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            if matched.contains(&name) {
                return false;
            }
            entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
        })
        .count()
}

fn push_warning(report: &mut HistoryImport, message: String) {
    if report.warnings.len() < MAX_WARNINGS {
        report.warnings.push(message);
    } else if report.warnings.len() == MAX_WARNINGS {
        report
            .warnings
            .push("further snapshot problems were omitted".to_owned());
    }
}

fn read_bounded(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file is too large to import",
        ));
    }
    Ok(bytes)
}

fn temp_path(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| RECORD_FILE.to_owned());
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".{name}.tmp-{}-{nonce}", std::process::id()))
}

/// Returns the current Unix time in milliseconds for the import record.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(windows)]
fn unwrap_dpapi(protected: &[u8]) -> Result<Vec<u8>, LegacyKeyError> {
    crate::crypto::dpapi_unprotect(protected).map_err(|_| LegacyKeyError::Unwrap)
}

#[cfg(not(windows))]
fn unwrap_dpapi(_protected: &[u8]) -> Result<Vec<u8>, LegacyKeyError> {
    Err(LegacyKeyError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use crate::crypto::dpapi_protect;
    use crate::{
        crypto::HistoryKey,
        settings::{ThemeMode, Workspace},
    };

    fn history(root: &Path, retention: usize) -> HistoryStore {
        HistoryStore::with_retention(
            root.to_path_buf(),
            HistoryKey::from_bytes([6u8; 32]),
            retention,
        )
        .unwrap()
    }

    fn tree(path: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files = Vec::new();
        let mut stack = vec![path.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if entry_path.is_dir() {
                    stack.push(entry_path);
                } else if entry_path.is_file() {
                    files.push((entry_path.clone(), fs::read(&entry_path).unwrap()));
                }
            }
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        files
    }

    #[test]
    fn preserves_plaintext_and_rejects_bad_wrappers() {
        assert_eq!(
            decode_snapshot("synthetic legacy text", None).unwrap(),
            "synthetic legacy text"
        );
        for stored in [
            "maestro-enc:v2:abc",
            "maestro-enc:v1:!",
            "maestro-enc:v1:eHl6",
            "maestro-enc:v1:djEw",
        ] {
            assert!(decode_snapshot(stored, None).is_err(), "{stored}");
        }
        assert!(matches!(
            decode_snapshot("maestro-enc:v1:djEw", None),
            Err(LegacySnapshotError::MissingKey)
        ));
    }

    #[test]
    fn merges_legacy_settings_without_losing_tauri_fields() {
        let current = AppSettings {
            theme: ThemeMode::Light,
            history_limit: 30,
            hidden_tools: vec!["aider".into()],
            recent_files: vec![r"C:\configs\one.json".into()],
            custom: vec![CustomEntry {
                id: "custom-1".into(),
                name: "Current".into(),
                path: PathBuf::from(r"C:\configs\current.json"),
            }],
            workspaces: vec![Workspace {
                id: "workspace-1".into(),
                name: "Project".into(),
                path: PathBuf::from(r"C:\work\project"),
            }],
            ..AppSettings::default()
        };
        let legacy = AppSettings {
            theme: ThemeMode::Dark,
            close_to_tray: true,
            soft_wrap: false,
            hidden_tools: vec!["aider".into(), "cline".into()],
            recent_files: vec![r"C:\configs\two.json".into()],
            custom: vec![
                CustomEntry {
                    id: "custom-1".into(),
                    name: "Legacy".into(),
                    path: PathBuf::from(r"C:\configs\legacy.json"),
                },
                CustomEntry {
                    id: "custom-2".into(),
                    name: "Duplicate".into(),
                    path: PathBuf::from(r"C:\configs\CURRENT.json"),
                },
            ],
            ..AppSettings::default()
        };

        let merged = merge_settings(&current, &legacy);
        assert_eq!(merged.theme, ThemeMode::Dark);
        assert!(merged.close_to_tray);
        assert!(!merged.soft_wrap);
        assert_eq!(merged.history_limit, 30);
        assert_eq!(merged.hidden_tools, ["aider", "cline"]);
        assert_eq!(merged.recent_files.len(), 2);
        assert_eq!(merged.recent_files[0], r"C:\configs\one.json");
        assert_eq!(merged.workspaces, current.workspaces);
        assert_eq!(merged.custom.len(), 2);
        assert_eq!(merged.custom[1].name, "Legacy");
        assert_ne!(merged.custom[1].id, "custom-1");
    }

    #[test]
    fn imports_plaintext_snapshots_and_leaves_legacy_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy");
        let data = temp.path().join("data");
        let file = temp.path().join("settings.json");

        let history = history(&data, 20);
        let legacy_dir = legacy
            .join("backups")
            .join(history.backup_dir(&file).file_name().unwrap());
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("2026-10-20_10-00-00-000_settings.json"),
            "first\n",
        )
        .unwrap();
        fs::write(
            legacy_dir.join("2026-10-21_10-00-00-000_settings.json"),
            "second\n",
        )
        .unwrap();
        let before = tree(&legacy);

        let report = import_history(&legacy, &history, std::slice::from_ref(&file), None);

        assert_eq!(report.files_matched, 1);
        assert_eq!(report.snapshots_imported, 2);
        assert_eq!(report.unmatched_folders, 0);
        let entries = history.list(&file).unwrap();
        let mut contents: Vec<String> = entries
            .iter()
            .map(|entry| history.read(&file, &entry.file).unwrap())
            .collect();
        contents.sort();
        assert_eq!(contents, ["first\n", "second\n"]);
        assert_eq!(tree(&legacy), before, "legacy files must stay untouched");
    }

    #[cfg(windows)]
    #[test]
    fn imports_encrypted_snapshots_with_the_electron_profile_key() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy");
        let data = temp.path().join("data");
        let file = temp.path().join("settings.json");
        fs::create_dir_all(&legacy).unwrap();

        let raw_key = [11u8; 32];
        let protected = dpapi_protect(&raw_key).unwrap();
        let encoded = STANDARD.encode([b"DPAPI", protected.as_slice()].concat());
        fs::write(
            legacy.join("Local State"),
            serde_json::json!({ "os_crypt": { "encrypted_key": encoded } }).to_string(),
        )
        .unwrap();
        let key = LegacyProfileKey::load(&legacy).unwrap().unwrap();

        let history = history(&data, 20);
        let legacy_dir = legacy
            .join("backups")
            .join(history.backup_dir(&file).file_name().unwrap());
        fs::create_dir_all(&legacy_dir).unwrap();
        let sealed = seal_legacy(&raw_key, "secret snapshot\n");
        fs::write(
            legacy_dir.join("2026-10-21_10-00-00-000_settings.json"),
            &sealed,
        )
        .unwrap();

        let report = import_history(&legacy, &history, std::slice::from_ref(&file), Some(&key));

        assert_eq!(report.snapshots_imported, 1);
        assert_eq!(report.warnings, Vec::<String>::new());
        let entries = history.list(&file).unwrap();
        assert_eq!(
            history.read(&file, &entries[0].file).unwrap(),
            "secret snapshot\n"
        );
        assert_eq!(
            decode_snapshot(&sealed, Some(&key)).unwrap(),
            "secret snapshot\n"
        );
    }

    #[test]
    fn skips_encrypted_snapshots_when_the_key_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy");
        let data = temp.path().join("data");
        let file = temp.path().join("settings.json");
        let history = history(&data, 20);
        let legacy_dir = legacy
            .join("backups")
            .join(history.backup_dir(&file).file_name().unwrap());
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("2026-10-20_10-00-00-000_settings.json"),
            "plain\n",
        )
        .unwrap();
        fs::write(
            legacy_dir.join("2026-10-21_10-00-00-000_settings.json"),
            "maestro-enc:v1:djEw",
        )
        .unwrap();

        let report = import_history(&legacy, &history, std::slice::from_ref(&file), None);

        assert_eq!(report.snapshots_imported, 1);
        assert_eq!(report.snapshots_skipped, 1);
        assert_eq!(report.warnings.len(), 1);
        assert_eq!(history.list(&file).unwrap().len(), 1);
    }

    #[test]
    fn second_import_detects_existing_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy");
        let data = temp.path().join("data");
        let file = temp.path().join("settings.json");
        let history = history(&data, 20);
        let legacy_dir = legacy
            .join("backups")
            .join(history.backup_dir(&file).file_name().unwrap());
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("2026-10-20_10-00-00-000_settings.json"),
            "only\n",
        )
        .unwrap();

        let first = import_history(&legacy, &history, std::slice::from_ref(&file), None);
        let second = import_history(&legacy, &history, std::slice::from_ref(&file), None);

        assert_eq!(first.snapshots_imported, 1);
        assert_eq!(second.snapshots_imported, 0);
        assert_eq!(second.snapshots_existing, 1);
        assert_eq!(history.list(&file).unwrap().len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn matches_history_through_a_junction_alias() {
        use std::process::Command;

        let temp = tempfile::tempdir().unwrap();
        let real_dir = temp.path().join("real");
        fs::create_dir_all(&real_dir).unwrap();
        let real_file = real_dir.join("settings.json");
        fs::write(&real_file, "{}").unwrap();
        let alias = temp.path().join("alias");
        let status = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&alias)
            .arg(&real_dir)
            .status()
            .expect("run mklink");
        if !status.success() {
            eprintln!("skipping junction check: mklink /J unavailable");
            return;
        }

        let legacy = temp.path().join("legacy");
        let data = temp.path().join("data");
        let history = history(&data, 20);
        let legacy_dir = legacy
            .join("backups")
            .join(history.backup_dir(&real_file).file_name().unwrap());
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("2026-10-20_10-00-00-000_settings.json"),
            "via alias\n",
        )
        .unwrap();

        let report = import_history(
            &legacy,
            &history,
            std::slice::from_ref(&alias.join("settings.json")),
            None,
        );

        assert_eq!(report.files_matched, 1);
        assert_eq!(report.snapshots_imported, 1);
        let entries = history.list(&real_file).unwrap();
        assert_eq!(
            history.read(&real_file, &entries[0].file).unwrap(),
            "via alias\n"
        );
    }

    #[test]
    fn counts_unmatched_folders_without_reading_them() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy");
        let data = temp.path().join("data");
        fs::create_dir_all(legacy.join("backups").join("orphan.json-0123456789ab")).unwrap();
        fs::write(
            legacy
                .join("backups")
                .join("orphan.json-0123456789ab")
                .join("entry"),
            "orphan",
        )
        .unwrap();

        let report = import_history(&legacy, &history(&data, 20), &[], None);

        assert_eq!(report.files_matched, 0);
        assert_eq!(report.unmatched_folders, 1);
        assert_eq!(report.snapshots_imported, 0);
        assert!(
            legacy
                .join("backups")
                .join("orphan.json-0123456789ab")
                .exists()
        );
    }

    #[test]
    fn ignores_oversized_legacy_settings() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy");
        fs::create_dir_all(&legacy).unwrap();
        let file = File::create(legacy.join("settings.json")).unwrap();
        file.set_len(crate::MAX_FILE_BYTES + 1).unwrap();
        assert!(read_legacy_settings(&legacy).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn refuses_oversized_local_state() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy");
        fs::create_dir_all(&legacy).unwrap();
        let file = File::create(legacy.join("Local State")).unwrap();
        file.set_len(crate::MAX_FILE_BYTES + 1).unwrap();
        assert!(matches!(
            LegacyProfileKey::load(&legacy),
            Err(LegacyKeyError::Corrupt)
        ));
    }

    #[test]
    fn records_round_trip_through_disk() {
        let temp = tempfile::tempdir().unwrap();
        let record = ImportRecord {
            version: RECORD_VERSION,
            completed_at: now_ms(),
            source: r"C:\Users\Example\AppData\Roaming\maestro".into(),
            settings_imported: true,
            snapshots_imported: 3,
            snapshots_existing: 1,
            snapshots_skipped: 0,
            files_matched: 2,
            unmatched_folders: 1,
            warnings: Vec::new(),
        };
        write_record(temp.path(), &record).unwrap();
        let loaded = read_record(temp.path()).unwrap();
        assert_eq!(loaded.snapshots_imported, 3);
        assert_eq!(loaded.source, record.source);
        assert_eq!(
            fs::read_dir(temp.path()).unwrap().count(),
            1,
            "temporary files must not be left behind"
        );

        let updated = ImportRecord {
            completed_at: record.completed_at + 1,
            snapshots_imported: 4,
            ..record
        };
        write_record(temp.path(), &updated).unwrap();
        let loaded = read_record(temp.path()).unwrap();
        assert_eq!(loaded.completed_at, updated.completed_at);
        assert_eq!(loaded.snapshots_imported, 4);
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    fn seal_legacy(key: &[u8; 32], text: &str) -> String {
        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let nonce = [2u8; NONCE_LEN];
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), text.as_bytes())
            .unwrap();
        let mut payload = b"v10".to_vec();
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&ciphertext);
        format!("{LEGACY_SNAPSHOT_PREFIX}{}", STANDARD.encode(payload))
    }
}
