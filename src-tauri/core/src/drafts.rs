//! Encrypted storage for unsaved editor drafts.
//!
//! Drafts survive restarts and are sealed with the same machine-bound key as
//! snapshot history. One file can have at most one draft; saving or deleting a
//! draft replaces or removes it.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use thiserror::Error;

use crate::{
    crypto::{self, CryptoError, HistoryKey},
    hex_lower,
    paths::{history_path_key, lexical_normalize},
};

pub const MAX_DRAFT_FILE_BYTES: u64 = 64 * 1024 * 1024;
const DRAFT_PREFIX: &str = "draft-";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub path: String,
    pub content: String,
    pub base_revision: Option<String>,
    pub saved_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
struct Payload {
    path: String,
    content: String,
    #[serde(default)]
    base_revision: Option<String>,
    saved_at: i64,
}

#[derive(Debug, Error)]
pub enum DraftError {
    #[error("draft content is larger than 5 MB")]
    TooLarge,
    #[error("draft path must be absolute")]
    NotAbsolute,
    #[error("draft could not be protected: {0}")]
    Crypto(#[from] CryptoError),
    #[error("failed to {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

/// Encrypted draft files under one data root.
pub struct DraftStore {
    root: PathBuf,
    key: HistoryKey,
}

impl DraftStore {
    /// Creates a draft store.
    ///
    /// @param root - Folder that owns every draft file.
    /// @param key - Key used for every draft.
    /// @returns The draft store.
    pub fn new(root: PathBuf, key: HistoryKey) -> Self {
        Self { root, key }
    }

    /// Writes or replaces the draft for a file.
    ///
    /// @param path - Absolute path of the source file.
    /// @param content - Unsaved editor content.
    /// @param base_revision - Revision the draft was edited from, if known.
    /// @returns The stored draft metadata.
    /// @throws When the path is relative, the content is too large, or the
    /// draft cannot be encrypted or written.
    pub fn save(
        &self,
        path: &Path,
        content: &str,
        base_revision: Option<&str>,
    ) -> Result<Draft, DraftError> {
        if !path.is_absolute() {
            return Err(DraftError::NotAbsolute);
        }
        if content.len() as u64 > crate::MAX_FILE_BYTES {
            return Err(DraftError::TooLarge);
        }
        let logical = lexical_normalize(path);
        let saved_at = now_ms();
        let payload = Payload {
            path: logical.to_string_lossy().into_owned(),
            content: content.to_owned(),
            base_revision: base_revision.map(str::to_owned),
            saved_at,
        };
        let encoded =
            serde_json::to_string(&payload).expect("a draft payload always serializes");
        let sealed = crypto::seal(&self.key, &encoded)?;
        if sealed.len() as u64 > MAX_DRAFT_FILE_BYTES {
            return Err(DraftError::TooLarge);
        }
        fs::create_dir_all(&self.root).map_err(|source| DraftError::Io {
            operation: "create draft folder",
            path: self.root.clone(),
            source,
        })?;
        let destination = self.draft_path(&logical);
        let temp = self.write_temp(&sealed)?;
        if let Err(first) = fs::rename(&temp, &destination) {
            if !matches!(
                first.kind(),
                io::ErrorKind::AlreadyExists | io::ErrorKind::PermissionDenied
            ) {
                let _ = fs::remove_file(&temp);
                return Err(DraftError::Io {
                    operation: "replace draft",
                    path: destination,
                    source: first,
                });
            }
            let _ = fs::remove_file(&destination);
            fs::rename(&temp, &destination).map_err(|source| {
                let _ = fs::remove_file(&temp);
                DraftError::Io {
                    operation: "replace draft",
                    path: destination.clone(),
                    source,
                }
            })?;
        }
        Ok(Draft {
            path: payload.path,
            content: payload.content,
            base_revision: payload.base_revision,
            saved_at,
        })
    }

    /// Lists readable drafts, newest first. Corrupt or foreign drafts are
    /// skipped so one damaged file cannot block recovery.
    ///
    /// @returns The decrypted drafts.
    /// @throws When the draft folder cannot be listed.
    pub fn list(&self) -> Result<Vec<Draft>, DraftError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(DraftError::Io {
                    operation: "list drafts",
                    path: self.root.clone(),
                    source,
                });
            }
        };
        let mut drafts = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(DRAFT_PREFIX) {
                continue;
            }
            if let Some(draft) = self.read_entry(&entry.path()) {
                drafts.push(draft);
            }
        }
        drafts.sort_by(|a, b| {
            b.saved_at
                .cmp(&a.saved_at)
                .then_with(|| a.path.cmp(&b.path))
        });
        Ok(drafts)
    }

    /// Deletes the draft for a file. A missing draft is not an error.
    ///
    /// @param path - Absolute path of the source file.
    /// @throws When the path is relative or deletion fails.
    pub fn delete(&self, path: &Path) -> Result<(), DraftError> {
        if !path.is_absolute() {
            return Err(DraftError::NotAbsolute);
        }
        let target = self.draft_path(&lexical_normalize(path));
        match fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(DraftError::Io {
                operation: "delete draft",
                path: target,
                source,
            }),
        }
    }

    fn draft_path(&self, path: &Path) -> PathBuf {
        let key = history_path_key(path);
        let digest = Sha1::digest(key.as_bytes());
        self.root
            .join(format!("{DRAFT_PREFIX}{}", hex_lower(&digest)))
    }

    fn write_temp(&self, sealed: &str) -> Result<PathBuf, DraftError> {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|error| DraftError::Io {
            operation: "generate a draft name in",
            path: self.root.clone(),
            source: io::Error::other(error.to_string()),
        })?;
        let temp = self
            .root
            .join(format!(".tmp-{}", hex_lower(&random)));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|source| DraftError::Io {
            operation: "create draft",
            path: temp.clone(),
            source,
        })?;
        let result = file.write_all(sealed.as_bytes()).and_then(|()| file.sync_all());
        drop(file);
        if let Err(source) = result {
            let _ = fs::remove_file(&temp);
            return Err(DraftError::Io {
                operation: "write draft",
                path: temp,
                source,
            });
        }
        Ok(temp)
    }

    fn read_entry(&self, path: &Path) -> Option<Draft> {
        let metadata = fs::symlink_metadata(path).ok()?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_DRAFT_FILE_BYTES {
            return None;
        }
        let file = File::open(path).ok()?;
        let mut bytes = Vec::new();
        file.take(MAX_DRAFT_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_DRAFT_FILE_BYTES {
            return None;
        }
        let stored = String::from_utf8(bytes).ok()?;
        let plaintext = crypto::open(&self.key, &stored).ok()?;
        let payload: Payload = serde_json::from_str(&plaintext).ok()?;
        if payload.content.len() as u64 > crate::MAX_FILE_BYTES
            || !Path::new(&payload.path).is_absolute()
        {
            return None;
        }
        Some(Draft {
            path: payload.path,
            content: payload.content,
            base_revision: payload.base_revision,
            saved_at: payload.saved_at,
        })
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(root: &Path, byte: u8) -> DraftStore {
        DraftStore::new(root.to_path_buf(), HistoryKey::from_bytes([byte; 32]))
    }

    #[test]
    fn saves_lists_replaces_and_deletes_encrypted_drafts() {
        let temp = tempfile::tempdir().unwrap();
        let drafts = store(temp.path(), 7);
        let file = temp.path().join("settings.json");

        let saved = drafts
            .save(&file, "unsaved café\r\ncontent", Some("revision-one"))
            .unwrap();
        assert_eq!(saved.path, file.to_string_lossy());
        assert!(saved.saved_at > 0);
        let names = fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 1);
        assert!(names[0].starts_with(DRAFT_PREFIX));
        let stored = fs::read_to_string(temp.path().join(&names[0])).unwrap();
        assert!(!stored.contains("unsaved"));
        assert!(!stored.contains("revision-one"));

        let listed = drafts.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].content, "unsaved café\r\ncontent");
        assert_eq!(listed[0].base_revision.as_deref(), Some("revision-one"));

        drafts.save(&file, "newer", None).unwrap();
        let listed = drafts.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].content, "newer");
        assert_eq!(listed[0].base_revision, None);

        drafts.delete(&file).unwrap();
        assert!(drafts.list().unwrap().is_empty());
        drafts.delete(&file).unwrap();
    }

    #[test]
    fn recovers_large_json_escaped_draft() {
        let temp = tempfile::tempdir().unwrap();
        let drafts = store(temp.path(), 3);
        let path = temp.path().join("settings.json");
        let content = "\0".repeat(3 * 1024 * 1024);

        drafts.save(&path, &content, None).unwrap();

        let recovered = drafts.list().unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].content, content);
    }

    #[test]
    fn skips_corrupt_foreign_and_oversized_entries() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("draft-corrupt"), "not encrypted").unwrap();
        fs::create_dir(temp.path().join("draft-folder")).unwrap();
        fs::write(temp.path().join("unrelated"), "ignored").unwrap();
        let drafts = store(temp.path(), 1);
        let file = temp.path().join("settings.json");
        drafts.save(&file, "mine", None).unwrap();

        assert_eq!(drafts.list().unwrap().len(), 1);
        assert!(store(temp.path(), 2).list().unwrap().is_empty());
    }

    #[test]
    fn rejects_relative_paths_and_oversized_content() {
        let temp = tempfile::tempdir().unwrap();
        let drafts = store(temp.path(), 3);
        assert!(matches!(
            drafts.save(Path::new("relative.json"), "x", None),
            Err(DraftError::NotAbsolute)
        ));
        let content = "x".repeat(crate::MAX_FILE_BYTES as usize + 1);
        assert!(matches!(
            drafts.save(&temp.path().join("large.json"), &content, None),
            Err(DraftError::TooLarge)
        ));
        assert!(matches!(
            drafts.delete(Path::new("relative.json")),
            Err(DraftError::NotAbsolute)
        ));
    }

    #[test]
    fn draft_files_are_unique_per_path() {
        let temp = tempfile::tempdir().unwrap();
        let drafts = store(temp.path(), 4);
        drafts.save(&temp.path().join("a.json"), "a", None).unwrap();
        drafts.save(&temp.path().join("b.json"), "b", None).unwrap();
        let listed = drafts.list().unwrap();
        assert_eq!(listed.len(), 2);
        assert_ne!(listed[0].path, listed[1].path);
    }
}
