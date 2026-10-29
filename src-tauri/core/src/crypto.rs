//! Snapshot encryption and the machine-bound history key.
//!
//! Snapshots are always encrypted with AES-256-GCM. On Windows the key itself
//! is protected with DPAPI for the current user, so history stays unreadable
//! without the user's Windows account.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use thiserror::Error;

pub const SNAPSHOT_PREFIX: &str = "maestro-rust-enc:v1:";
const PAYLOAD_VERSION: &[u8; 2] = b"v1";
const KEY_FILE: &str = "history.key";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("random number generation failed: {0}")]
    Random(String),
    #[error("cannot use history key {path}: {source}")]
    KeyIo { path: PathBuf, source: io::Error },
    #[error("history key file has an unsupported format")]
    KeyFormat,
    #[error("history key protection failed: {0}")]
    KeyProtection(String),
    #[error("snapshot is not encrypted")]
    NotEncrypted,
    #[error("snapshot wrapper version is not supported")]
    UnsupportedVersion,
    #[error("snapshot base64 is invalid")]
    InvalidBase64,
    #[error("snapshot is truncated")]
    Truncated,
    #[error("snapshot authentication failed; it may belong to another user or machine")]
    Authentication,
    #[error("decrypted snapshot is not valid UTF-8")]
    NotUtf8,
    #[error("snapshot encryption failed")]
    Encryption,
}

/// The 256-bit key used to encrypt every snapshot in one data root.
#[derive(Clone)]
pub struct HistoryKey([u8; KEY_LEN]);

impl HistoryKey {
    /// Wraps raw key bytes, for tests and for callers that manage their own key.
    ///
    /// @param bytes - Exactly 32 bytes of key material.
    /// @returns The key wrapper.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Generates a new random key.
    ///
    /// @returns The key wrapper.
    /// @throws When the operating system random source fails.
    pub fn generate() -> Result<Self, CryptoError> {
        let mut bytes = [0u8; KEY_LEN];
        getrandom::fill(&mut bytes).map_err(|error| CryptoError::Random(error.to_string()))?;
        Ok(Self(bytes))
    }

    /// Loads the history key from a data root, creating and protecting it on
    /// first use.
    ///
    /// @param data_root - Folder holding the key file.
    /// @returns The persisted key.
    /// @throws When the key file exists but is unreadable, unprotected, or the
    /// wrong length. A damaged key is never silently replaced.
    pub fn load_or_create(data_root: &Path) -> Result<Self, CryptoError> {
        let path = data_root.join(KEY_FILE);
        match fs::read(&path) {
            Ok(stored) => Self::decode_key_file(&stored),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(data_root).map_err(|source| CryptoError::KeyIo {
                    path: path.clone(),
                    source,
                })?;
                let key = Self::generate()?;
                let encoded = key.encode_key_file()?;
                match write_key_file(&path, &encoded) {
                    Ok(()) => Ok(key),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        let stored = fs::read(&path).map_err(|source| CryptoError::KeyIo {
                            path: path.clone(),
                            source,
                        })?;
                        Self::decode_key_file(&stored)
                    }
                    Err(source) => Err(CryptoError::KeyIo { path, source }),
                }
            }
            Err(source) => Err(CryptoError::KeyIo { path, source }),
        }
    }

    fn encode_key_file(&self) -> Result<Vec<u8>, CryptoError> {
        #[cfg(windows)]
        {
            let protected = dpapi_protect(&self.0)?;
            let mut out = Vec::with_capacity(5 + protected.len());
            out.extend_from_slice(b"DPAPI");
            out.extend_from_slice(&protected);
            Ok(out)
        }
        #[cfg(not(windows))]
        {
            Ok(self.0.to_vec())
        }
    }

    fn decode_key_file(stored: &[u8]) -> Result<Self, CryptoError> {
        #[cfg(windows)]
        let raw = {
            let protected = stored
                .strip_prefix(b"DPAPI")
                .ok_or(CryptoError::KeyFormat)?;
            dpapi_unprotect(protected)?
        };
        #[cfg(not(windows))]
        let raw = stored.to_vec();
        let bytes: [u8; KEY_LEN] = raw.try_into().map_err(|_| CryptoError::KeyFormat)?;
        Ok(Self(bytes))
    }
}

/// Writes the key through a flushed temporary file and an atomic no-clobber
/// link, so a crash cannot leave a truncated key behind. A concurrent creator
/// wins the link and the existing key is loaded by the caller.
fn write_key_file(path: &Path, encoded: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("history key has no parent folder"))?;
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
    let temp = parent.join(format!("{KEY_FILE}.tmp-{}", crate::hex_lower(&random)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    let result = file.write_all(encoded).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    match fs::hard_link(&temp, path) {
        Ok(()) => {
            let _ = fs::remove_file(&temp);
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&temp);
            Err(error)
        }
        Err(_) => {
            let _ = fs::remove_file(&temp);
            write_key_file_direct(path, encoded, options)
        }
    }
}

fn write_key_file_direct(path: &Path, encoded: &[u8], options: OpenOptions) -> io::Result<()> {
    let mut file = options.open(path)?;
    let result = file.write_all(encoded).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

/// Encrypts snapshot text into the versioned on-disk format.
///
/// @param key - The history key.
/// @param plaintext - Snapshot content.
/// @returns The marked encrypted blob.
/// @throws When randomness or encryption fails.
pub fn seal(key: &HistoryKey, plaintext: &str) -> Result<String, CryptoError> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce_bytes).map_err(|error| CryptoError::Random(error.to_string()))?;
    let cipher = Aes256Gcm::new_from_slice(&key.0).map_err(|_| CryptoError::KeyFormat)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_bytes(),
                aad: SNAPSHOT_PREFIX.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Encryption)?;
    let mut payload = Vec::with_capacity(PAYLOAD_VERSION.len() + NONCE_LEN + ciphertext.len());
    payload.extend_from_slice(PAYLOAD_VERSION);
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(&ciphertext);
    Ok(format!("{SNAPSHOT_PREFIX}{}", STANDARD.encode(payload)))
}

/// Decrypts a stored snapshot blob.
///
/// @param key - The history key.
/// @param stored - The marked encrypted blob.
/// @returns The plaintext snapshot.
/// @throws When the wrapper, encoding or authentication is invalid.
pub fn open(key: &HistoryKey, stored: &str) -> Result<String, CryptoError> {
    let Some(encoded) = stored.strip_prefix(SNAPSHOT_PREFIX) else {
        return Err(if stored.starts_with("maestro-rust-enc:") {
            CryptoError::UnsupportedVersion
        } else {
            CryptoError::NotEncrypted
        });
    };
    let payload = STANDARD
        .decode(encoded)
        .map_err(|_| CryptoError::InvalidBase64)?;
    if payload.len() < PAYLOAD_VERSION.len() + NONCE_LEN + TAG_LEN {
        return Err(CryptoError::Truncated);
    }
    if &payload[..PAYLOAD_VERSION.len()] != PAYLOAD_VERSION {
        return Err(CryptoError::UnsupportedVersion);
    }
    let (nonce, ciphertext) = payload[PAYLOAD_VERSION.len()..]
        .split_at_checked(NONCE_LEN)
        .ok_or(CryptoError::Truncated)?;
    let cipher = Aes256Gcm::new_from_slice(&key.0).map_err(|_| CryptoError::KeyFormat)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: SNAPSHOT_PREFIX.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Authentication)?;
    String::from_utf8(plaintext).map_err(|_| CryptoError::NotUtf8)
}

#[cfg(windows)]
pub(crate) fn dpapi_protect(secret: &[u8]) -> Result<Vec<u8>, CryptoError> {
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(secret.len())
            .map_err(|_| CryptoError::KeyProtection("key too large".into()))?,
        pbData: secret.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: the input buffer outlives the call and DPAPI owns the output buffer.
    let success = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(CryptoError::KeyProtection(
            io::Error::last_os_error().to_string(),
        ));
    }
    copy_and_free(output)
        .ok_or_else(|| CryptoError::KeyProtection("DPAPI returned an empty buffer".into()))
}

#[cfg(windows)]
pub(crate) fn dpapi_unprotect(protected: &[u8]) -> Result<Vec<u8>, CryptoError> {
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(protected.len()).map_err(|_| CryptoError::KeyFormat)?,
        pbData: protected.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: the input buffer outlives the call and DPAPI owns the output buffer.
    let success = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(CryptoError::KeyFormat);
    }
    copy_and_free(output).ok_or(CryptoError::KeyFormat)
}

#[cfg(windows)]
fn copy_and_free(
    blob: windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB,
) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;

    if blob.pbData.is_null() {
        return None;
    }
    // SAFETY: DPAPI allocated `cbData` readable bytes; they are copied before the single LocalFree.
    let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
    // SAFETY: this buffer was allocated by DPAPI and is released exactly once.
    unsafe { LocalFree(blob.pbData.cast()) };
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> HistoryKey {
        HistoryKey::from_bytes([9u8; KEY_LEN])
    }

    #[test]
    fn seals_and_opens_unicode_control_and_empty_text() {
        for text in ["", "café 日本語 \u{0} mixed\r\nline endings", "{}"] {
            let sealed = seal(&key(), text).unwrap();
            assert!(sealed.starts_with(SNAPSHOT_PREFIX));
            assert!(!sealed.contains("café"));
            assert_eq!(open(&key(), &sealed).unwrap(), text);
        }
    }

    #[test]
    fn rejects_tampered_foreign_and_malformed_blobs() {
        let sealed = seal(&key(), "synthetic").unwrap();
        let mut tampered = sealed.clone().into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).unwrap();
        assert!(matches!(
            open(&key(), &tampered),
            Err(CryptoError::Authentication)
        ));
        assert!(matches!(
            open(&HistoryKey::from_bytes([3u8; KEY_LEN]), &sealed),
            Err(CryptoError::Authentication)
        ));
        for stored in [
            "plain text",
            "maestro-rust-enc:v9:abc",
            "maestro-rust-enc:v1:!",
            "maestro-rust-enc:v1:djE=",
        ] {
            assert!(open(&key(), stored).is_err(), "{stored}");
        }
    }

    #[test]
    fn every_seal_uses_a_fresh_nonce() {
        let first = seal(&key(), "same").unwrap();
        let second = seal(&key(), "same").unwrap();
        assert_ne!(first, second);
    }

    #[cfg(windows)]
    #[test]
    fn persists_a_dpapi_protected_key() {
        let root = tempfile::tempdir().unwrap();
        let first = HistoryKey::load_or_create(root.path()).unwrap();
        let sealed = seal(&first, "synthetic history").unwrap();

        let key_file = root.path().join(KEY_FILE);
        let stored = fs::read(&key_file).unwrap();
        assert!(stored.starts_with(b"DPAPI"));

        let second = HistoryKey::load_or_create(root.path()).unwrap();
        assert_eq!(open(&second, &sealed).unwrap(), "synthetic history");
    }

    #[cfg(windows)]
    #[test]
    fn concurrent_key_creation_agrees_on_one_key() {
        let root = tempfile::tempdir().unwrap();
        let first_root = root.path().to_path_buf();
        let second_root = first_root.clone();
        let first = std::thread::spawn(move || HistoryKey::load_or_create(&first_root).unwrap());
        let second = std::thread::spawn(move || HistoryKey::load_or_create(&second_root).unwrap());
        let first = first.join().unwrap();
        let second = second.join().unwrap();

        let sealed = seal(&first, "shared history").unwrap();
        assert_eq!(open(&second, &sealed).unwrap(), "shared history");
    }

    #[cfg(windows)]
    #[test]
    fn refuses_unprotected_key_files_on_windows() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(KEY_FILE), [1u8; KEY_LEN]).unwrap();
        assert!(matches!(
            HistoryKey::load_or_create(root.path()),
            Err(CryptoError::KeyFormat)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn refuses_a_damaged_protected_key() {
        let root = tempfile::tempdir().unwrap();
        let mut stored = b"DPAPI".to_vec();
        stored.extend_from_slice(b"not a DPAPI blob");
        fs::write(root.path().join(KEY_FILE), stored).unwrap();
        assert!(HistoryKey::load_or_create(root.path()).is_err());
    }
}
