//! Core library for Maestro 2: detection, settings, safe file access, encrypted
//! history and watching.

pub mod crypto;
pub mod detection;
pub mod files;
pub mod history;
pub mod names;
pub mod paths;
pub mod settings;
pub mod validation;
pub mod watch;

pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub(crate) fn mtime_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
