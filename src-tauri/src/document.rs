use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
};

const MAX_BYTES: usize = 1024 * 1024;
const INITIAL_CONTENT: &str = "{\n    \"name\": \"Maestro synthetic fixture\",\n    \"enabled\": true,\n    \"tools\": [\"claude\", \"codex\"]\n}\n";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    content: String,
    revision: String,
}

pub(crate) struct Fixture {
    file: File,
}

impl Fixture {
    pub(crate) fn new() -> std::io::Result<Self> {
        // An anonymous tempfile is deleted by Windows even when Tauri exits without dropping state.
        let mut file = tempfile::tempfile()?;
        file.write_all(INITIAL_CONTENT.as_bytes())?;
        file.flush()?;
        Ok(Self { file })
    }

    // Retaining the original handle prevents a replaced path from redirecting fixture I/O.
    pub(crate) fn read(&mut self) -> Result<Document, String> {
        self.file
            .rewind()
            .map_err(|e| format!("Seek fixture: {e}"))?;
        let mut bytes = Vec::new();
        (&mut self.file)
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Read fixture: {e}"))?;
        if bytes.len() > MAX_BYTES {
            return Err("Fixture exceeds the 1 MiB prototype limit".into());
        }
        let content = String::from_utf8(bytes).map_err(|_| "Fixture is not valid UTF-8")?;
        let revision = format!("{:x}", Sha256::digest(content.as_bytes()));
        Ok(Document { content, revision })
    }

    pub(crate) fn save(&mut self, content: &str, expected: &str) -> Result<Document, String> {
        if content.len() > MAX_BYTES {
            return Err("Fixture exceeds the 1 MiB prototype limit".into());
        }
        serde_json::from_str::<serde_json::Value>(content)
            .map_err(|e| format!("Invalid JSON at line {}, column {}", e.line(), e.column()))?;
        if self.read()?.revision != expected {
            return Err("Fixture changed on disk. Reload before saving".into());
        }
        // This disposable fixture uses in-place writes, not the Phase 2 production save protocol.
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|e| format!("Seek fixture: {e}"))?;
        self.file
            .write_all(content.as_bytes())
            .map_err(|e| format!("Write fixture: {e}"))?;
        self.file
            .set_len(content.len() as u64)
            .map_err(|e| format!("Resize fixture: {e}"))?;
        self.file
            .sync_all()
            .map_err(|e| format!("Flush fixture: {e}"))?;
        self.read()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_unicode_and_truncates_previous_content() {
        let mut fixture = Fixture::new().unwrap();
        let loaded = fixture.read().unwrap();
        let saved = fixture
            .save("{\"label\":\"café\"}\r\n", &loaded.revision)
            .unwrap();
        assert_eq!(fixture.read().unwrap().content, saved.content);
        assert_ne!(saved.revision, loaded.revision);
    }

    #[test]
    fn rejects_invalid_oversized_and_stale_writes_without_changing_disk() {
        let mut fixture = Fixture::new().unwrap();
        let original = fixture.read().unwrap();
        assert!(fixture.save("{", &original.revision).is_err());
        assert!(
            fixture
                .save(&" ".repeat(MAX_BYTES + 1), &original.revision)
                .is_err()
        );
        assert!(fixture.save("{}", "stale").is_err());
        assert_eq!(fixture.read().unwrap().content, original.content);
    }
}
