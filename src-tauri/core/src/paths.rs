//! Path cleanup, canonicalization and case-aware comparisons.

use std::{
    ffi::OsString,
    fs, io,
    path::{Component, Path, PathBuf},
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PathError {
    #[error("path must be absolute: {0}")]
    NotAbsolute(PathBuf),
    #[error("cannot resolve {path}: {source}")]
    Resolve { path: PathBuf, source: io::Error },
}

/// Cleans a path lexically without touching the filesystem.
///
/// @param path - The path to clean.
/// @returns The path without `.` segments and with `..` segments resolved.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !out.has_root() {
                    out.push(component.as_os_str());
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// Resolves symlinks and junctions through the nearest existing ancestor and
/// reconstructs the missing tail, so paths that do not exist yet can still be
/// compared against their real location.
///
/// @param path - Absolute path to resolve.
/// @returns The resolved absolute path without a verbatim prefix.
/// @throws When the path is relative, has no existing ancestor, or cannot be
/// resolved.
pub fn canonicalize(path: &Path) -> Result<PathBuf, PathError> {
    if !path.is_absolute() {
        return Err(PathError::NotAbsolute(path.to_path_buf()));
    }
    let mut probe = path.to_path_buf();
    let mut tail: Vec<OsString> = Vec::new();
    loop {
        match fs::symlink_metadata(&probe) {
            Ok(_) => break,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                ) =>
            {
                let (Some(parent), Some(name)) = (probe.parent(), probe.file_name()) else {
                    return Err(PathError::Resolve {
                        path: path.to_path_buf(),
                        source: error,
                    });
                };
                tail.push(name.to_os_string());
                probe = parent.to_path_buf();
            }
            Err(source) => {
                return Err(PathError::Resolve {
                    path: path.to_path_buf(),
                    source,
                });
            }
        }
    }
    let real = fs::canonicalize(&probe).map_err(|source| PathError::Resolve {
        path: probe.clone(),
        source,
    })?;
    let mut resolved = strip_verbatim(real);
    for part in tail.iter().rev() {
        resolved.push(part);
    }
    Ok(lexical_normalize(&resolved))
}

/// Resolves a path when possible and falls back to lexical cleanup.
///
/// @param path - The path to resolve.
/// @returns The resolved path, or its cleaned lexical form.
pub fn canonical_or_lexical(path: &Path) -> PathBuf {
    canonicalize(path).unwrap_or_else(|_| lexical_normalize(path))
}

/// Returns a comparison key for a path. Windows keys are lower-cased because
/// the default filesystems are case-insensitive.
///
/// @param path - The path to key.
/// @returns The normalized comparison key.
pub fn path_key(path: &Path) -> String {
    lower(lexical_normalize(path).to_string_lossy().into_owned())
}

/// Returns a lower-cased path key for history directory names, matching the
/// legacy Electron convention on every platform.
///
/// @param path - The path to key.
/// @returns The normalized lower-cased key.
pub(crate) fn history_path_key(path: &Path) -> String {
    lexical_normalize(path).to_string_lossy().to_lowercase()
}

/// Returns the comparison key of a path's final component.
///
/// @param path - The path to inspect.
/// @returns The file-name key, or `None` when the path has no final component.
pub fn file_name_key(path: &Path) -> Option<String> {
    path.file_name()
        .map(|name| lower(name.to_string_lossy().into_owned()))
}

/// Reports whether metadata describes a symlink or junction. Windows reparse
/// points are treated conservatively, including junctions that
/// `FileType::is_symlink` does not cover on every toolchain.
///
/// @param metadata - Metadata from `symlink_metadata`.
/// @returns True when the entry is a link-like reparse point.
pub fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_type().is_symlink()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

/// Reports whether the leaf entry is a symlink or junction without following it.
///
/// @param path - Absolute path to inspect.
/// @returns True when the leaf itself is a link.
pub fn is_link_like(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata_is_link(&metadata))
}

/// Reports whether `child` is `root` or sits below it, compared component by
/// component so `C:\foo` never matches `C:\foobar`.
///
/// @param child - The candidate path.
/// @param root - The folder root.
/// @returns True when the child is inside the root.
pub fn is_within(child: &Path, root: &Path) -> bool {
    let child = key_components(child);
    let root = key_components(root);
    !root.is_empty() && child.len() >= root.len() && child[..root.len()] == root[..]
}

/// Counts the components of a path for deepest-root selection.
///
/// @param path - The path to count.
/// @returns The number of components.
pub fn component_count(path: &Path) -> usize {
    lexical_normalize(path).components().count()
}

fn key_components(path: &Path) -> Vec<String> {
    lexical_normalize(path)
        .components()
        .map(|component| lower(component.as_os_str().to_string_lossy().into_owned()))
        .collect()
}

fn lower(text: String) -> String {
    #[cfg(windows)]
    {
        text.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text
    }
}

#[cfg(windows)]
pub(crate) fn strip_verbatim(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

#[cfg(not(windows))]
pub(crate) fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_dot_and_parent_segments() {
        #[cfg(windows)]
        {
            assert_eq!(
                lexical_normalize(Path::new(r"C:\a\.\b\..\c")),
                PathBuf::from(r"C:\a\c")
            );
            assert_eq!(
                lexical_normalize(Path::new(r"C:\..\..")),
                PathBuf::from(r"C:\")
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(
                lexical_normalize(Path::new("/a/./b/../c")),
                PathBuf::from("/a/c")
            );
            assert_eq!(lexical_normalize(Path::new("/../..")), PathBuf::from("/"));
        }
        assert_eq!(
            lexical_normalize(Path::new("a/../../b")),
            PathBuf::from("../b")
        );
    }

    #[test]
    fn containment_is_component_wise() {
        let root = tempfile::tempdir().unwrap();
        let inside = root.path().join("child").join("file.json");
        let sibling = root.path().join("childish");
        assert!(is_within(&inside, root.path()));
        assert!(is_within(root.path(), root.path()));
        assert!(!is_within(&sibling, &root.path().join("child")));
    }

    #[test]
    fn canonicalize_reconstructs_missing_tails() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("a").join("b").join("c.json");
        let resolved = canonicalize(&missing).unwrap();
        assert!(is_within(&resolved, root.path()));
        assert_eq!(file_name_key(&resolved).as_deref(), Some("c.json"));
    }

    #[test]
    fn rejects_relative_paths() {
        assert!(matches!(
            canonicalize(Path::new("relative\\file.json")),
            Err(PathError::NotAbsolute(_))
        ));
    }
}
