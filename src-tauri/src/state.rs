//! Application state: settings, the detected tool registry, encrypted history,
//! the active watcher and the log file.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use maestro_core::{
    crypto::HistoryKey,
    detection::{CustomEntry, DetectionEnv, Tool, detect_tools},
    files::{FileStore, Registry},
    history::HistoryStore,
    paths::lexical_normalize,
    settings::{AppSettings, SettingsStore},
    watch::{SelfWriteRegistry, WatchHandle},
};
use tauri::Manager;

pub const DATA_ROOT_OVERRIDE: &str = "MAESTRO_DATA_ROOT";
const LOG_LIMIT_BYTES: u64 = 512 * 1024;

pub struct Inner {
    pub settings: AppSettings,
    pub settings_store: SettingsStore,
    pub tools: Vec<Tool>,
    pub files: FileStore,
}

/// Shared desktop state. Every filesystem command holds the inner lock for the
/// duration of its work so a settings change cannot swap the registry beneath
/// an in-flight operation.
pub struct AppState {
    pub data_root: PathBuf,
    key: HistoryKey,
    self_writes: Arc<SelfWriteRegistry>,
    inner: Mutex<Inner>,
    watch: Mutex<Option<WatchHandle>>,
}

impl AppState {
    /// Creates the state for a data root, generating the history key on first
    /// launch.
    ///
    /// @param data_root - Folder that owns settings, history and logs.
    /// @returns The initialized state.
    /// @throws When the data root or the encryption key cannot be prepared.
    pub fn new(data_root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&data_root)
            .map_err(|error| format!("Create data folder {}: {error}", data_root.display()))?;
        let key = HistoryKey::load_or_create(&data_root)
            .map_err(|error| format!("Prepare encrypted history: {error}"))?;
        let settings_store = SettingsStore::new(data_root.join("settings.json"));
        let settings = settings_store.load();
        let self_writes = Arc::new(SelfWriteRegistry::new());
        let tools = detect_tools(&detection_env(), &settings.custom);
        let files = FileStore::new(
            Registry::new(tools.clone()),
            HistoryStore::new(data_root.join("backups"), key.clone()),
            Arc::clone(&self_writes),
        );
        Ok(Self {
            data_root,
            key,
            self_writes,
            inner: Mutex::new(Inner {
                settings,
                settings_store,
                tools,
                files,
            }),
            watch: Mutex::new(None),
        })
    }

    /// Resolves the data root. `MAESTRO_DATA_ROOT` isolates desktop checks
    /// without touching the installed app's data.
    ///
    /// @param app - The running application handle.
    /// @returns The absolute data root.
    /// @throws When the platform app-data folder cannot be resolved.
    pub fn resolve_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        if let Some(value) = override_path(DATA_ROOT_OVERRIDE) {
            return Ok(value);
        }
        app.path()
            .app_data_dir()
            .map_err(|error| format!("Resolve the app data folder: {error}"))
    }

    /// Locks the mutable inner state, recovering from a poisoned lock so one
    /// failed command cannot brick the whole desktop session.
    pub fn lock_inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Locks the active watcher slot.
    pub fn lock_watch(&self) -> MutexGuard<'_, Option<WatchHandle>> {
        self.watch.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Returns the shared self-write registry.
    pub fn self_writes(&self) -> &Arc<SelfWriteRegistry> {
        &self.self_writes
    }

    /// Doubles as the log location for the desktop shell.
    pub fn log(&self, scope: &str, detail: &str) {
        log_error(&self.data_root, scope, detail);
    }

    /// Re-detects tools and rebuilds the file store after a settings change or
    /// a filesystem mutation that can add or remove registered entries.
    pub fn refresh_tools(&self, inner: &mut Inner) {
        let tools = detect_tools(&detection_env(), &inner.settings.custom);
        inner.files = FileStore::new(
            Registry::new(tools.clone()),
            HistoryStore::new(self.data_root.join("backups"), self.key.clone()),
            Arc::clone(&self.self_writes),
        );
        inner.tools = tools;
    }

    /// Persists settings and applies them to the in-memory state.
    ///
    /// @param inner - The locked inner state.
    /// @param settings - The settings to persist.
    /// @returns The saved settings.
    /// @throws When the settings file cannot be written.
    pub fn save_settings(
        &self,
        inner: &mut Inner,
        settings: AppSettings,
    ) -> Result<AppSettings, String> {
        inner
            .settings_store
            .save(&settings)
            .map_err(|error| error.to_string())?;
        inner.settings = settings.clone();
        Ok(settings)
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Ok(mut watch) = self.watch.lock() {
            watch.take();
        }
    }
}

fn override_path(name: &str) -> Option<PathBuf> {
    let value = std::env::var_os(name)?;
    let text = value.to_string_lossy();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(lexical_normalize(Path::new(trimmed)))
    }
}

/// Builds the detection environment. The `MAESTRO_*` overrides let packaged
/// checks redirect detection while WebView2 keeps its real profile.
fn detection_env() -> DetectionEnv {
    let mut env = DetectionEnv::from_process();
    if let Some(home) = override_path("MAESTRO_HOME") {
        env.home = home;
    }
    if let Some(appdata) = override_path("MAESTRO_APPDATA") {
        env.appdata = appdata;
    }
    if let Some(local_appdata) = override_path("MAESTRO_LOCALAPPDATA") {
        env.local_appdata = local_appdata;
    }
    env
}

/// Appends a timestamped line to the rotating desktop log. A failure is
/// mirrored to stderr so it is never silently dropped.
///
/// @param data_root - Folder that owns the log directory.
/// @param scope - Short label for the error origin.
/// @param detail - Human-readable description with no configuration contents.
pub fn log_error(data_root: &Path, scope: &str, detail: &str) {
    let logs = data_root.join("logs");
    let file = logs.join("main.log");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let line = format!("[{stamp}] {scope}: {detail}\n");
    let result = (|| -> std::io::Result<()> {
        fs::create_dir_all(&logs)?;
        if fs::metadata(&file).is_ok_and(|metadata| metadata.len() > LOG_LIMIT_BYTES) {
            let _ = fs::remove_file(logs.join("main.log.old"));
            let _ = fs::rename(&file, logs.join("main.log.old"));
        }
        let mut handle = OpenOptions::new().create(true).append(true).open(&file)?;
        handle.write_all(line.as_bytes())
    })();
    if let Err(error) = result {
        eprintln!("log fallback for {scope}: {detail} ({error})");
    }
}

/// Builds a custom entry identifier without pulling in a UUID dependency.
///
/// @param existing - Current custom entries, used to avoid a collision.
/// @returns An identifier that is not present in `existing`.
pub fn new_custom_id(existing: &[CustomEntry]) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    for attempt in 0..1000u32 {
        let candidate = format!("custom-{stamp:x}-{attempt}");
        if !existing.iter().any(|entry| entry.id == candidate) {
            return candidate;
        }
    }
    format!("custom-{stamp:x}-overflow")
}
