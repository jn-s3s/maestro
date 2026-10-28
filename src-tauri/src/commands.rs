//! Tauri commands backing the desktop bridge. Every path is validated through
//! the detected registry before it reaches the filesystem.

use std::path::{Path, PathBuf};

use maestro_core::{
    detection::{CustomEntry, Tool},
    files::{DirEntry, FileStat, WriteRequest},
    history::HistoryEntry,
    paths::{canonical_or_lexical, lexical_normalize, path_key},
    settings::{AppSettings, ThemeMode, push_recent as push_recent_entry},
    watch::{WatchMode, watch_path},
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
    shell,
    state::{AppState, new_custom_id},
    tray,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDto {
    exists: bool,
    content: String,
    size: u64,
    mtime: i64,
    revision: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDto {
    created: bool,
    revision: String,
    backup_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatDto {
    size: u64,
    mtime: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    name: String,
    path: String,
    rel: String,
    is_dir: bool,
    mtime: i64,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    exists: bool,
    entries: Vec<DirEntryDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDto {
    file: String,
    path: String,
    mtime: i64,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupsDto {
    entries: Vec<BackupDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsDto {
    tools: Vec<Tool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl OpResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
        }
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn tool_key(path: &Path) -> String {
    path_key(&canonical_or_lexical(path))
}

impl From<DirEntry> for DirEntryDto {
    fn from(entry: DirEntry) -> Self {
        Self {
            name: entry.name,
            path: text(&entry.path),
            rel: entry.rel,
            is_dir: entry.is_dir,
            mtime: entry.mtime_ms,
            size: entry.size,
        }
    }
}

impl From<HistoryEntry> for BackupDto {
    fn from(entry: HistoryEntry) -> Self {
        Self {
            file: entry.file,
            path: text(&entry.path),
            mtime: entry.mtime_ms,
            size: entry.size,
        }
    }
}

fn stat_dto(stat: FileStat) -> StatDto {
    StatDto {
        size: stat.size,
        mtime: stat.mtime_ms,
    }
}

#[tauri::command]
pub fn list_tools(state: State<'_, AppState>) -> ToolsDto {
    let mut inner = state.lock_inner();
    state.refresh_tools(&mut inner);
    ToolsDto {
        tools: inner.tools.clone(),
    }
}

#[tauri::command]
pub fn read_file(state: State<'_, AppState>, path: String) -> Result<ReadDto, String> {
    let inner = state.lock_inner();
    let result = inner
        .files
        .read_file(Path::new(&path))
        .map_err(|error| error.to_string())?;
    Ok(ReadDto {
        exists: result.exists,
        content: result.content,
        size: result.size,
        mtime: result.mtime_ms,
        revision: result.revision.map(|revision| revision.as_str().to_owned()),
    })
}

#[tauri::command]
pub fn write_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<WriteDto, String> {
    let inner = state.lock_inner();
    let expected = expected_revision
        .as_deref()
        .filter(|revision| !revision.is_empty());
    let result = inner
        .files
        .write_file(
            Path::new(&path),
            WriteRequest {
                content: &content,
                expected_revision: expected,
            },
        )
        .map_err(|error| error.to_string())?;
    Ok(WriteDto {
        created: result.created,
        revision: result.revision.as_str().to_owned(),
        backup_path: result.backup.map(|path| text(&path)),
    })
}

#[tauri::command]
pub fn file_stat(state: State<'_, AppState>, path: String) -> Result<Option<StatDto>, String> {
    let inner = state.lock_inner();
    let canonical = inner
        .files
        .registry()
        .resolve_file(Path::new(&path))
        .map_err(|error| error.to_string())?;
    inner
        .files
        .stat_file(&canonical)
        .map(|stat| stat.map(stat_dto))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn reveal_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let canonical = {
        let inner = state.lock_inner();
        inner
            .files
            .registry()
            .resolve_reveal(Path::new(&path))
            .map_err(|error| error.to_string())?
    };
    shell::reveal_path(&canonical)
}

#[tauri::command]
pub fn open_file(state: State<'_, AppState>, path: String) -> OpResult {
    let canonical = {
        let inner = state.lock_inner();
        inner.files.registry().resolve_file(Path::new(&path))
    };
    match canonical {
        Err(error) => OpResult::error(error.to_string()),
        Ok(canonical) if !canonical.exists() => OpResult::error("File does not exist yet"),
        Ok(canonical) => match shell::open_path(&canonical) {
            Ok(()) => OpResult::ok(),
            Err(error) => OpResult::error(error),
        },
    }
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    shell::open_external(&url)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.lock_inner().settings.clone()
}

#[tauri::command]
pub fn set_hidden(
    state: State<'_, AppState>,
    tool_ids: Vec<String>,
) -> Result<AppSettings, String> {
    let mut inner = state.lock_inner();
    let mut settings = inner.settings.clone();
    settings.hidden_tools = tool_ids;
    state.save_settings(&mut inner, settings)
}

#[tauri::command]
pub fn set_theme(
    state: State<'_, AppState>,
    window: WebviewWindow,
    mode: String,
) -> Result<AppSettings, String> {
    let theme = match mode.as_str() {
        "system" => ThemeMode::System,
        "light" => ThemeMode::Light,
        "dark" => ThemeMode::Dark,
        _ => return Ok(state.lock_inner().settings.clone()),
    };
    let mut inner = state.lock_inner();
    let mut settings = inner.settings.clone();
    settings.theme = theme;
    let saved = state.save_settings(&mut inner, settings)?;
    let native = match theme {
        ThemeMode::System => None,
        ThemeMode::Light => Some(tauri::Theme::Light),
        ThemeMode::Dark => Some(tauri::Theme::Dark),
    };
    if let Err(error) = window.set_theme(native) {
        state.log("theme", &format!("apply window theme: {error}"));
    }
    Ok(saved)
}

#[tauri::command]
pub fn set_close_to_tray(state: State<'_, AppState>, value: bool) -> Result<AppSettings, String> {
    let mut inner = state.lock_inner();
    let mut settings = inner.settings.clone();
    settings.close_to_tray = value;
    state.save_settings(&mut inner, settings)
}

#[tauri::command]
pub fn set_soft_wrap(state: State<'_, AppState>, value: bool) -> Result<AppSettings, String> {
    let mut inner = state.lock_inner();
    let mut settings = inner.settings.clone();
    settings.soft_wrap = value;
    state.save_settings(&mut inner, settings)
}

#[tauri::command]
pub fn add_custom(state: State<'_, AppState>, name: String, path: String) -> OpResult {
    match add_custom_inner(&state, &name, &path) {
        Ok(()) => OpResult::ok(),
        Err(error) => OpResult::error(error),
    }
}

fn add_custom_inner(state: &AppState, name: &str, raw_path: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name is required".to_owned());
    }
    if name.chars().count() > 80 {
        return Err("Name must be 80 characters or fewer".to_owned());
    }
    if name.chars().any(char::is_control) {
        return Err("Name cannot contain control characters".to_owned());
    }
    let raw_path = raw_path.trim();
    if raw_path.is_empty() {
        return Err("Path is required".to_owned());
    }
    let candidate = lexical_normalize(Path::new(raw_path));
    if !candidate.is_absolute() {
        return Err("Path must be absolute (e.g. C:\\Users\\...)".to_owned());
    }
    let key = tool_key(&candidate);
    let mut inner = state.lock_inner();
    if inner
        .settings
        .custom
        .iter()
        .any(|entry| tool_key(&entry.path) == key)
    {
        return Err("This path is already registered".to_owned());
    }
    let duplicate = inner.tools.iter().any(|tool| {
        tool.files.iter().any(|file| tool_key(&file.path) == key)
            || tool
                .folders
                .iter()
                .any(|folder| tool_key(&folder.path) == key)
    });
    if duplicate {
        return Err("This path is already registered".to_owned());
    }
    let mut settings = inner.settings.clone();
    settings.custom.push(CustomEntry {
        id: new_custom_id(&settings.custom),
        name: name.to_owned(),
        path: candidate,
    });
    state.save_settings(&mut inner, settings)?;
    state.refresh_tools(&mut inner);
    Ok(())
}

#[tauri::command]
pub fn remove_custom(state: State<'_, AppState>, id: String) -> Result<AppSettings, String> {
    let mut inner = state.lock_inner();
    let mut settings = inner.settings.clone();
    settings.custom.retain(|entry| entry.id != id);
    settings.hidden_tools.retain(|hidden| hidden != &id);
    let saved = state.save_settings(&mut inner, settings)?;
    state.refresh_tools(&mut inner);
    Ok(saved)
}

#[tauri::command]
pub fn push_recent(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let mut inner = state.lock_inner();
    inner
        .files
        .registry()
        .resolve_file(Path::new(&path))
        .map_err(|error| error.to_string())?;
    let logical = lexical_normalize(Path::new(&path));
    let mut settings = inner.settings.clone();
    settings.recent_files = push_recent_entry(&settings.recent_files, &text(&logical));
    state.save_settings(&mut inner, settings)?;
    drop(inner);
    if let Err(error) = tray::update(&app) {
        state.log("tray", &error);
    }
    Ok(())
}

#[tauri::command]
pub fn list_backups(state: State<'_, AppState>, file_path: String) -> Result<BackupsDto, String> {
    let inner = state.lock_inner();
    let canonical = inner
        .files
        .registry()
        .resolve_file(Path::new(&file_path))
        .map_err(|error| error.to_string())?;
    let entries = inner
        .files
        .history()
        .list(&canonical)
        .map_err(|error| error.to_string())?;
    Ok(BackupsDto {
        entries: entries.into_iter().map(BackupDto::from).collect(),
    })
}

#[tauri::command]
pub fn read_backup(state: State<'_, AppState>, backup_path: String) -> Result<String, String> {
    let inner = state.lock_inner();
    inner
        .files
        .history()
        .read_path(Path::new(&backup_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_backup(state: State<'_, AppState>, backup_path: String) -> Result<OpResult, String> {
    let inner = state.lock_inner();
    inner
        .files
        .history()
        .delete_path(Path::new(&backup_path))
        .map(|()| OpResult::ok())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_backups(state: State<'_, AppState>, file_path: String) -> Result<OpResult, String> {
    let inner = state.lock_inner();
    let canonical = inner
        .files
        .registry()
        .resolve_file(Path::new(&file_path))
        .map_err(|error| error.to_string())?;
    inner
        .files
        .history()
        .clear(&canonical)
        .map(|()| OpResult::ok())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn watch_file(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let (target, logical_target) = {
        let inner = state.lock_inner();
        let target = inner
            .files
            .registry()
            .resolve_file(Path::new(&path))
            .map_err(|error| error.to_string())?;
        (target, lexical_normalize(Path::new(&path)))
    };
    start_watch(&app, &state, target, logical_target, WatchMode::File)
}

#[tauri::command]
pub fn watch_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    folder_path: String,
) -> Result<(), String> {
    let (target, logical_target) = {
        let inner = state.lock_inner();
        let target = inner
            .files
            .registry()
            .resolve_folder(Path::new(&folder_path))
            .map_err(|error| error.to_string())?;
        (target, lexical_normalize(Path::new(&folder_path)))
    };
    start_watch(&app, &state, target, logical_target, WatchMode::Folder)
}

fn start_watch(
    app: &AppHandle,
    state: &AppState,
    target: PathBuf,
    logical_target: PathBuf,
    mode: WatchMode,
) -> Result<(), String> {
    let emitter = app.clone();
    let label = target.clone();
    let event_path = text(&logical_target);
    let handle = watch_path(
        &target,
        mode,
        state.self_writes().clone(),
        move |event| match event {
            Ok(_) => {
                if let Err(error) = emitter.emit("fs-changed", event_path.clone()) {
                    eprintln!("emit fs-changed: {error}");
                }
            }
            Err(error) => eprintln!("watch {}: {error}", label.display()),
        },
    )
    .map_err(|error| error.to_string())?;
    *state.lock_watch() = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn list_folder(state: State<'_, AppState>, folder_path: String) -> Result<FolderDto, String> {
    let inner = state.lock_inner();
    let listing = inner
        .files
        .list_folder(Path::new(&folder_path))
        .map_err(|error| error.to_string())?;
    Ok(FolderDto {
        exists: listing.exists,
        entries: listing.entries.into_iter().map(DirEntryDto::from).collect(),
    })
}

#[tauri::command]
pub fn create_file_in(
    state: State<'_, AppState>,
    folder_path: String,
    name: String,
) -> Result<OpResult, String> {
    let mut inner = state.lock_inner();
    match inner.files.create_file_in(Path::new(&folder_path), &name) {
        Ok(_) => {
            state.refresh_tools(&mut inner);
            Ok(OpResult::ok())
        }
        Err(error) => Ok(OpResult::error(error.to_string())),
    }
}

#[tauri::command]
pub fn create_folder_in(
    state: State<'_, AppState>,
    folder_path: String,
    name: String,
) -> Result<OpResult, String> {
    let mut inner = state.lock_inner();
    match inner.files.create_folder_in(Path::new(&folder_path), &name) {
        Ok(_) => {
            state.refresh_tools(&mut inner);
            Ok(OpResult::ok())
        }
        Err(error) => Ok(OpResult::error(error.to_string())),
    }
}

#[tauri::command]
pub fn rename_file(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<OpResult, String> {
    let mut inner = state.lock_inner();
    match inner.files.rename_file(Path::new(&path), &new_name) {
        Ok(_) => {
            state.refresh_tools(&mut inner);
            Ok(OpResult::ok())
        }
        Err(error) => Ok(OpResult::error(error.to_string())),
    }
}

#[tauri::command]
pub fn rename_folder(
    state: State<'_, AppState>,
    folder_path: String,
    new_name: String,
) -> Result<OpResult, String> {
    let mut inner = state.lock_inner();
    match inner
        .files
        .rename_folder(Path::new(&folder_path), &new_name)
    {
        Ok(_) => {
            state.refresh_tools(&mut inner);
            Ok(OpResult::ok())
        }
        Err(error) => Ok(OpResult::error(error.to_string())),
    }
}

#[tauri::command]
pub fn delete_file(state: State<'_, AppState>, path: String) -> Result<OpResult, String> {
    let mut inner = state.lock_inner();
    let target = match inner.files.delete_file_target(Path::new(&path)) {
        Ok(target) => target,
        Err(error) => return Ok(OpResult::error(error.to_string())),
    };
    match shell::trash_path(&target) {
        Ok(()) => {
            state.refresh_tools(&mut inner);
            Ok(OpResult::ok())
        }
        Err(error) => Ok(OpResult::error(error)),
    }
}

#[tauri::command]
pub fn delete_folder(state: State<'_, AppState>, folder_path: String) -> Result<OpResult, String> {
    let mut inner = state.lock_inner();
    let target = match inner.files.delete_folder_target(Path::new(&folder_path)) {
        Ok(target) => target,
        Err(error) => return Ok(OpResult::error(error.to_string())),
    };
    match shell::trash_path(&target) {
        Ok(()) => {
            state.refresh_tools(&mut inner);
            Ok(OpResult::ok())
        }
        Err(error) => Ok(OpResult::error(error)),
    }
}
