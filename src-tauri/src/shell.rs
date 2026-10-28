//! Native shell integration: opening files, revealing them in Explorer,
//! launching validated external URLs and sending entries to the Recycle Bin.

use std::path::Path;

/// Opens a file or folder with its default handler.
///
/// @param path - Absolute path to open.
/// @throws When the shell cannot launch the handler.
pub fn open_path(path: &Path) -> Result<(), String> {
    execute("open", path.as_os_str(), None)
}

/// Reveals a file in Explorer, or opens its parent folder when the leaf is
/// missing.
///
/// @param path - Absolute path to reveal.
/// @throws When the shell cannot open Explorer.
pub fn reveal_path(path: &Path) -> Result<(), String> {
    if path.exists() {
        let mut parameters = std::ffi::OsString::from("/select,\"");
        parameters.push(path.as_os_str());
        parameters.push("\"");
        return execute(
            "open",
            std::ffi::OsStr::new("explorer.exe"),
            Some(&parameters),
        );
    }
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => open_path(parent),
        _ => Err(format!("Cannot reveal {}", path.display())),
    }
}

/// Opens an http, https or mailto URL in the default handler.
///
/// @param url - The URL requested by rendered Markdown.
/// @throws When the scheme is not allowed or the shell cannot launch it.
pub fn open_external(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err("Unsupported URL scheme".to_owned());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("Invalid URL".to_owned());
    }
    execute("open", std::ffi::OsStr::new(trimmed), None)
}

/// Sends a file or folder to the Recycle Bin.
///
/// @param path - Absolute path to recycle.
/// @throws When the Recycle Bin operation fails.
pub fn trash_path(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|error| format!("Move to the Recycle Bin: {error}"))
}

#[cfg(windows)]
fn execute(
    verb: &str,
    file: &std::ffi::OsStr,
    parameters: Option<&std::ffi::OsStr>,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let verb = wide(std::ffi::OsStr::new(verb));
    let file = wide(file);
    let parameters = parameters.map(wide);
    // SAFETY: every pointer is either null or a nul-terminated buffer that
    // outlives the call; the window handle and directory are intentionally null.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            parameters
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    if result <= 32 {
        Err(format!(
            "ShellExecute failed with code {result} for {}",
            String::from_utf16_lossy(&file[..file.len().saturating_sub(1)])
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn execute(
    _verb: &str,
    file: &std::ffi::OsStr,
    _parameters: Option<&std::ffi::OsStr>,
) -> Result<(), String> {
    Err(format!(
        "Shell integration is only implemented on Windows: {}",
        file.to_string_lossy()
    ))
}
