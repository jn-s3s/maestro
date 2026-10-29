//! Registered-path validation, safe reads and conflict-aware writes.

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    detection::{Tool, ToolFolder},
    hex_lower,
    history::HistoryStore,
    mtime_ms,
    names::{NameError, validate_new_name},
    paths::{
        PathError, canonical_or_lexical, canonicalize, component_count, is_link_like, is_within,
        lexical_normalize, metadata_is_link, path_key,
    },
    validation::{self, ContentError},
    watch::SelfWriteRegistry,
    MAX_FILE_BYTES,
};

#[derive(Debug, Error)]
pub enum FileError {
    #[error("{0}")]
    Path(#[from] PathError),
    #[error("{0}")]
    Content(#[from] ContentError),
    #[error("invalid name: {0}")]
    InvalidName(#[from] NameError),
    #[error("path is not a registered config file")]
    NotRegistered,
    #[error("folder is not registered")]
    NotRegisteredFolder,
    #[error("path is a folder, not a file")]
    NotAFile,
    #[error("path is not a folder")]
    NotAFolder,
    #[error("file is larger than 5 MB. Open it externally instead")]
    TooLarge,
    #[error("file is not valid UTF-8")]
    NotUtf8,
    #[error("target path is a symlink")]
    SymlinkTarget,
    #[error("file changed on disk since it was loaded. Reload before saving")]
    Conflict,
    #[error("a file with this name already exists")]
    FileExists,
    #[error("a folder with this name already exists")]
    FolderExists,
    #[error("root config files cannot be deleted or renamed here")]
    RootFile,
    #[error("the root folder cannot be deleted or renamed here")]
    RootFolder,
    #[error("folder contains tracked config files")]
    ContainsTrackedFiles,
    #[error("file does not exist")]
    Missing,
    #[error("folder does not exist")]
    MissingFolder,
    #[error("failed to create the required backup: {0}")]
    Backup(#[from] crate::history::HistoryError),
    #[error("failed to {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

impl FileError {
    fn io(operation: &'static str, path: &Path, source: io::Error) -> Self {
        Self::Io {
            operation,
            path: path.to_path_buf(),
            source,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Revision(String);

impl Revision {
    /// Returns the revision as a lowercase SHA-256 hex string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn of(bytes: &[u8]) -> Self {
        Self(hex_lower(&Sha256::digest(bytes)))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub exists: bool,
    pub content: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub revision: Option<Revision>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: PathBuf,
    pub rel: String,
    pub is_dir: bool,
    pub mtime_ms: i64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub exists: bool,
    pub entries: Vec<DirEntry>,
}

#[derive(Debug, Clone)]
pub struct WriteRequest<'a> {
    pub content: &'a str,
    /// Revision returned when the document was loaded. Must be present for an
    /// existing file and absent for a file that does not exist yet.
    pub expected_revision: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub created: bool,
    pub revision: Revision,
    pub backup: Option<PathBuf>,
}

struct FolderEntry {
    key: String,
    canonical: PathBuf,
    depth: usize,
    tool_index: usize,
    folder_index: usize,
}

/// An immutable snapshot of the detected tools with pre-computed path keys for
/// registered-path validation.
pub struct Registry {
    tools: Vec<Tool>,
    file_keys: HashSet<String>,
    file_paths: Vec<PathBuf>,
    secret_keys: HashSet<String>,
    folder_keys: HashSet<String>,
    folders: Vec<FolderEntry>,
}

impl Registry {
    /// Builds lookup tables from detected tools.
    ///
    /// @param tools - The detected tool list.
    /// @returns The registry.
    pub fn new(tools: Vec<Tool>) -> Self {
        let mut file_keys = HashSet::new();
        let mut file_paths = Vec::new();
        let mut secret_keys = HashSet::new();
        let mut folder_keys = HashSet::new();
        let mut folders = Vec::new();
        for (tool_index, tool) in tools.iter().enumerate() {
            for file in &tool.files {
                let canonical = canonical_or_lexical(&file.path);
                let key = path_key(&canonical);
                file_keys.insert(key.clone());
                file_paths.push(canonical);
                if file.secret {
                    secret_keys.insert(key);
                }
            }
            for (folder_index, folder) in tool.folders.iter().enumerate() {
                let canonical = canonical_or_lexical(&folder.path);
                let key = path_key(&canonical);
                folder_keys.insert(key.clone());
                folders.push(FolderEntry {
                    key,
                    depth: component_count(&canonical),
                    canonical,
                    tool_index,
                    folder_index,
                });
            }
        }
        Self {
            tools,
            file_keys,
            file_paths,
            secret_keys,
            folder_keys,
            folders,
        }
    }

    /// Returns the tools this registry was built from.
    pub fn tools(&self) -> &[Tool] {
        &self.tools
    }

    /// Reports whether the exact canonical path is a registered config file.
    pub fn is_registered_file(&self, path: &Path) -> bool {
        self.file_keys.contains(&registry_key(path))
    }

    /// Reports whether the exact canonical path is a secret-bearing file.
    pub fn is_secret_file(&self, path: &Path) -> bool {
        self.secret_keys.contains(&registry_key(path))
    }

    /// Reports whether the exact canonical path is a registered folder root.
    ///
    /// @param path - The canonical path to check.
    /// @returns True when the path is a registered root folder.
    pub fn is_registered_folder_root(&self, path: &Path) -> bool {
        self.folder_keys.contains(&path_key(path))
    }

    /// Reports whether any registered config file sits inside a folder.
    ///
    /// @param folder - The canonical folder to inspect.
    /// @returns True when deleting the folder would remove a tracked file.
    pub fn has_registered_file_within(&self, folder: &Path) -> bool {
        self.file_paths
            .iter()
            .any(|file| is_within(file, folder) && path_key(file) != path_key(folder))
    }

    /// Finds the deepest registered folder that contains a path.
    ///
    /// @param path - Absolute path to look up.
    /// @returns The containing folder when found.
    pub fn containing_folder(&self, path: &Path) -> Option<&ToolFolder> {
        let canonical = canonical_or_lexical(path);
        self.deepest_folder(&canonical)
            .map(|entry| &self.tools[entry.tool_index].folders[entry.folder_index])
    }

    /// Resolves and validates a path for file reads, writes and stats.
    ///
    /// @param raw - The untrusted path to resolve.
    /// @returns The canonical path.
    /// @throws When the path cannot be resolved, is a registered folder root,
    /// or is outside every registered region.
    pub fn resolve_file(&self, raw: &Path) -> Result<PathBuf, FileError> {
        let canonical = canonicalize(raw)?;
        let key = path_key(&canonical);
        if self.file_keys.contains(&key) || self.deepest_folder(&canonical).is_some() {
            Ok(canonical)
        } else {
            Err(FileError::NotRegistered)
        }
    }

    /// Resolves and validates a path for folder operations.
    ///
    /// @param raw - The untrusted path to resolve.
    /// @returns The canonical path.
    /// @throws When the path is outside every registered folder.
    pub fn resolve_folder(&self, raw: &Path) -> Result<PathBuf, FileError> {
        let canonical = canonicalize(raw)?;
        let key = path_key(&canonical);
        if !self.folder_keys.contains(&key) && self.deepest_folder(&canonical).is_none() {
            return Err(FileError::NotRegisteredFolder);
        }
        if canonical.exists() && !canonical.is_dir() {
            return Err(FileError::NotAFolder);
        }
        Ok(canonical)
    }

    /// Resolves a path that may be revealed to the user.
    ///
    /// @param raw - The untrusted path to resolve.
    /// @returns The canonical path.
    /// @throws When the path is not a registered file, folder or child path.
    pub fn resolve_reveal(&self, raw: &Path) -> Result<PathBuf, FileError> {
        let canonical = canonicalize(raw)?;
        let key = path_key(&canonical);
        if self.file_keys.contains(&key)
            || self.folder_keys.contains(&key)
            || self.deepest_folder(&canonical).is_some()
        {
            Ok(canonical)
        } else {
            Err(FileError::NotRegistered)
        }
    }

    fn deepest_folder(&self, canonical: &Path) -> Option<&FolderEntry> {
        let key = path_key(canonical);
        let mut best: Option<&FolderEntry> = None;
        for entry in &self.folders {
            if entry.key == key || !is_within(canonical, &entry.canonical) {
                continue;
            }
            if best.is_none_or(|best| entry.depth > best.depth) {
                best = Some(entry);
            }
        }
        best
    }

    fn allows_canonical_file(&self, canonical: &Path) -> bool {
        self.file_keys.contains(&path_key(canonical)) || self.deepest_folder(canonical).is_some()
    }
}

/// Reads, writes and records history for registered configuration files.
pub struct FileStore {
    registry: Registry,
    history: HistoryStore,
    self_writes: Arc<SelfWriteRegistry>,
}

impl FileStore {
    /// Creates a file store.
    ///
    /// @param registry - The detected tool registry.
    /// @param history - Encrypted history used before overwriting a file.
    /// @param self_writes - Registry shared with filesystem watchers.
    /// @returns The file store.
    pub fn new(
        registry: Registry,
        history: HistoryStore,
        self_writes: Arc<SelfWriteRegistry>,
    ) -> Self {
        Self {
            registry,
            history,
            self_writes,
        }
    }

    /// Returns the underlying registry.
    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// Returns the encrypted history store used by this file store.
    pub fn history(&self) -> &HistoryStore {
        &self.history
    }

    /// Returns the self-write registry used by this store.
    pub fn self_writes(&self) -> &Arc<SelfWriteRegistry> {
        &self.self_writes
    }

    /// Reads a registered file through a bounded read.
    ///
    /// @param raw - The untrusted path to read.
    /// @returns The file content, size, modification time and revision, or
    /// `exists: false` when the file is missing.
    /// @throws When the path is not registered, is a folder, is larger than
    /// 5 MB, or is not valid UTF-8.
    pub fn read_file(&self, raw: &Path) -> Result<ReadResult, FileError> {
        let path = self.registry.resolve_file(raw)?;
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(ReadResult {
                    exists: false,
                    content: String::new(),
                    size: 0,
                    mtime_ms: 0,
                    revision: None,
                });
            }
            Err(source) => return Err(FileError::io("open", &path, source)),
        };
        let opened_path = opened_file_path(&file, &path)?;
        if !self.registry.allows_canonical_file(&opened_path) {
            return Err(FileError::NotRegistered);
        }
        let metadata = file
            .metadata()
            .map_err(|source| FileError::io("inspect", &path, source))?;
        if metadata.is_dir() {
            return Err(FileError::NotAFile);
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(FileError::TooLarge);
        }
        let bytes = read_limited_file(file, &path)?;
        let content = String::from_utf8(bytes).map_err(|_| FileError::NotUtf8)?;
        let revision = Revision::of(content.as_bytes());
        Ok(ReadResult {
            exists: true,
            size: content.len() as u64,
            mtime_ms: mtime_ms(&metadata),
            content,
            revision: Some(revision),
        })
    }

    /// Returns the size and modification time of a registered file.
    ///
    /// @param raw - The untrusted path to inspect.
    /// @returns The stat, or `None` when the file is missing.
    pub fn stat_file(&self, raw: &Path) -> Result<Option<FileStat>, FileError> {
        let path = self.registry.resolve_file(raw)?;
        match fs::metadata(&path) {
            Ok(metadata) => Ok(Some(FileStat {
                size: metadata.len(),
                mtime_ms: mtime_ms(&metadata),
            })),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(FileError::io("inspect", &path, source)),
        }
    }

    /// Writes a registered file after validating the expected revision and
    /// snapshotting the previous content.
    ///
    /// Existing files are replaced through a temporary file and a
    /// Windows-aware replacement that keeps the original ACLs. New files are
    /// installed through a temporary file and an atomic no-clobber link, so a
    /// concurrently created target is never overwritten and a crash cannot
    /// leave a partial file. A failed snapshot aborts the write.
    ///
    /// @param raw - The untrusted path to write.
    /// @param request - Content and expected revision.
    /// @returns The resulting revision, whether the file was created, and the
    /// snapshot path when one was written.
    /// @throws When the path or content is invalid, the file changed on disk,
    /// the target is a symlink, or the backup or write fails.
    pub fn write_file(
        &self,
        raw: &Path,
        request: WriteRequest<'_>,
    ) -> Result<WriteResult, FileError> {
        if raw.is_absolute() && is_link_like(&lexical_normalize(raw)) {
            return Err(FileError::SymlinkTarget);
        }
        let path = self.registry.resolve_file(raw)?;
        if is_link_like(&path) {
            return Err(FileError::SymlinkTarget);
        }
        let bytes = request.content.as_bytes();
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(FileError::TooLarge);
        }
        validation::validate_content(&path, request.content)?;

        let existing = match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata_is_link(&metadata) {
                    return Err(FileError::SymlinkTarget);
                }
                if metadata.is_dir() {
                    return Err(FileError::NotAFile);
                }
                Some(metadata)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(source) => return Err(FileError::io("inspect", &path, source)),
        };

        let current = match &existing {
            Some(metadata) => {
                if metadata.len() > MAX_FILE_BYTES {
                    return Err(FileError::TooLarge);
                }
                Some(read_limited(&path)?)
            }
            None => None,
        };
        let current_revision = current.as_deref().map(Revision::of);
        match (current_revision.as_ref(), request.expected_revision) {
            (None, None) => {}
            (Some(actual), Some(expected)) if actual.as_str() == expected => {}
            _ => return Err(FileError::Conflict),
        }

        if let Some(metadata) = &existing {
            if !disk_unchanged(&path, metadata) {
                return Err(FileError::Conflict);
            }
        }

        self.self_writes.mark(&path);

        if existing.is_some() {
            let backup = if let Some(disk) = current.as_deref().filter(|disk| !disk.is_empty()) {
                let text = std::str::from_utf8(disk).map_err(|_| FileError::NotUtf8)?;
                self.history.snapshot(&path, text)?
            } else {
                None
            };

            let temp_path = self.write_temp_file(&path, bytes, existing.as_ref())?;
            if let Some(metadata) = &existing {
                if !disk_unchanged(&path, metadata) {
                    remove_quietly(&temp_path);
                    return Err(FileError::Conflict);
                }
            }
            if let Err(source) = replace_existing(&temp_path, &path) {
                remove_quietly(&temp_path);
                return Err(FileError::io("replace", &path, source));
            }
            sync_parent(&path);
            return Ok(WriteResult {
                created: false,
                revision: Revision::of(bytes),
                backup,
            });
        }

        let temp_path = self.write_temp_file(&path, bytes, None)?;
        match fs::hard_link(&temp_path, &path) {
            Ok(()) => remove_quietly(&temp_path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                remove_quietly(&temp_path);
                return Err(FileError::Conflict);
            }
            Err(_) => {
                remove_quietly(&temp_path);
                write_new_file(&path, bytes)?;
            }
        }
        sync_parent(&path);
        Ok(WriteResult {
            created: true,
            revision: Revision::of(bytes),
            backup: None,
        })
    }

    /// Lists the direct children of a registered folder.
    ///
    /// Dot-prefixed entries and links are skipped so browsing cannot reach
    /// hidden or redirected content. A missing folder returns
    /// `exists: false` with no entries.
    ///
    /// @param raw - The untrusted folder path to list.
    /// @returns Whether the folder exists and its sorted direct children.
    /// @throws When the path is outside every registered folder or is a file.
    pub fn list_folder(&self, raw: &Path) -> Result<FolderListing, FileError> {
        let path = self.registry.resolve_folder(raw)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(FolderListing {
                    exists: false,
                    entries: Vec::new(),
                });
            }
            Err(source) => return Err(FileError::io("inspect", &path, source)),
        };
        if metadata_is_link(&metadata) {
            return Err(FileError::SymlinkTarget);
        }
        if !metadata.is_dir() {
            return Err(FileError::NotAFolder);
        }
        let reader = fs::read_dir(&path).map_err(|source| FileError::io("list", &path, source))?;
        let mut entries = Vec::new();
        for entry in reader {
            let Ok(entry) = entry else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let full = path.join(&name);
            let Ok(metadata) = fs::symlink_metadata(&full) else {
                continue;
            };
            if metadata_is_link(&metadata) {
                continue;
            }
            entries.push(DirEntry {
                name: name.clone(),
                path: full,
                rel: name,
                is_dir: metadata.is_dir(),
                mtime_ms: mtime_ms(&metadata),
                size: metadata.len(),
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()))
                .then_with(|| a.rel.cmp(&b.rel))
        });
        Ok(FolderListing {
            exists: true,
            entries,
        })
    }

    /// Creates an empty file inside a registered folder.
    ///
    /// @param raw_folder - The untrusted folder path.
    /// @param name - The untrusted new file name.
    /// @returns The created file path.
    /// @throws When the folder or name is invalid or the name already exists.
    pub fn create_file_in(&self, raw_folder: &Path, name: &str) -> Result<PathBuf, FileError> {
        let folder = self.registry.resolve_folder(raw_folder)?;
        let name = validate_new_name(name)?;
        fs::create_dir_all(&folder)
            .map_err(|source| FileError::io("create parent of", &folder, source))?;
        let target = folder.join(name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => {
                drop(file);
                self.self_writes.mark(&target);
                Ok(target)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(FileError::FileExists)
            }
            Err(source) => Err(FileError::io("create", &target, source)),
        }
    }

    /// Creates a subfolder inside a registered folder.
    ///
    /// @param raw_folder - The untrusted parent folder path.
    /// @param name - The untrusted new folder name.
    /// @returns The created folder path.
    /// @throws When the parent or name is invalid or the name already exists.
    pub fn create_folder_in(&self, raw_folder: &Path, name: &str) -> Result<PathBuf, FileError> {
        let folder = self.registry.resolve_folder(raw_folder)?;
        let name = validate_new_name(name)?;
        fs::create_dir_all(&folder)
            .map_err(|source| FileError::io("create parent of", &folder, source))?;
        let target = folder.join(name);
        match fs::create_dir(&target) {
            Ok(()) => {
                self.self_writes.mark(&target);
                Ok(target)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(FileError::FolderExists)
            }
            Err(source) => Err(FileError::io("create", &target, source)),
        }
    }

    /// Renames a file inside a registered folder. Registered root config files
    /// cannot be renamed here.
    ///
    /// @param raw - The untrusted current file path.
    /// @param new_name - The untrusted new file name.
    /// @returns The renamed path, or the original path for a case-only rename.
    /// @throws When the file is missing, is a link, is a root config file, or
    /// the new name is invalid or already taken.
    pub fn rename_file(&self, raw: &Path, new_name: &str) -> Result<PathBuf, FileError> {
        if raw.is_absolute() && is_link_like(&lexical_normalize(raw)) {
            return Err(FileError::SymlinkTarget);
        }
        let source = self.registry.resolve_file(raw)?;
        if self.registry.is_registered_file(&source) {
            return Err(FileError::RootFile);
        }
        if is_link_like(&source) {
            return Err(FileError::SymlinkTarget);
        }
        match fs::symlink_metadata(&source) {
            Ok(metadata) if metadata.is_dir() => return Err(FileError::NotAFile),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(FileError::Missing);
            }
            Err(source_error) => {
                return Err(FileError::io("inspect", &source, source_error));
            }
        }
        let name = validate_new_name(new_name)?;
        let parent = source
            .parent()
            .ok_or_else(|| FileError::Path(PathError::NotAbsolute(source.clone())))?;
        let target = parent.join(name);
        if path_key(&target) == path_key(&source) {
            return Ok(source);
        }
        match fs::symlink_metadata(&target) {
            Ok(_) => return Err(FileError::FileExists),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source_error) => {
                return Err(FileError::io("inspect", &target, source_error));
            }
        }
        match fs::rename(&source, &target) {
            Ok(()) => {
                let _ = self.history.rename_history(&source, &target);
                Ok(target)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(FileError::FileExists)
            }
            Err(source_error) => Err(FileError::io("rename", &source, source_error)),
        }
    }

    /// Renames a folder inside a registered folder. Registered root folders
    /// cannot be renamed here.
    ///
    /// @param raw - The untrusted current folder path.
    /// @param new_name - The untrusted new folder name.
    /// @returns The renamed path, or the original path for a case-only rename.
    /// @throws When the folder is missing, is a link, is a root, or the new
    /// name is invalid or already taken.
    pub fn rename_folder(&self, raw: &Path, new_name: &str) -> Result<PathBuf, FileError> {
        if raw.is_absolute() && is_link_like(&lexical_normalize(raw)) {
            return Err(FileError::SymlinkTarget);
        }
        let source = self.registry.resolve_folder(raw)?;
        if self.registry.is_registered_folder_root(&source) {
            return Err(FileError::RootFolder);
        }
        if is_link_like(&source) {
            return Err(FileError::SymlinkTarget);
        }
        match fs::symlink_metadata(&source) {
            Ok(metadata) if !metadata.is_dir() => return Err(FileError::NotAFolder),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(FileError::MissingFolder);
            }
            Err(source_error) => {
                return Err(FileError::io("inspect", &source, source_error));
            }
        }
        let name = validate_new_name(new_name)?;
        let parent = source
            .parent()
            .ok_or_else(|| FileError::Path(PathError::NotAbsolute(source.clone())))?;
        let target = parent.join(name);
        if path_key(&target) == path_key(&source) {
            return Ok(source);
        }
        match fs::symlink_metadata(&target) {
            Ok(_) => return Err(FileError::FolderExists),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source_error) => {
                return Err(FileError::io("inspect", &target, source_error));
            }
        }
        match fs::rename(&source, &target) {
            Ok(()) => Ok(target),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(FileError::FolderExists)
            }
            Err(source_error) => Err(FileError::io("rename", &source, source_error)),
        }
    }

    /// Validates that a file may be sent to the Recycle Bin.
    ///
    /// @param raw - The untrusted file path to delete.
    /// @returns The canonical path the caller may trash.
    /// @throws When the file is missing, is a link, is a folder, or is a
    /// registered root config file.
    pub fn delete_file_target(&self, raw: &Path) -> Result<PathBuf, FileError> {
        if raw.is_absolute() && is_link_like(&lexical_normalize(raw)) {
            return Err(FileError::SymlinkTarget);
        }
        let source = self.registry.resolve_file(raw)?;
        if self.registry.is_registered_file(&source) {
            return Err(FileError::RootFile);
        }
        if is_link_like(&source) {
            return Err(FileError::SymlinkTarget);
        }
        match fs::symlink_metadata(&source) {
            Ok(metadata) if metadata.is_dir() => Err(FileError::NotAFile),
            Ok(_) => Ok(source),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Err(FileError::Missing),
            Err(source_error) => Err(FileError::io("inspect", &source, source_error)),
        }
    }

    /// Validates that a folder may be sent to the Recycle Bin.
    ///
    /// @param raw - The untrusted folder path to delete.
    /// @returns The canonical path the caller may trash.
    /// @throws When the folder is missing, is a link, is a registered root, or
    /// contains a registered config file.
    pub fn delete_folder_target(&self, raw: &Path) -> Result<PathBuf, FileError> {
        if raw.is_absolute() && is_link_like(&lexical_normalize(raw)) {
            return Err(FileError::SymlinkTarget);
        }
        let folder = self.registry.resolve_folder(raw)?;
        if self.registry.is_registered_folder_root(&folder) {
            return Err(FileError::RootFolder);
        }
        if is_link_like(&folder) {
            return Err(FileError::SymlinkTarget);
        }
        match fs::symlink_metadata(&folder) {
            Ok(metadata) if !metadata.is_dir() => return Err(FileError::NotAFolder),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(FileError::MissingFolder);
            }
            Err(source_error) => {
                return Err(FileError::io("inspect", &folder, source_error));
            }
        }
        if self.registry.has_registered_file_within(&folder) {
            return Err(FileError::ContainsTrackedFiles);
        }
        Ok(folder)
    }

    fn write_temp_file(
        &self,
        target: &Path,
        bytes: &[u8],
        existing: Option<&fs::Metadata>,
    ) -> Result<PathBuf, FileError> {
        let (temp_path, mut file) = create_temp_file(target)?;
        self.self_writes.mark(&temp_path);
        if let Err(source) = preserve_permissions(existing, &temp_path) {
            remove_quietly(&temp_path);
            return Err(FileError::io("restrict temporary permissions for", target, source));
        }
        let result = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        if let Err(source) = result {
            remove_quietly(&temp_path);
            return Err(FileError::io("write", &temp_path, source));
        }
        Ok(temp_path)
    }
}

fn disk_unchanged(path: &Path, expected: &fs::Metadata) -> bool {
    fs::symlink_metadata(path).is_ok_and(|fresh| {
        !metadata_is_link(&fresh)
            && fresh.len() == expected.len()
            && fresh.modified().ok() == expected.modified().ok()
    })
}

fn write_new_file(target: &Path, bytes: &[u8]) -> Result<(), FileError> {
    match open_new_file_secure(target) {
        Ok(mut file) => {
            let result = file.write_all(bytes).and_then(|()| file.sync_all());
            drop(file);
            if let Err(source) = result {
                remove_quietly(target);
                return Err(FileError::io("write", target, source));
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(FileError::Conflict),
        Err(source) => Err(FileError::io("create", target, source)),
    }
}

fn registry_key(path: &Path) -> String {
    path_key(&canonical_or_lexical(path))
}

fn read_limited(path: &Path) -> Result<Vec<u8>, FileError> {
    let file = File::open(path).map_err(|source| FileError::io("open", path, source))?;
    read_limited_file(file, path)
}

fn read_limited_file(file: File, path: &Path) -> Result<Vec<u8>, FileError> {
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| FileError::io("read", path, source))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    Ok(bytes)
}

#[cfg(windows)]
fn opened_file_path(file: &File, display_path: &Path) -> Result<PathBuf, FileError> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};

    let handle = file.as_raw_handle().cast();
    let mut buffer = vec![0u16; 32_768];
    // SAFETY: the file handle remains open and the writable buffer is valid for its length.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return Err(FileError::io(
            "resolve opened file",
            display_path,
            io::Error::last_os_error(),
        ));
    }
    buffer.truncate(length as usize);
    let final_path = PathBuf::from(std::ffi::OsString::from_wide(&buffer));
    Ok(crate::paths::strip_verbatim(final_path))
}

#[cfg(not(windows))]
fn opened_file_path(_file: &File, display_path: &Path) -> Result<PathBuf, FileError> {
    crate::paths::canonicalize(display_path).map_err(FileError::from)
}

fn create_temp_file(target: &Path) -> Result<(PathBuf, File), FileError> {
    let parent = target
        .parent()
        .ok_or_else(|| FileError::Path(PathError::NotAbsolute(target.to_path_buf())))?;
    fs::create_dir_all(parent)
        .map_err(|source| FileError::io("create parent of", target, source))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    for _ in 0..16 {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|error| {
            FileError::io(
                "generate a temporary name for",
                target,
                io::Error::other(error.to_string()),
            )
        })?;
        let candidate = parent.join(format!("{name}.tmp-{}", hex_lower(&random)));
        match open_new_file_secure(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => {
                return Err(FileError::io(
                    "create a temporary file next to",
                    target,
                    source,
                ));
            }
        }
    }
    Err(FileError::io(
        "create a temporary file next to",
        target,
        io::Error::new(io::ErrorKind::AlreadyExists, "every candidate name exists"),
    ))
}

#[cfg(unix)]
fn open_new_file_secure(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(windows)]
fn open_new_file_secure(path: &Path) -> io::Result<File> {
    use std::{
        mem,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
    };
    use windows_sys::Win32::{
        Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree},
        Security::SECURITY_ATTRIBUTES,
        Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
        Storage::FileSystem::{CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL},
    };

    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)\0".encode_utf16().collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: the SDDL buffer is nul-terminated and `descriptor` is a valid output pointer.
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: path and security attributes remain valid for the call; the returned handle is
    // transferred to `File` below, and the descriptor is freed after the call.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    // SAFETY: the descriptor was allocated by the Windows security conversion API.
    unsafe { LocalFree(descriptor.cast()) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `handle` is a newly-created valid file handle and ownership transfers to `File`.
    Ok(unsafe { File::from_raw_handle(handle.cast()) })
}

fn remove_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}

/// Copies the replaced file's mode onto the temporary file on Unix. Windows
/// replacement keeps the original ACLs through `ReplaceFileW` instead.
fn preserve_permissions(existing: Option<&fs::Metadata>, destination: &Path) -> io::Result<()> {
    #[cfg(not(windows))]
    if let Some(metadata) = existing {
        fs::set_permissions(destination, metadata.permissions())?;
    }
    #[cfg(windows)]
    let _ = (existing, destination);
    Ok(())
}

#[cfg(not(windows))]
fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

#[cfg(windows)]
fn sync_parent(_path: &Path) {}

#[cfg(not(windows))]
fn replace_existing(temp: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temp, target)
}

#[cfg(windows)]
fn replace_existing(temp: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        REPLACEFILE_IGNORE_MERGE_ERRORS, REPLACEFILE_WRITE_THROUGH, ReplaceFileW,
    };

    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_INVALID_FUNCTION: i32 = 1;
    const ERROR_NOT_SUPPORTED: i32 = 50;
    const ERROR_CALL_NOT_IMPLEMENTED: i32 = 120;

    let wide = |path: &Path| -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let target_wide = wide(target);
    let temp_wide = wide(temp);
    let deadline = Instant::now() + Duration::from_millis(250);
    loop {
        // SAFETY: both paths are nul-terminated buffers that outlive the call,
        // and the replacement file has been closed.
        let replaced = unsafe {
            ReplaceFileW(
                target_wide.as_ptr(),
                temp_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if replaced != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error().unwrap_or(0) {
            ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED | ERROR_CALL_NOT_IMPLEMENTED => {
                // SAFETY: both paths are nul-terminated buffers that outlive the call.
                let moved = unsafe {
                    MoveFileExW(
                        temp_wide.as_ptr(),
                        target_wide.as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                };
                return if moved != 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                };
            }
            ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => return Err(error),
        }
    }
}
