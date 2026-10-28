//! Windows-safe entry name validation shared by history and folder operations.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NameError {
    #[error("name is empty or a relative path segment")]
    Empty,
    #[error("name contains a character Windows does not allow")]
    ForbiddenCharacter,
    #[error("name is reserved by Windows")]
    Reserved,
    #[error("name cannot start with a dot")]
    LeadingDot,
    #[error("name cannot end with a dot or space")]
    TrailingDotOrSpace,
}

/// Validates a new file or folder name and returns it without surrounding
/// whitespace.
///
/// @param raw - The untrusted name to validate.
/// @returns The trimmed name when it is safe to create on Windows.
/// @throws When the name is empty, uses a forbidden character, is reserved by
/// Windows, or starts or ends with a character Explorer rejects.
pub fn validate_new_name(raw: &str) -> Result<&str, NameError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(NameError::Empty);
    }
    if trimmed.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    }) {
        return Err(NameError::ForbiddenCharacter);
    }
    if trimmed.starts_with('.') {
        return Err(NameError::LeadingDot);
    }
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return Err(NameError::TrailingDotOrSpace);
    }
    if is_reserved_device_name(trimmed) {
        return Err(NameError::Reserved);
    }
    Ok(trimmed)
}

/// Rejects DOS device names, which Windows resolves even inside a folder.
///
/// @param name - The entry name to inspect.
/// @returns True when the stem names a reserved device.
pub(crate) fn is_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let stem = stem.to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_names() {
        for name in ["settings.json", "my-file.md", "a b.txt", "notes_1"] {
            assert_eq!(validate_new_name(name).unwrap(), name);
        }
        assert_eq!(validate_new_name("  padded.md  ").unwrap(), "padded.md");
    }

    #[test]
    fn rejects_unsafe_names() {
        let cases = [
            ("", NameError::Empty),
            ("   ", NameError::Empty),
            (".", NameError::Empty),
            ("..", NameError::Empty),
            ("a/b", NameError::ForbiddenCharacter),
            ("a\\b", NameError::ForbiddenCharacter),
            ("a:b", NameError::ForbiddenCharacter),
            ("a*b", NameError::ForbiddenCharacter),
            ("a?b", NameError::ForbiddenCharacter),
            ("a\"b", NameError::ForbiddenCharacter),
            ("a<b", NameError::ForbiddenCharacter),
            ("a>b", NameError::ForbiddenCharacter),
            ("a|b", NameError::ForbiddenCharacter),
            ("tab\there", NameError::ForbiddenCharacter),
            (".env", NameError::LeadingDot),
            ("trailing.", NameError::TrailingDotOrSpace),
            ("CON", NameError::Reserved),
            ("nul.json", NameError::Reserved),
            ("COM7.txt", NameError::Reserved),
            ("lpt9", NameError::Reserved),
        ];
        for (name, expected) in cases {
            assert_eq!(validate_new_name(name), Err(expected), "{name:?}");
        }
    }

    #[test]
    fn device_names_are_case_insensitive() {
        assert!(is_reserved_device_name("con"));
        assert!(is_reserved_device_name("Aux.txt"));
        assert!(!is_reserved_device_name("console.txt"));
        assert!(!is_reserved_device_name("com0"));
    }
}
