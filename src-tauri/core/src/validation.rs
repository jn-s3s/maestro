//! Pre-save syntax checks for JSON and JSONC configuration files.

use std::path::Path;

use thiserror::Error;

use crate::detection::{FileLang, lang_from_path};

pub const MAX_NESTING_DEPTH: usize = 10_000;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ContentError {
    #[error("Content has excessive nesting")]
    ExcessiveNesting,
    #[error("Invalid JSON. Fix syntax before saving ({0})")]
    InvalidJson(String),
    #[error("Invalid JSONC. Fix syntax before saving ({0})")]
    InvalidJsonc(String),
}

/// Validates editor content before it replaces a configuration file.
///
/// JSON and JSONC files must parse after comments and trailing commas are
/// removed. Every file is first checked for pathological bracket nesting so a
/// malformed document is rejected before the parser allocates deeply. Other
/// languages are stored as written.
///
/// @param path - Destination path, used to infer the language.
/// @param content - The proposed file contents.
/// @throws When the document is too deeply nested or JSON/JSONC parsing fails.
pub fn validate_content(path: &Path, content: &str) -> Result<(), ContentError> {
    if has_excessive_nesting(content) {
        return Err(ContentError::ExcessiveNesting);
    }
    match lang_from_path(path) {
        FileLang::Json => parse_json(content).map_err(|error| {
            ContentError::InvalidJson(format!("line {}, column {}", error.line(), error.column()))
        })?,
        FileLang::Jsonc => {
            let prepared = strip_trailing_commas(&strip_json_comments(content));
            parse_json(&prepared).map_err(|error| {
                ContentError::InvalidJsonc(format!(
                    "line {}, column {}",
                    error.line(),
                    error.column()
                ))
            })?;
        }
        _ => {}
    }
    Ok(())
}

fn parse_json(text: &str) -> Result<(), serde_json::Error> {
    serde_json::from_str::<serde_json::Value>(text).map(|_| ())
}

/// Counts opening brackets without tracking strings, matching the legacy
/// guard that runs before any parser sees the document.
fn has_excessive_nesting(content: &str) -> bool {
    let mut depth = 0usize;
    let mut max_depth = 0usize;
    for byte in content.bytes() {
        if matches!(byte, b'{' | b'[') {
            depth += 1;
            max_depth = max_depth.max(depth);
        } else if matches!(byte, b'}' | b']') {
            depth = depth.saturating_sub(1);
        }
    }
    max_depth > MAX_NESTING_DEPTH
}

/// Removes line and block comments from JSONC source while preserving string
/// contents.
///
/// @param src - The raw JSONC source.
/// @returns The source with comments removed.
pub fn strip_json_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            out.push(byte);
            if byte == b'\\' {
                if let Some(next) = bytes.get(index + 1) {
                    out.push(*next);
                    index += 2;
                } else {
                    index += 1;
                }
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            out.push(byte);
            index += 1;
            continue;
        }
        if byte == b'/' {
            match bytes.get(index + 1) {
                Some(b'/') => {
                    index += 2;
                    while index < bytes.len() && bytes[index] != b'\n' {
                        index += 1;
                    }
                }
                Some(b'*') => {
                    let comment_start = index;
                    index += 2;
                    while index + 1 < bytes.len()
                        && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                    {
                        index += 1;
                    }
                    if index + 1 >= bytes.len() {
                        out.extend_from_slice(&bytes[comment_start..]);
                        index = bytes.len();
                    } else {
                        for byte in &bytes[comment_start..index + 2] {
                            out.push(if matches!(byte, b'\n' | b'\r') {
                                *byte
                            } else {
                                b' '
                            });
                        }
                        index += 2;
                    }
                }
                _ => {
                    out.push(byte);
                    index += 1;
                }
            }
            continue;
        }
        out.push(byte);
        index += 1;
    }
    String::from_utf8(out).expect("stripping ASCII comments keeps UTF-8 valid")
}

/// Removes trailing commas that precede a closing brace or bracket.
///
/// @param src - The raw source text.
/// @returns The source with trailing commas removed.
pub fn strip_trailing_commas(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            out.push(byte);
            if byte == b'\\' {
                if let Some(next) = bytes.get(index + 1) {
                    out.push(*next);
                    index += 2;
                } else {
                    index += 1;
                }
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            out.push(byte);
            index += 1;
            continue;
        }
        if byte == b',' {
            let mut next = index + 1;
            while next < bytes.len() && matches!(bytes[next], b' ' | b'\t' | b'\n' | b'\r') {
                next += 1;
            }
            if next < bytes.len() && matches!(bytes[next], b'}' | b']') {
                index += 1;
                continue;
            }
        }
        out.push(byte);
        index += 1;
    }
    String::from_utf8(out).expect("removing ASCII commas keeps UTF-8 valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn validate(name: &str, content: &str) -> Result<(), ContentError> {
        validate_content(&PathBuf::from(name), content)
    }

    #[test]
    fn accepts_plain_and_commented_json() {
        validate("settings.json", r#"{"a": 1, "b": [true, null]}"#).unwrap();
        validate(
            "settings.jsonc",
            "{\n  // comment\n  \"a\": 1, /* block */\n  \"b\": [2,],\n}\n",
        )
        .unwrap();
        validate("config.yaml", "not: json").unwrap();
        validate(".env", "KEY=value").unwrap();
        validate("notes.md", "{").unwrap();
    }

    #[test]
    fn rejects_invalid_json_and_jsonc() {
        assert!(matches!(
            validate("settings.json", "{"),
            Err(ContentError::InvalidJson(_))
        ));
        assert!(matches!(
            validate("settings.jsonc", "{ \"a\": }"),
            Err(ContentError::InvalidJsonc(_))
        ));
        for malformed in [r#"{"a":1} /* unterminated"#, r#"{"a":1/*comment*/2}"#] {
            assert!(matches!(
                validate("settings.jsonc", malformed),
                Err(ContentError::InvalidJsonc(_))
            ));
        }
    }

    #[test]
    fn comments_and_commas_inside_strings_are_preserved() {
        let source =
            r#"{"url": "https://example.com//x", "glob": "/* not a comment */", "list": "a,]"}"#;
        assert_eq!(strip_json_comments(source), source);
        assert_eq!(strip_trailing_commas(source), source);
        validate("config.jsonc", source).unwrap();
    }

    #[test]
    fn strips_comments_and_trailing_commas() {
        let stripped =
            strip_json_comments("{\n// line\n\"a\": \"//keep\", /* block */ \"b\": 1\n}");
        assert!(!stripped.contains("// line"));
        assert!(!stripped.contains("/* block */"));
        assert!(stripped.contains("\"//keep\""));

        assert_eq!(strip_trailing_commas("[1, 2, ] // c"), "[1, 2 ] // c");
        assert_eq!(strip_trailing_commas("{\"a\": [1,],}"), "{\"a\": [1]}");
    }

    #[test]
    fn rejects_excessive_nesting() {
        let depth = MAX_NESTING_DEPTH + 1;
        let content = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        assert!(matches!(
            validate("data.json", &content),
            Err(ContentError::ExcessiveNesting)
        ));
        let allowed = format!("{}{}", "[".repeat(64), "]".repeat(64));
        validate("data.json", &allowed).unwrap();
    }

    #[test]
    fn reports_a_position_for_syntax_errors() {
        let error = validate("settings.json", "{\n  \"a\": 1,\n}").unwrap_err();
        assert!(error.to_string().contains("line "), "{error}");
    }
}
