//! Filesystem watching with debounce and self-write suppression.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{RecvTimeoutError, channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use notify::{EventKind, RecursiveMode, Watcher as NotifyWatcher, recommended_watcher};
use thiserror::Error;

use crate::paths::{file_name_key, is_within, lexical_normalize, path_key};

pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(250);
pub const SELF_WRITE_WINDOW: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchMode {
    File,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchEvent {
    /// The watched file or folder.
    pub target: PathBuf,
    /// The concrete path the operating system reported.
    pub changed: PathBuf,
}

#[derive(Debug, Error)]
pub enum WatchError {
    #[error("watch target has no parent folder: {0}")]
    InvalidTarget(PathBuf),
    #[error("failed to start the filesystem watcher: {0}")]
    Notify(#[from] notify::Error),
    #[error("failed to start the watcher worker: {0}")]
    Spawn(#[source] std::io::Error),
}

/// Remembers paths this process just wrote so the watcher does not echo our own
/// saves back as external changes.
pub struct SelfWriteRegistry {
    window: Duration,
    entries: Mutex<HashMap<String, Instant>>,
}

impl SelfWriteRegistry {
    /// Creates a registry with the default one-second suppression window.
    pub fn new() -> Self {
        Self::with_window(SELF_WRITE_WINDOW)
    }

    /// Creates a registry with an explicit suppression window.
    ///
    /// @param window - How long a marked write stays suppressed.
    /// @returns The registry.
    pub fn with_window(window: Duration) -> Self {
        Self {
            window,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Marks a path as just written.
    ///
    /// @param path - The path to suppress.
    pub fn mark(&self, path: &Path) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        entries.retain(|_, expiry| *expiry > now);
        entries.insert(path_key(path), now + self.window);
    }

    /// Reports whether a path is inside its suppression window.
    ///
    /// @param path - The path to check.
    /// @returns True while events for the path should be ignored.
    pub fn is_suppressed(&self, path: &Path) -> bool {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        entries.retain(|_, expiry| *expiry > now);
        entries.contains_key(&path_key(path))
    }
}

impl Default for SelfWriteRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Keeps a watch alive until dropped.
pub struct WatchHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Watches a file or folder and delivers debounced change events.
///
/// File mode watches the parent folder and reports only the target file and its
/// temporary save files. Folder mode watches recursively and reports any change
/// below the folder. Events for paths just written by this process are dropped.
///
/// @param target - Absolute file or folder path to watch.
/// @param mode - Whether to watch one file or a folder tree.
/// @param self_writes - Registry shared with the writer that owns this target.
/// @param on_event - Callback invoked from the watcher worker thread for each
/// debounced event or runtime error. A delivered error also stops the watch.
/// @returns A handle that stops the watch when dropped.
/// @throws When the target is invalid or the operating system watcher cannot
/// start.
pub fn watch_path(
    target: &Path,
    mode: WatchMode,
    self_writes: Arc<SelfWriteRegistry>,
    on_event: impl Fn(Result<WatchEvent, WatchError>) + Send + 'static,
) -> Result<WatchHandle, WatchError> {
    watch_with_debounce(target, mode, self_writes, DEFAULT_DEBOUNCE, on_event)
}

/// Watches with an explicit debounce interval. See [`watch_path`].
///
/// @param target - Absolute file or folder path to watch.
/// @param mode - Whether to watch one file or a folder tree.
/// @param self_writes - Registry shared with the writer that owns this target.
/// @param debounce - Coalescing interval for rapid events.
/// @param on_event - Callback invoked from the watcher worker thread for each
/// debounced event or runtime error.
/// @returns A handle that stops the watch when dropped.
pub fn watch_with_debounce(
    target: &Path,
    mode: WatchMode,
    self_writes: Arc<SelfWriteRegistry>,
    debounce: Duration,
    on_event: impl Fn(Result<WatchEvent, WatchError>) + Send + 'static,
) -> Result<WatchHandle, WatchError> {
    let target = lexical_normalize(target);
    let watch_root = match mode {
        WatchMode::File => target
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| WatchError::InvalidTarget(target.clone()))?,
        WatchMode::Folder => target.clone(),
    };
    let (sender, receiver) = channel::<notify::Result<PathBuf>>();
    let mut watcher =
        recommended_watcher(move |result: notify::Result<notify::Event>| match result {
            Ok(event) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                for path in event.paths {
                    let _ = sender.send(Ok(path));
                }
            }
            Err(error) => {
                let _ = sender.send(Err(error));
            }
        })?;
    watcher.watch(
        &watch_root,
        match mode {
            WatchMode::File => RecursiveMode::NonRecursive,
            WatchMode::Folder => RecursiveMode::Recursive,
        },
    )?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = Arc::clone(&stop);
    let event_target = target.clone();
    let join = thread::Builder::new()
        .name("maestro-watch".into())
        .spawn(move || {
            let _watcher = watcher;
            let mut pending: HashMap<String, (PathBuf, Instant)> = HashMap::new();
            loop {
                if stop_worker.load(Ordering::SeqCst) {
                    break;
                }
                let now = Instant::now();
                let wait = pending
                    .values()
                    .map(|(_, due)| due.saturating_duration_since(now))
                    .min()
                    .unwrap_or(Duration::from_millis(100))
                    .min(Duration::from_millis(100));
                match receiver.recv_timeout(wait) {
                    Ok(Ok(changed)) => {
                        if !matches!(mode, WatchMode::Folder)
                            && !file_event_matches(&event_target, &changed)
                        {
                            continue;
                        }
                        if mode == WatchMode::Folder && !is_within(&changed, &event_target) {
                            continue;
                        }
                        if self_writes.is_suppressed(&event_target)
                            || self_writes.is_suppressed(&changed)
                        {
                            continue;
                        }
                        pending.insert(
                            path_key(&event_target),
                            (changed, Instant::now() + debounce),
                        );
                    }
                    Ok(Err(error)) => {
                        on_event(Err(WatchError::Notify(error)));
                        break;
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                let now = Instant::now();
                let due: Vec<String> = pending
                    .iter()
                    .filter(|(_, (_, due))| *due <= now)
                    .map(|(key, _)| key.clone())
                    .collect();
                for key in due {
                    if let Some((changed, _)) = pending.remove(&key) {
                        on_event(Ok(WatchEvent {
                            target: event_target.clone(),
                            changed,
                        }));
                    }
                }
            }
        })
        .map_err(WatchError::Spawn)?;

    Ok(WatchHandle {
        stop,
        join: Some(join),
    })
}

fn file_event_matches(target: &Path, changed: &Path) -> bool {
    let Some(target_name) = file_name_key(target) else {
        return false;
    };
    let Some(changed_name) = file_name_key(changed) else {
        return false;
    };
    changed_name == target_name || changed_name.starts_with(&format!("{target_name}.tmp-"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{Receiver, channel};

    type TestEvent = Result<WatchEvent, WatchError>;

    fn collect_events(target: &Path, mode: WatchMode) -> (WatchHandle, Receiver<TestEvent>) {
        let (sender, receiver) = channel();
        let handle = watch_with_debounce(
            target,
            mode,
            Arc::new(SelfWriteRegistry::new()),
            Duration::from_millis(50),
            move |event| {
                let _ = sender.send(event);
            },
        )
        .unwrap();
        (handle, receiver)
    }

    fn wait_for_event(receiver: &Receiver<TestEvent>, timeout: Duration) -> Option<WatchEvent> {
        receiver.recv_timeout(timeout).ok().and_then(Result::ok)
    }

    #[test]
    fn reports_external_changes_to_a_file() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.json");
        std::fs::write(&file, "{}").unwrap();
        let (_handle, receiver) = collect_events(&file, WatchMode::File);

        std::fs::write(&file, "{\"changed\":true}").unwrap();
        let event = wait_for_event(&receiver, Duration::from_secs(5)).expect("change event");
        assert_eq!(event.target, file);
        assert_eq!(
            file_name_key(&event.changed).as_deref(),
            Some("settings.json")
        );
    }

    #[test]
    fn ignores_unrelated_siblings_in_file_mode() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.json");
        std::fs::write(&file, "{}").unwrap();
        let (_handle, receiver) = collect_events(&file, WatchMode::File);

        std::fs::write(temp.path().join("other.json"), "{}").unwrap();
        assert!(wait_for_event(&receiver, Duration::from_millis(600)).is_none());
    }

    #[test]
    fn watches_folders_recursively() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("commands");
        let nested = folder.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let (_handle, receiver) = collect_events(&folder, WatchMode::Folder);

        std::fs::write(nested.join("new.md"), "hello").unwrap();
        let event = wait_for_event(&receiver, Duration::from_secs(5)).expect("folder event");
        assert_eq!(event.target, folder);
        assert!(is_within(&event.changed, &folder));
    }

    #[test]
    fn coalesces_rapid_changes() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.json");
        std::fs::write(&file, "{}").unwrap();
        let (_handle, receiver) = collect_events(&file, WatchMode::File);

        for value in 0..3 {
            std::fs::write(&file, format!("{{\"value\":{value}}}")).unwrap();
        }
        let first = wait_for_event(&receiver, Duration::from_secs(5)).expect("first event");
        assert_eq!(first.target, file);
        assert!(wait_for_event(&receiver, Duration::from_millis(300)).is_none());
    }

    #[test]
    fn suppresses_self_writes_until_the_window_expires() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.json");
        std::fs::write(&file, "{}").unwrap();
        let writes = Arc::new(SelfWriteRegistry::with_window(Duration::from_millis(400)));
        let (sender, receiver) = channel();
        let _handle = watch_with_debounce(
            &file,
            WatchMode::File,
            Arc::clone(&writes),
            Duration::from_millis(50),
            move |event| {
                let _ = sender.send(event);
            },
        )
        .unwrap();

        writes.mark(&file);
        std::fs::write(&file, "{\"self\":true}").unwrap();
        assert!(wait_for_event(&receiver, Duration::from_millis(350)).is_none());

        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(&file, "{\"external\":true}").unwrap();
        assert!(wait_for_event(&receiver, Duration::from_secs(5)).is_some());
    }

    #[test]
    fn dropping_the_handle_stops_events() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.json");
        std::fs::write(&file, "{}").unwrap();
        let (handle, receiver) = collect_events(&file, WatchMode::File);
        drop(handle);

        std::fs::write(&file, "{\"late\":true}").unwrap();
        assert!(wait_for_event(&receiver, Duration::from_millis(600)).is_none());
    }
}
