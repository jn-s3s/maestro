//! Case-insensitive search across registered configuration files.
//!
//! Search never touches secret-bearing or dotenv files, so tokens and API keys
//! stay out of result previews and the UI.

use std::collections::HashSet;

use serde::Serialize;

use crate::{
    detection::FileLang,
    files::FileStore,
    paths::{canonical_or_lexical, path_key},
};

pub const MAX_QUERY_CHARS: usize = 100;
pub const MAX_RESULTS: usize = 100;
pub const MAX_HITS_PER_FILE: usize = 5;
pub const MAX_PREVIEW_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: std::path::PathBuf,
    pub label: String,
    pub line: u32,
    pub preview: String,
}

/// Searches every registered, non-sensitive config file for a substring.
///
/// The query is trimmed and compared case-insensitively. Files that are
/// missing, unreadable, larger than the read limit or not valid UTF-8 are
/// skipped instead of failing the whole search.
///
/// @param store - The file store whose registry defines the search scope.
/// @param query - The text to find, at least two characters after trimming.
/// @param limit - Maximum number of hits, clamped to [`MAX_RESULTS`].
/// @returns Matching lines ordered by tool and file, at most five per file.
pub fn search_files(store: &FileStore, query: &str, limit: usize) -> Vec<SearchHit> {
    search_files_excluding(store, query, limit, &HashSet::new())
}

/// Searches registered files while excluding paths owned by hidden tools.
pub fn search_files_excluding(
    store: &FileStore,
    query: &str,
    limit: usize,
    excluded_paths: &HashSet<String>,
) -> Vec<SearchHit> {
    let needle: String = query.trim().chars().take(MAX_QUERY_CHARS).collect();
    if needle.chars().count() < 2 {
        return Vec::new();
    }
    let needle = needle.to_lowercase();
    let limit = limit.clamp(1, MAX_RESULTS);
    let mut seen = HashSet::new();
    let mut hits = Vec::new();
    for file in store.registry().tools().iter().flat_map(|tool| &tool.files) {
        if hits.len() >= limit {
            break;
        }
        if file.secret
            || store.registry().is_secret_file(&file.path)
            || matches!(file.lang, FileLang::Dotenv)
            || is_sensitive_mcp_name(&file.path)
            || excluded_paths.contains(&path_key(&canonical_or_lexical(&file.path)))
        {
            continue;
        }
        let key = path_key(&canonical_or_lexical(&file.path));
        if !seen.insert(key) {
            continue;
        }
        let Ok(result) = store.read_file(&file.path) else {
            continue;
        };
        if !result.exists {
            continue;
        }
        let mut per_file = 0usize;
        for (index, line) in result.content.lines().enumerate() {
            if !line.to_lowercase().contains(&needle) {
                continue;
            }
            hits.push(SearchHit {
                path: file.path.clone(),
                label: file.label.clone(),
                line: u32::try_from(index + 1).unwrap_or(u32::MAX),
                preview: preview(line),
            });
            per_file += 1;
            if per_file >= MAX_HITS_PER_FILE || hits.len() >= limit {
                break;
            }
        }
    }
    hits
}

fn is_sensitive_mcp_name(path: &std::path::Path) -> bool {
    matches!(
        path.file_name()
            .and_then(std::ffi::OsStr::to_str)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(".mcp.json" | "cline_mcp_settings.json" | "mcp_settings.json")
    )
}

fn preview(line: &str) -> String {
    let cleaned: String = line
        .chars()
        .map(|character| {
            if character.is_control() && character != '\t' {
                ' '
            } else {
                character
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= MAX_PREVIEW_CHARS {
        return trimmed.to_owned();
    }
    let mut short: String = trimmed.chars().take(MAX_PREVIEW_CHARS).collect();
    short.push_str("...");
    short
}
