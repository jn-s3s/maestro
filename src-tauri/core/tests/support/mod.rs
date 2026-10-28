#![allow(dead_code)]

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use maestro_core::{
    crypto::HistoryKey,
    detection::{CustomEntry, DetectionEnv, detect_tools},
    files::{FileStore, Registry},
    history::HistoryStore,
    watch::SelfWriteRegistry,
};
use tempfile::TempDir;

pub const TEST_KEY: [u8; 32] = [42u8; 32];

pub struct Synthetic {
    temp: TempDir,
}

impl Synthetic {
    pub fn new() -> Self {
        Self {
            temp: tempfile::tempdir().expect("create synthetic root"),
        }
    }

    pub fn root(&self) -> &Path {
        self.temp.path()
    }

    pub fn home(&self) -> PathBuf {
        self.root().join("home")
    }

    pub fn appdata(&self) -> PathBuf {
        self.root().join("appdata")
    }

    pub fn local_appdata(&self) -> PathBuf {
        self.root().join("localappdata")
    }

    pub fn env(&self) -> DetectionEnv {
        DetectionEnv {
            home: self.home(),
            appdata: self.appdata(),
            local_appdata: self.local_appdata(),
            xdg_data_home: None,
            xdg_config_home: None,
            codex_home: None,
            qoder_config_dir: None,
            cline_data_dir: None,
        }
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.home().join(relative)
    }

    pub fn write(&self, relative: &str, content: &str) -> PathBuf {
        let path = self.path(relative);
        self.write_at(&path, content)
    }

    pub fn write_at(&self, path: &Path, content: &str) -> PathBuf {
        fs::create_dir_all(path.parent().expect("path parent")).expect("create parent");
        fs::write(path, content).expect("write synthetic file");
        path.to_path_buf()
    }

    pub fn history(&self) -> HistoryStore {
        HistoryStore::new(self.root().join("backups"), test_key())
    }

    pub fn store(&self, custom: &[CustomEntry]) -> FileStore {
        let tools = detect_tools(&self.env(), custom);
        FileStore::new(
            Registry::new(tools),
            self.history(),
            Arc::new(SelfWriteRegistry::new()),
        )
    }
}

pub fn test_key() -> HistoryKey {
    HistoryKey::from_bytes(TEST_KEY)
}

pub fn custom(id: &str, path: &Path) -> CustomEntry {
    CustomEntry {
        id: id.to_owned(),
        name: id.to_owned(),
        path: path.to_path_buf(),
    }
}
