use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};

const PREFIX: &str = "maestro-enc:v1:";

pub(crate) fn decode(stored: &str, encrypted_key: &str) -> Result<String, String> {
    let Some(encoded) = stored.strip_prefix(PREFIX) else {
        if stored.starts_with("maestro-enc:") {
            return Err("Unsupported backup wrapper version".into());
        }
        return Ok(stored.to_owned());
    };
    let encrypted = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid backup base64")?;
    let payload = encrypted
        .strip_prefix(b"v10")
        .ok_or("Unsupported Electron ciphertext prefix")?;
    if payload.len() < 28 {
        return Err("Truncated AES-GCM nonce or authentication tag".into());
    }
    let wrapped_key = STANDARD
        .decode(encrypted_key)
        .map_err(|_| "Invalid profile key base64")?;
    let protected_key = wrapped_key
        .strip_prefix(b"DPAPI")
        .ok_or("Missing DPAPI profile key prefix")?;
    let key = unprotect(protected_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "Profile key is not 256 bits")?;
    let (nonce, ciphertext) = payload.split_at(12);
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "Snapshot authentication failed")?;
    String::from_utf8(plaintext).map_err(|_| "Decrypted backup is not UTF-8".into())
}

#[cfg(windows)]
fn unprotect(payload: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(payload.len()).map_err(|_| "Ciphertext too large")?,
        pbData: payload.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // SAFETY: input remains live during DPAPI; output is owned by LocalAlloc and freed below.
    let success = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err(format!(
            "DPAPI decryption failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if output.cbData > 0 && output.pbData.is_null() {
        return Err("DPAPI returned an empty buffer for non-empty plaintext".into());
    }
    let bytes = if output.cbData == 0 {
        Vec::new()
    } else {
        // SAFETY: successful DPAPI returns cbData readable bytes until LocalFree.
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    // SAFETY: this buffer was allocated by DPAPI and is released exactly once.
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(bytes)
}

#[cfg(not(windows))]
fn unprotect(_payload: &[u8]) -> Result<Vec<u8>, String> {
    Err("Electron backup interoperability must be checked on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_plaintext() {
        assert_eq!(
            decode("synthetic legacy text", "").unwrap(),
            "synthetic legacy text"
        );
    }

    #[test]
    fn rejects_bad_wrappers_and_ciphertext() {
        for stored in [
            "maestro-enc:v2:abc",
            "maestro-enc:v1:!",
            "maestro-enc:v1:eHl6",
            "maestro-enc:v1:djEw",
        ] {
            assert!(decode(stored, "").is_err());
        }
    }
}
