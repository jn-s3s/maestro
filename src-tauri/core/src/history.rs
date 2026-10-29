//! Encrypted per-file snapshot history.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use chrono::Local;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use thiserror::Error;

use crate::{
    crypto::{self, CryptoError, HistoryKey},
    hex_lower, mtime_ms,
    names::is_reserved_device_name,
    paths::{component_count, history_path_key, is_within, lexical_normalize, metadata_is_link},
};

pub const DEFAULT_RETENTION: usize = 20;
pub const MAX_SNAPSHOT_PLAINTEXT_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_SNAPSHOT_NAME_CHARS: usize = 80;
const SNAPSHOT_OVERHEAD_BYTES: u64 = 2 + 12 + 16;
const META_FILE: &str = "_meta.json";
pub const MAX_SNAPSHOT_BYTES: u64 = crypto::SNAPSHOT_PREFIX.len() as u64
    + (MAX_SNAPSHOT_PLAINTEXT_BYTES + SNAPSHOT_OVERHEAD_BYTES).div_ceil(3) * 4;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub file: String,
    pub path: PathBuf,
    pub mtime_ms: i64,
    pub size: u64,
    pub name: Option<String>,
    pub pinned: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
struct EntryMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pinned: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct MetaIndex {
    #[serde(default)]
    entries: BTreeMap<String, EntryMeta>,
}

#[derive(Debug, Error)]
pub enum HistoryError {
    #[error("invalid history entry name")]
    InvalidEntryName,
    #[error("history entry does not exist")]
    NotFound,
    #[error("history entry is larger than 5 MB")]
    TooLarge,
    #[error("retention must be at least one entry")]
    InvalidRetention,
    #[error("snapshot name must be 80 characters or fewer without control characters")]
    InvalidSnapshotName,
    #[error("snapshot could not be protected: {0}")]
    Crypto(#[from] CryptoError),
    #[error("failed to {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

/// Encrypted, deduplicated snapshot history for multiple files under one root.
pub struct HistoryStore {
    root: PathBuf,
    key: HistoryKey,
    retention: usize,
}

impl HistoryStore {
    /// Creates a store with the default 20-snapshot retention.
    ///
    /// @param root - Folder that owns every per-file history directory.
    /// @param key - Key used for every snapshot.
    /// @returns The history store.
    pub fn new(root: PathBuf, key: HistoryKey) -> Self {
        Self {
            root,
            key,
            retention: DEFAULT_RETENTION,
        }
    }

    /// Creates a store with an explicit retention limit.
    ///
    /// @param root - Folder that owns every per-file history directory.
    /// @param key - Key used for every snapshot.
    /// @param retention - Number of newest snapshots to keep, at least one.
    /// @returns The history store.
    /// @throws When retention is zero.
    pub fn with_retention(
        root: PathBuf,
        key: HistoryKey,
        retention: usize,
    ) -> Result<Self, HistoryError> {
        if retention == 0 {
            return Err(HistoryError::InvalidRetention);
        }
        Ok(Self {
            root,
            key,
            retention,
        })
    }

    /// Returns the history root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Returns the history directory for one file.
    ///
    /// @param file_path - Absolute path of the source file.
    /// @returns The per-file history directory, whether or not it exists.
    pub fn backup_dir(&self, file_path: &Path) -> PathBuf {
        self.root.join(backup_dir_name(file_path))
    }

    /// Snapshots file content before a change. Identical consecutive content is
    /// not stored twice, and the oldest entries are pruned after each write.
    ///
    /// @param file_path - Absolute path of the source file.
    /// @param content - The current, plaintext content.
    /// @returns The new snapshot path, or `None` when the content was already
    /// the newest snapshot.
    /// @throws When the snapshot cannot be encrypted or written.
    pub fn snapshot(
        &self,
        file_path: &Path,
        content: &str,
    ) -> Result<Option<PathBuf>, HistoryError> {
        let dir = self.resolve_history_dir(&self.backup_dir(file_path))?;
        if content.len() as u64 > MAX_SNAPSHOT_PLAINTEXT_BYTES {
            return Err(HistoryError::TooLarge);
        }
        fs::create_dir_all(&dir).map_err(|source| HistoryError::Io {
            operation: "create history folder",
            path: dir.clone(),
            source,
        })?;

        let names = self.entry_names(&dir)?;
        if let Some(latest) = names.iter().rev().find(|name| !is_meta_file(name)) {
            if self
                .read_entry(&dir, latest)
                .is_ok_and(|previous| previous == content)
            {
                return Ok(None);
            }
        }

        let sealed = crypto::seal(&self.key, content)?;
        let base_name = file_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "file".to_owned());
        let stamp = Local::now().format("%Y-%m-%d_%H-%M-%S-%3f");
        let mut destination = None;
        for attempt in 0..1000u32 {
            let file_name = if attempt == 0 {
                format!("{stamp}_{base_name}")
            } else {
                format!("{stamp}-{attempt}_{base_name}")
            };
            let candidate = dir.join(&file_name);
            match create_new_file(&candidate) {
                Ok(mut file) => {
                    file.write_all(sealed.as_bytes())
                        .and_then(|_| file.sync_all())
                        .map_err(|source| HistoryError::Io {
                            operation: "write snapshot",
                            path: candidate.clone(),
                            source,
                        })?;
                    destination = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(source) => {
                    return Err(HistoryError::Io {
                        operation: "create snapshot",
                        path: candidate,
                        source,
                    });
                }
            }
        }
        let Some(destination) = destination else {
            return Err(HistoryError::Io {
                operation: "choose a snapshot name in",
                path: dir,
                source: io::Error::new(io::ErrorKind::AlreadyExists, "every candidate name exists"),
            });
        };
        self.prune(&dir);
        Ok(Some(destination))
    }

    /// Lists snapshots for a file, newest first.
    ///
    /// @param file_path - Absolute path of the source file.
    /// @returns The existing snapshot entries.
    pub fn list(&self, file_path: &Path) -> Result<Vec<HistoryEntry>, HistoryError> {
        let dir = self.resolve_history_dir(&self.backup_dir(file_path))?;
        let meta = read_meta_index(&dir);
        let mut entries = Vec::new();
        for name in self.entry_names(&dir)? {
            if is_meta_file(&name) {
                continue;
            }
            let path = dir.join(&name);
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !metadata.file_type().is_file() {
                continue;
            }
            let entry_meta = meta.entries.get(&name).cloned().unwrap_or_default();
            entries.push(HistoryEntry {
                file: name,
                path,
                mtime_ms: mtime_ms(&metadata),
                size: metadata.len(),
                name: entry_meta.name,
                pinned: entry_meta.pinned,
            });
        }
        entries.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.mtime_ms.cmp(&a.mtime_ms))
                .then_with(|| b.file.cmp(&a.file))
        });
        Ok(entries)
    }

    /// Updates the optional display name and pin state of one snapshot.
    ///
    /// Pinned snapshots are exempt from automatic retention pruning.
    ///
    /// @param backup_path - Absolute snapshot path returned by
    /// [`HistoryStore::list`].
    /// @param name - Display name, or `None` to clear it.
    /// @param pinned - Whether retention should keep the snapshot.
    /// @throws When the path or name is invalid or the metadata cannot be
    /// written.
    pub fn set_meta(
        &self,
        backup_path: &Path,
        name: Option<&str>,
        pinned: bool,
    ) -> Result<(), HistoryError> {
        let (dir, file_name) = self.resolve_entry_path(backup_path)?;
        let name = validate_snapshot_name(name)?;
        let mut index = read_meta_index(&dir);
        if name.is_none() && !pinned {
            index.entries.remove(&file_name);
        } else {
            index.entries.insert(file_name, EntryMeta { name, pinned });
        }
        write_meta_index(&dir, &index)
    }

    /// Moves the history of a renamed file to its new per-file directory.
    ///
    /// Existing target history is merged without overwriting snapshots.
    ///
    /// @param old_file - The source file path before the rename.
    /// @param new_file - The source file path after the rename.
    /// @throws When the existing history folder cannot be moved.
    pub fn rename_history(&self, old_file: &Path, new_file: &Path) -> Result<(), HistoryError> {
        let old_dir = self.backup_dir(old_file);
        let new_dir = self.backup_dir(new_file);
        let metadata = match fs::symlink_metadata(&old_dir) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(HistoryError::Io {
                    operation: "inspect history folder",
                    path: old_dir,
                    source,
                });
            }
        };
        if crate::paths::metadata_is_link(&metadata) || !metadata.is_dir() {
            return Err(HistoryError::InvalidEntryName);
        }
        match fs::symlink_metadata(&new_dir) {
            Ok(metadata) if metadata_is_link(&metadata) || !metadata.is_dir() => {
                return Err(HistoryError::InvalidEntryName);
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if let Some(parent) = new_dir.parent() {
                    fs::create_dir_all(parent).map_err(|source| HistoryError::Io {
                        operation: "create history root",
                        path: parent.to_path_buf(),
                        source,
                    })?;
                }
                return fs::rename(&old_dir, &new_dir).map_err(|source| HistoryError::Io {
                    operation: "move history folder",
                    path: old_dir,
                    source,
                });
            }
            Err(source) => {
                return Err(HistoryError::Io {
                    operation: "inspect destination history folder",
                    path: new_dir,
                    source,
                });
            }
        }

        let mut destination_meta = read_meta_index(&new_dir);
        let source_meta = read_meta_index(&old_dir);
        let entries = fs::read_dir(&old_dir).map_err(|source| HistoryError::Io {
            operation: "list source history folder",
            path: old_dir.clone(),
            source,
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| HistoryError::Io {
                operation: "read source history entry",
                path: old_dir.clone(),
                source,
            })?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_meta_file(&name) {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|source| {
                HistoryError::Io {
                    operation: "inspect source history entry",
                    path: entry.path(),
                    source,
                }
            })?;
            if metadata_is_link(&metadata) || !metadata.file_type().is_file() {
                return Err(HistoryError::InvalidEntryName);
            }
            let mut target_name = name.clone();
            let mut attempt = 1usize;
            while new_dir.join(&target_name).exists() {
                target_name = format!("renamed-{attempt}-{name}");
                attempt += 1;
            }
            fs::rename(entry.path(), new_dir.join(&target_name)).map_err(|source| {
                HistoryError::Io {
                    operation: "merge history entry",
                    path: entry.path(),
                    source,
                }
            })?;
            if let Some(meta) = source_meta.entries.get(&name) {
                destination_meta.entries.insert(target_name, meta.clone());
            }
        }
        write_meta_index(&new_dir, &destination_meta)?;
        fs::remove_dir_all(&old_dir).map_err(|source| HistoryError::Io {
            operation: "remove merged history folder",
            path: old_dir,
            source,
        })
    }

    /// Reads and decrypts one snapshot by entry name.
    ///
    /// @param file_path - Absolute path of the source file.
    /// @param file_name - Entry name returned by [`HistoryStore::list`].
    /// @returns The decrypted snapshot content.
    /// @throws When the name is unsafe, the entry is missing, too large, or
    /// cannot be decrypted.
    pub fn read(&self, file_path: &Path, file_name: &str) -> Result<String, HistoryError> {
        let dir = self.resolve_history_dir(&self.backup_dir(file_path))?;
        self.read_entry(&dir, file_name)
    }

    /// Reads and decrypts one snapshot from a full path returned by
    /// [`HistoryStore::list`].
    ///
    /// @param backup_path - Absolute snapshot path below the history root.
    /// @returns The decrypted snapshot content.
    /// @throws When the path is outside the history root, nested too deeply,
    /// is a link, is missing, too large, or cannot be decrypted.
    pub fn read_path(&self, backup_path: &Path) -> Result<String, HistoryError> {
        let (dir, name) = self.resolve_entry_path(backup_path)?;
        self.read_entry(&dir, &name)
    }

    /// Deletes one snapshot by entry name. A missing entry is not an error.
    ///
    /// @param file_path - Absolute path of the source file.
    /// @param file_name - Entry name returned by [`HistoryStore::list`].
    /// @throws When the name is unsafe or deletion fails for another reason.
    pub fn delete(&self, file_path: &Path, file_name: &str) -> Result<(), HistoryError> {
        let name = validate_entry_name(file_name)?;
        let dir = self.resolve_history_dir(&self.backup_dir(file_path))?;
        let path = dir.join(name);
        match fs::remove_file(&path) {
            Ok(()) => {
                remove_meta_entry(&dir, name);
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(HistoryError::Io {
                operation: "delete snapshot",
                path,
                source,
            }),
        }
    }

    /// Deletes one snapshot by full path, ignoring an already-missing entry.
    ///
    /// @param backup_path - Absolute snapshot path below the history root.
    /// @throws When the path is outside the history root, nested too deeply,
    /// is a link, or deletion fails.
    pub fn delete_path(&self, backup_path: &Path) -> Result<(), HistoryError> {
        let (dir, name) = match self.resolve_entry_path(backup_path) {
            Ok(entry) => entry,
            Err(HistoryError::NotFound) => return Ok(()),
            Err(error) => return Err(error),
        };
        match fs::remove_file(dir.join(&name)) {
            Ok(()) => {
                remove_meta_entry(&dir, &name);
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(HistoryError::Io {
                operation: "delete snapshot",
                path: backup_path.to_path_buf(),
                source,
            }),
        }
    }

    /// Removes the whole history for one file.
    ///
    /// @param file_path - Absolute path of the source file.
    /// @throws When the directory exists but cannot be removed.
    pub fn clear(&self, file_path: &Path) -> Result<(), HistoryError> {
        let dir = self.resolve_history_dir(&self.backup_dir(file_path))?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(HistoryError::Io {
                operation: "clear history in",
                path: dir,
                source,
            }),
        }
    }

    fn resolve_entry_path(&self, backup_path: &Path) -> Result<(PathBuf, String), HistoryError> {
        let path = lexical_normalize(backup_path);
        if !path.is_absolute() {
            return Err(HistoryError::InvalidEntryName);
        }
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Err(HistoryError::InvalidEntryName);
        };
        let root = fs::canonicalize(&self.root).map_err(|source| HistoryError::Io {
            operation: "resolve history root",
            path: self.root.clone(),
            source,
        })?;
        let physical_parent = fs::canonicalize(parent).map_err(|source| HistoryError::Io {
            operation: "resolve snapshot folder",
            path: parent.to_path_buf(),
            source,
        })?;
        let direct_child = is_within(&physical_parent, &root)
            && component_count(&physical_parent) == component_count(&root) + 1;
        if !direct_child {
            return Err(HistoryError::InvalidEntryName);
        }
        let Some(name) = name.to_str() else {
            return Err(HistoryError::InvalidEntryName);
        };
        let name = validate_entry_name(name)?;
        let metadata = fs::symlink_metadata(&path).map_err(|source| {
            if source.kind() == io::ErrorKind::NotFound {
                HistoryError::NotFound
            } else {
                HistoryError::Io {
                    operation: "inspect snapshot",
                    path: path.clone(),
                    source,
                }
            }
        })?;
        if metadata_is_link(&metadata) || !metadata.file_type().is_file() {
            return Err(HistoryError::NotFound);
        }
        Ok((physical_parent, name.to_owned()))
    }

    fn resolve_history_dir(&self, dir: &Path) -> Result<PathBuf, HistoryError> {
        let root = crate::paths::canonicalize(&self.root).map_err(|source| {
            HistoryError::Io {
                operation: "resolve history root",
                path: self.root.clone(),
                source: match source {
                    crate::paths::PathError::Resolve { source, .. } => source,
                    crate::paths::PathError::NotAbsolute(_) => {
                        io::Error::new(io::ErrorKind::InvalidInput, "history path is not absolute")
                    }
                },
            }
        })?;
        let physical_dir = crate::paths::canonicalize(dir).map_err(|source| {
            HistoryError::Io {
                operation: "resolve history folder",
                path: dir.to_path_buf(),
                source: match source {
                    crate::paths::PathError::Resolve { source, .. } => source,
                    crate::paths::PathError::NotAbsolute(_) => {
                        io::Error::new(io::ErrorKind::InvalidInput, "history path is not absolute")
                    }
                },
            }
        })?;
        if !is_within(&physical_dir, &root)
            || component_count(&physical_dir) != component_count(&root) + 1
        {
            return Err(HistoryError::InvalidEntryName);
        }
        Ok(physical_dir)
    }

    fn read_entry(&self, dir: &Path, file_name: &str) -> Result<String, HistoryError> {
        let name = validate_entry_name(file_name)?;
        let path = dir.join(name);
        let file = File::open(&path).map_err(|source| {
            if source.kind() == io::ErrorKind::NotFound {
                HistoryError::NotFound
            } else {
                HistoryError::Io {
                    operation: "open snapshot",
                    path: path.clone(),
                    source,
                }
            }
        })?;
        let metadata = file.metadata().map_err(|source| HistoryError::Io {
            operation: "inspect snapshot",
            path: path.clone(),
            source,
        })?;
        if metadata.len() > MAX_SNAPSHOT_BYTES {
            return Err(HistoryError::TooLarge);
        }
        let mut bytes = Vec::new();
        file.take(MAX_SNAPSHOT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|source| HistoryError::Io {
                operation: "read snapshot",
                path: path.clone(),
                source,
            })?;
        if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
            return Err(HistoryError::TooLarge);
        }
        let stored = String::from_utf8(bytes).map_err(|_| CryptoError::NotUtf8)?;
        let plaintext = crypto::open(&self.key, &stored)?;
        if plaintext.len() as u64 > MAX_SNAPSHOT_PLAINTEXT_BYTES {
            return Err(HistoryError::TooLarge);
        }
        Ok(plaintext)
    }

    fn entry_names(&self, dir: &Path) -> Result<Vec<String>, HistoryError> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(HistoryError::Io {
                    operation: "list history in",
                    path: dir.to_path_buf(),
                    source,
                });
            }
        };
        let mut names = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        Ok(names)
    }

    fn prune(&self, dir: &Path) {
        let Ok(names) = self.entry_names(dir) else {
            return;
        };
        let meta = read_meta_index(dir);
        let mut excess = names
            .iter()
            .filter(|name| {
                !is_meta_file(name)
                    && !meta
                        .entries
                        .get(name.as_str())
                        .is_some_and(|entry| entry.pinned)
            })
            .count()
            .saturating_sub(self.retention);
        for name in names {
            if excess == 0 {
                break;
            }
            if is_meta_file(&name)
                || meta
                    .entries
                    .get(&name)
                    .is_some_and(|entry| entry.pinned)
            {
                continue;
            }
            if fs::remove_file(dir.join(&name)).is_err() {
                return;
            }
            remove_meta_entry(dir, &name);
            excess -= 1;
        }
    }
}

fn create_new_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

fn validate_entry_name(name: &str) -> Result<&str, HistoryError> {
    if name.is_empty()
        || name == META_FILE
        || name.contains(':')
        || name.contains('\0')
        || is_reserved_device_name(name)
    {
        return Err(HistoryError::InvalidEntryName);
    }
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(part)), None) if !part.is_empty() => Ok(name),
        _ => Err(HistoryError::InvalidEntryName),
    }
}

fn is_meta_file(name: &str) -> bool {
    name == META_FILE || name.starts_with("_meta.json.")
}

fn validate_snapshot_name(name: Option<&str>) -> Result<Option<String>, HistoryError> {
    let Some(name) = name else {
        return Ok(None);
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_SNAPSHOT_NAME_CHARS || trimmed.chars().any(char::is_control)
    {
        return Err(HistoryError::InvalidSnapshotName);
    }
    Ok(Some(trimmed.to_owned()))
}

fn read_meta_index(dir: &Path) -> MetaIndex {
    fs::read_to_string(dir.join(META_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_meta_index(dir: &Path, index: &MetaIndex) -> Result<(), HistoryError> {
    let path = dir.join(META_FILE);
    if index.entries.is_empty() {
        match fs::remove_file(&path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(HistoryError::Io {
                    operation: "remove snapshot metadata",
                    path,
                    source,
                });
            }
        }
    }
    let text = serde_json::to_string(index).expect("snapshot metadata always serializes");
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|error| HistoryError::Io {
        operation: "generate snapshot metadata filename in",
        path: dir.to_path_buf(),
        source: io::Error::other(error.to_string()),
    })?;
    let temp = dir.join(format!("{META_FILE}.tmp-{}", hex_lower(&random)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|source| HistoryError::Io {
        operation: "create snapshot metadata temporary file",
        path: temp.clone(),
        source,
    })?;
    let write_result = file
        .write_all(text.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(source) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(HistoryError::Io {
            operation: "write snapshot metadata",
            path: path.clone(),
            source,
        });
    }
    fs::rename(&temp, &path).map_err(|source| {
        let _ = fs::remove_file(&temp);
        HistoryError::Io {
            operation: "replace snapshot metadata",
            path: path.clone(),
            source,
        }
    })
}

fn remove_meta_entry(dir: &Path, file_name: &str) {
    let mut index = read_meta_index(dir);
    if index.entries.remove(file_name).is_some() {
        let _ = write_meta_index(dir, &index);
    }
}

fn backup_dir_name(file_path: &Path) -> String {
    let key = history_path_key(file_path);
    let digest = Sha1::digest(key.as_bytes());
    let hash = hex_lower(&digest);
    let base = sanitize_basename(file_path);
    format!("{base}-{}", &hash[..12])
}

fn sanitize_basename(file_path: &Path) -> String {
    let raw = file_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut out = String::new();
    let mut pending_underscore = false;
    for character in raw.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            if pending_underscore {
                out.push('_');
                pending_underscore = false;
            }
            out.push(character);
        } else {
            pending_underscore = true;
        }
    }
    if pending_underscore {
        out.push('_');
    }
    let truncated: String = out.chars().take(40).collect();
    if truncated.is_empty() {
        "file".to_owned()
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::HistoryKey;

    fn store(root: &Path, retention: usize) -> HistoryStore {
        HistoryStore::with_retention(
            root.to_path_buf(),
            HistoryKey::from_bytes([4u8; 32]),
            retention,
        )
        .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn matches_legacy_directory_naming() {
        let root = Path::new(r"C:\Users\Example\AppData\Roaming\maestro\backups");
        let store = HistoryStore::new(root.to_path_buf(), HistoryKey::from_bytes([1u8; 32]));
        let dir = store.backup_dir(Path::new(r"C:\Users\Example\.claude\settings.json"));
        assert_eq!(
            dir.file_name().unwrap().to_string_lossy(),
            "settings.json-8a62b8459460"
        );
    }

    #[test]
    fn snapshots_are_encrypted_and_deduplicated() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("config.json");

        let first = history.snapshot(&file, "one").unwrap().unwrap();
        let stored = fs::read_to_string(&first).unwrap();
        assert!(stored.starts_with(crypto::SNAPSHOT_PREFIX));
        assert!(!stored.contains("one"));

        assert!(history.snapshot(&file, "one").unwrap().is_none());
        let second = history.snapshot(&file, "two").unwrap().unwrap();
        assert_ne!(first, second);

        let entries = history.list(&file).unwrap();
        assert_eq!(entries.len(), 2);
        let newest = entries.first().unwrap();
        assert_eq!(history.read(&file, &newest.file).unwrap(), "two");
    }

    #[test]
    fn prunes_oldest_entries_beyond_retention() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 3);
        let file = temp.path().join("settings.json");
        for index in 0..6 {
            history.snapshot(&file, &format!("value-{index}")).unwrap();
        }
        let entries = history.list(&file).unwrap();
        assert_eq!(entries.len(), 3);
        let contents: Vec<String> = entries
            .iter()
            .map(|entry| history.read(&file, &entry.file).unwrap())
            .collect();
        for expected in ["value-5", "value-4", "value-3"] {
            assert!(
                contents.contains(&expected.to_owned()),
                "{expected} missing"
            );
        }
    }

    #[test]
    fn rejects_traversal_and_alternate_stream_names() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("settings.json");
        history.snapshot(&file, "one").unwrap().unwrap();
        for name in [
            "",
            "..",
            "../outside",
            "nested/file",
            "file:stream",
            "CON",
            "nul.txt",
            "LPT1",
        ] {
            assert!(matches!(
                history.read(&file, name),
                Err(HistoryError::InvalidEntryName)
            ));
            assert!(matches!(
                history.delete(&file, name),
                Err(HistoryError::InvalidEntryName)
            ));
        }
    }

    #[test]
    fn deletes_and_clears_history() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("settings.json");
        history.snapshot(&file, "one").unwrap();
        history.snapshot(&file, "two").unwrap();
        let entries = history.list(&file).unwrap();
        history.delete(&file, &entries[0].file).unwrap();
        assert_eq!(history.list(&file).unwrap().len(), 1);
        history.delete(&file, "missing-entry").unwrap();
        history.clear(&file).unwrap();
        assert!(history.list(&file).unwrap().is_empty());
        history.clear(&file).unwrap();
    }

    #[test]
    fn reads_and_deletes_snapshots_by_full_path() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("settings.json");
        history.snapshot(&file, "one").unwrap();
        let entry = history.list(&file).unwrap().remove(0);
        assert_eq!(history.read_path(&entry.path).unwrap(), "one");
        history.delete_path(&entry.path).unwrap();
        assert!(history.list(&file).unwrap().is_empty());
        history.delete_path(&entry.path).unwrap();
        assert!(matches!(
            history.read_path(&entry.path),
            Err(HistoryError::NotFound)
        ));
    }

    #[test]
    fn rejects_snapshot_paths_outside_the_history_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        let history = store(&root, 20);
        fs::create_dir_all(&root).unwrap();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, "x").unwrap();
        let nested_dir = root.join("settings.json-0123456789ab").join("nested");
        fs::create_dir_all(&nested_dir).unwrap();
        let nested = nested_dir.join("entry");
        fs::write(&nested, "x").unwrap();
        for path in [&outside, &nested, Path::new("relative-entry")] {
            assert!(
                matches!(history.read_path(path), Err(HistoryError::InvalidEntryName)),
                "{path:?}"
            );
            assert!(
                matches!(
                    history.delete_path(path),
                    Err(HistoryError::InvalidEntryName)
                ),
                "{path:?}"
            );
        }
    }

    #[test]
    fn reads_maximum_supported_plaintext_after_encryption_expansion() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("settings.json");
        let content = "x".repeat(MAX_SNAPSHOT_PLAINTEXT_BYTES as usize);
        let snapshot = history.snapshot(&file, &content).unwrap().unwrap();
        assert!(fs::metadata(&snapshot).unwrap().len() <= MAX_SNAPSHOT_BYTES);
        let name = snapshot.file_name().unwrap().to_string_lossy();
        assert_eq!(history.read(&file, name.as_ref()).unwrap(), content);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_snapshot_parent_symlink_outside_history_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let victim = outside.join("victim.txt");
        fs::write(&victim, "synthetic").unwrap();
        symlink(&outside, root.join("redirect")).unwrap();
        let history = store(&root, 20);
        let redirected = root.join("redirect").join("victim.txt");
        assert!(matches!(
            history.delete_path(&redirected),
            Err(HistoryError::InvalidEntryName)
        ));
        assert_eq!(fs::read_to_string(victim).unwrap(), "synthetic");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_snapshot_parent_junction_outside_history_root() {
        use std::process::Command;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let victim = outside.join("victim.txt");
        fs::write(&victim, "synthetic").unwrap();
        let junction = root.join("redirect");
        let status = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&junction)
            .arg(&outside)
            .status()
            .expect("run mklink");
        if !status.success() {
            eprintln!("skipping junction check: mklink /J unavailable");
            return;
        }
        let history = store(&root, 20);
        assert!(matches!(
            history.delete_path(&junction.join("victim.txt")),
            Err(HistoryError::InvalidEntryName)
        ));
        assert_eq!(fs::read_to_string(victim).unwrap(), "synthetic");
    }

    #[test]
    fn a_different_key_cannot_read_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("settings.json");
        history.snapshot(&file, "secret text").unwrap();
        let name = history.list(&file).unwrap()[0].file.clone();

        let other = HistoryStore::new(temp.path().to_path_buf(), HistoryKey::from_bytes([5u8; 32]));
        assert!(matches!(
            other.read(&file, &name),
            Err(HistoryError::Crypto(CryptoError::Authentication))
        ));
    }

    #[test]
    fn stores_names_and_pins_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("settings.json");
        history.snapshot(&file, "one").unwrap();
        let entry = history.list(&file).unwrap().remove(0);
        assert_eq!(entry.name, None);
        assert!(!entry.pinned);

        history
            .set_meta(&entry.path, Some("  Before upgrade  "), true)
            .unwrap();
        let entry = history.list(&file).unwrap().remove(0);
        assert_eq!(entry.name.as_deref(), Some("Before upgrade"));
        assert!(entry.pinned);

        history.set_meta(&entry.path, None, false).unwrap();
        let entry = history.list(&file).unwrap().remove(0);
        assert_eq!(entry.name, None);
        assert!(!entry.pinned);
        assert!(!history.backup_dir(&file).join(META_FILE).exists());

        for invalid in ["x".repeat(MAX_SNAPSHOT_NAME_CHARS + 1), "bad\nname".into()] {
            assert!(matches!(
                history.set_meta(&entry.path, Some(&invalid), false),
                Err(HistoryError::InvalidSnapshotName)
            ));
        }
    }

    #[test]
    fn metadata_write_does_not_follow_predictable_temporary_links() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("settings.json");
        history.snapshot(&file, "snapshot").unwrap();
        let entry = history.list(&file).unwrap().remove(0);
        let linked_target = temp.path().join("outside.txt");
        fs::write(&linked_target, "preserve me").unwrap();
        fs::hard_link(
            &linked_target,
            history.backup_dir(&file).join(format!("{META_FILE}.tmp")),
        )
        .unwrap();

        history
            .set_meta(&entry.path, Some("Named snapshot"), false)
            .unwrap();

        assert_eq!(fs::read_to_string(linked_target).unwrap(), "preserve me");
    }

    #[test]
    fn metadata_does_not_defeat_snapshot_deduplication() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("settings.json");
        history.snapshot(&file, "one").unwrap();
        let entry = history.list(&file).unwrap().remove(0);
        history.set_meta(&entry.path, Some("named"), true).unwrap();
        assert!(history.snapshot(&file, "one").unwrap().is_none());
        assert_eq!(history.list(&file).unwrap().len(), 1);
    }

    #[test]
    fn pinned_snapshots_survive_retention_pruning() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 2);
        let file = temp.path().join("settings.json");
        history.snapshot(&file, "keep").unwrap();
        let pinned = history.list(&file).unwrap().remove(0);
        history.set_meta(&pinned.path, Some("pinned"), true).unwrap();
        for index in 0..4 {
            history.snapshot(&file, &format!("value-{index}")).unwrap();
        }
        let entries = history.list(&file).unwrap();
        assert_eq!(entries.len(), 3, "two retained snapshots plus the pin");
        assert!(entries[0].pinned);
        assert!(entries.iter().any(|entry| entry.file == pinned.file));
    }

    #[test]
    fn moves_history_to_the_renamed_file() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let before = temp.path().join("before.json");
        let after = temp.path().join("after.json");
        history.snapshot(&before, "one").unwrap();
        history.rename_history(&before, &after).unwrap();
        assert!(history.list(&before).unwrap().is_empty());
        assert_eq!(history.list(&after).unwrap().len(), 1);
        history.rename_history(&before, &after).unwrap();
    }

    #[test]
    fn merges_history_when_the_renamed_path_already_has_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let before = temp.path().join("before.json");
        let after = temp.path().join("after.json");
        history.snapshot(&before, "source snapshot").unwrap();
        history.snapshot(&after, "destination snapshot").unwrap();
        let source = history.list(&before).unwrap().remove(0);
        history.set_meta(&source.path, Some("Source"), true).unwrap();

        history.rename_history(&before, &after).unwrap();

        let entries = history.list(&after).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| {
            entry.name.as_deref() == Some("Source") && entry.pinned
        }));
        assert!(history.list(&before).unwrap().is_empty());
    }

    #[test]
    fn retains_zero_byte_and_unicode_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let history = store(temp.path(), 20);
        let file = temp.path().join("notes.md");
        history.snapshot(&file, "").unwrap();
        history.snapshot(&file, "café\r\n日本語").unwrap();
        let entries = history.list(&file).unwrap();
        let mut contents: Vec<String> = entries
            .iter()
            .map(|entry| history.read(&file, &entry.file).unwrap())
            .collect();
        contents.sort();
        assert_eq!(contents, ["", "café\r\n日本語"]);
    }
}
