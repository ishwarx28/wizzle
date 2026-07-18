use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
#[cfg(test)]
use sha2::{Digest, Sha256};
#[cfg(not(test))]
use std::{
    fs::{self, OpenOptions},
    io::Write,
    sync::OnceLock,
};

#[cfg(not(test))]
use crate::workspace::paths::{ensure_dir, wizzle_root_dir};

#[cfg(not(test))]
const LOCAL_KEY_FILE_NAME: &str = "provider-master-key-v2";
const NONCE_BYTES: usize = 12;
const PAYLOAD_HEADER: &[u8; 4] = b"WZK3";

#[cfg(not(test))]
static LOCAL_KEY_MATERIAL: OnceLock<Result<[u8; 32], String>> = OnceLock::new();

#[cfg(test)]
fn current_key_material() -> Result<[u8; 32], String> {
    let mut hasher = Sha256::new();
    hasher.update(b"wizzle-provider-key-v2");
    hasher.update(b"wizzle-test-provider-key");
    Ok(hasher.finalize().into())
}

#[cfg(not(test))]
fn current_key_material() -> Result<[u8; 32], String> {
    LOCAL_KEY_MATERIAL
        .get_or_init(load_or_create_local_key)
        .clone()
}

#[cfg(not(test))]
fn read_local_key(path: &std::path::Path) -> Result<[u8; 32], String> {
    let bytes = fs::read(path)
        .map_err(|_| "Could not read Wizzle's local provider key file.".to_string())?;
    bytes
        .try_into()
        .map_err(|_| "Wizzle's local provider key file is invalid.".to_string())
}

#[cfg(not(test))]
fn load_or_create_local_key() -> Result<[u8; 32], String> {
    let state_dir = wizzle_root_dir()
        .map_err(|_| "Could not locate Wizzle's local provider key storage.".to_string())?
        .join("state");
    ensure_dir(&state_dir)
        .map_err(|_| "Could not prepare Wizzle's local provider key storage.".to_string())?;
    let key_path = state_dir.join(LOCAL_KEY_FILE_NAME);

    if key_path.exists() {
        return read_local_key(&key_path);
    }

    let mut key = [0_u8; 32];
    OsRng.fill_bytes(&mut key);
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    match options.open(&key_path) {
        Ok(mut file) => {
            file.write_all(&key)
                .and_then(|_| file.sync_all())
                .map_err(|_| "Could not save Wizzle's local provider key file.".to_string())?;
            Ok(key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_local_key(&key_path)
        }
        Err(_) => Err("Could not create Wizzle's local provider key file.".to_string()),
    }
}

fn decrypt_with_key(payload: &[u8], key: &[u8; 32]) -> Result<String, String> {
    if payload.len() <= NONCE_BYTES {
        return Err("Could not read the provider API key.".to_string());
    }
    let (nonce_bytes, ciphertext) = payload.split_at(NONCE_BYTES);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Could not prepare provider key storage.".to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "Could not unlock the provider API key.".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "Could not read the provider API key.".to_string())
}

pub fn encrypt_api_key(api_key: &str) -> Result<Vec<u8>, String> {
    if api_key.trim().is_empty() {
        return Ok(Vec::new());
    }
    let cipher = Aes256Gcm::new_from_slice(&current_key_material()?)
        .map_err(|_| "Could not prepare provider key storage.".to_string())?;
    let mut nonce_bytes = [0_u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce_bytes);
    let mut ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), api_key.as_bytes())
        .map_err(|_| "Could not store the provider API key.".to_string())?;

    let mut payload = Vec::with_capacity(PAYLOAD_HEADER.len() + NONCE_BYTES + ciphertext.len());
    payload.extend_from_slice(PAYLOAD_HEADER);
    payload.extend_from_slice(&nonce_bytes);
    payload.append(&mut ciphertext);
    Ok(payload)
}

pub fn decrypt_api_key(payload: Option<Vec<u8>>) -> Result<Option<String>, String> {
    let Some(payload) = payload else {
        return Ok(None);
    };
    if payload.is_empty() {
        return Ok(None);
    }
    if !payload.starts_with(PAYLOAD_HEADER) {
        return Err("The stored provider API key uses an unsupported format.".to_string());
    }
    let api_key = decrypt_with_key(&payload[PAYLOAD_HEADER.len()..], &current_key_material()?)?;
    Ok(Some(api_key))
}

#[cfg(test)]
mod tests {
    use super::{decrypt_api_key, encrypt_api_key, PAYLOAD_HEADER};

    #[test]
    fn api_key_round_trips_without_plaintext_payload() {
        let encrypted = encrypt_api_key("sk-test-value").expect("encrypt api key");

        assert!(encrypted.starts_with(PAYLOAD_HEADER));
        assert!(!String::from_utf8_lossy(&encrypted).contains("sk-test-value"));
        assert_eq!(
            decrypt_api_key(Some(encrypted)).expect("decrypt api key"),
            Some("sk-test-value".to_string())
        );
    }

    #[test]
    fn unsupported_payloads_are_rejected() {
        assert!(decrypt_api_key(Some(b"WZK2old-payload".to_vec())).is_err());
    }
}
