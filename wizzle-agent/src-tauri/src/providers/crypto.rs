use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
use sha2::{Digest, Sha256};
#[cfg(not(test))]
use std::{
    fs::{self, OpenOptions},
    io::Write,
    sync::OnceLock,
};

#[cfg(not(test))]
use crate::workspace::paths::{ensure_dir, wizzle_root_dir};

const KEY_ENV_VAR: &str = "WIZZLE_PROVIDER_KEY";
#[cfg(not(test))]
const KEYRING_ACCOUNT: &str = "provider-master-key-v1";
#[cfg(not(test))]
const KEYRING_SERVICE: &str = "com.wizzle.agent";
#[cfg(not(test))]
const LOCAL_KEY_FILE_NAME: &str = "provider-master-key-v2";
const NONCE_BYTES: usize = 12;
const LOCAL_PAYLOAD_HEADER: &[u8; 4] = b"WZK3";
const KEYRING_PAYLOAD_HEADER: &[u8; 4] = b"WZK2";

#[cfg(not(test))]
static LOCAL_KEY_MATERIAL: OnceLock<Result<[u8; 32], String>> = OnceLock::new();
#[cfg(not(test))]
static PREVIOUS_KEY_MATERIAL: OnceLock<Result<[u8; 32], String>> = OnceLock::new();

fn derive_configured_key(configured_secret: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"wizzle-provider-key-v2");
    hasher.update(configured_secret.as_bytes());
    hasher.finalize().into()
}

fn legacy_key_material() -> [u8; 32] {
    let configured_secret = std::env::var(KEY_ENV_VAR).unwrap_or_default();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();

    let mut hasher = Sha256::new();
    hasher.update(b"wizzle-provider-key-v1");
    hasher.update(configured_secret.as_bytes());
    hasher.update(home.as_bytes());
    hasher.update(user.as_bytes());
    hasher.finalize().into()
}

#[cfg(test)]
fn current_key_material() -> Result<[u8; 32], String> {
    Ok(derive_configured_key("wizzle-test-provider-key"))
}

#[cfg(not(test))]
fn current_key_material() -> Result<[u8; 32], String> {
    if let Ok(secret) = std::env::var(KEY_ENV_VAR) {
        if !secret.trim().is_empty() {
            return Ok(derive_configured_key(&secret));
        }
    }

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

#[cfg(test)]
fn previous_key_material() -> Result<[u8; 32], String> {
    Ok(derive_configured_key("wizzle-test-keyring-provider-key"))
}

#[cfg(not(test))]
fn previous_key_material() -> Result<[u8; 32], String> {
    if let Ok(secret) = std::env::var(KEY_ENV_VAR) {
        if !secret.trim().is_empty() {
            return Ok(derive_configured_key(&secret));
        }
    }

    PREVIOUS_KEY_MATERIAL
        .get_or_init(read_previous_keyring_key)
        .clone()
}

#[cfg(not(test))]
fn read_previous_keyring_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|_| "Could not access the OS credential vault for provider keys.".to_string())?;
    match entry.get_secret() {
        Ok(secret) if secret.len() == 32 => {
            let mut key = [0_u8; 32];
            key.copy_from_slice(&secret);
            Ok(key)
        }
        Ok(_) => Err("The provider key stored in the OS credential vault is invalid.".to_string()),
        Err(keyring::Error::NoEntry) => {
            Err("The previous provider key is no longer available for migration.".to_string())
        }
        Err(_) => {
            Err("Could not unlock the provider key from the OS credential vault.".to_string())
        }
    }
}

fn encrypt_with_key(api_key: &str, key: &[u8; 32], header: &[u8; 4]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Could not prepare provider key storage.".to_string())?;
    let mut nonce_bytes = [0_u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce_bytes);
    let mut ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), api_key.as_bytes())
        .map_err(|_| "Could not store the provider API key.".to_string())?;

    let mut payload = Vec::with_capacity(header.len() + NONCE_BYTES + ciphertext.len());
    payload.extend_from_slice(header);
    payload.extend_from_slice(&nonce_bytes);
    payload.append(&mut ciphertext);
    Ok(payload)
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

pub fn payload_needs_migration(payload: &[u8]) -> bool {
    !payload.starts_with(LOCAL_PAYLOAD_HEADER)
}

pub fn encrypt_api_key(api_key: &str) -> Result<Vec<u8>, String> {
    if api_key.trim().is_empty() {
        return Ok(Vec::new());
    }
    encrypt_with_key(api_key, &current_key_material()?, LOCAL_PAYLOAD_HEADER)
}

pub fn decrypt_api_key(payload: Option<Vec<u8>>) -> Result<Option<String>, String> {
    let Some(payload) = payload else {
        return Ok(None);
    };
    if payload.is_empty() {
        return Ok(None);
    }

    let api_key = if payload.starts_with(LOCAL_PAYLOAD_HEADER) {
        decrypt_with_key(
            &payload[LOCAL_PAYLOAD_HEADER.len()..],
            &current_key_material()?,
        )?
    } else if payload.starts_with(KEYRING_PAYLOAD_HEADER) {
        // WZK2 only remains so existing installs can migrate without losing saved keys.
        decrypt_with_key(
            &payload[KEYRING_PAYLOAD_HEADER.len()..],
            &previous_key_material()?,
        )?
    } else {
        decrypt_with_key(&payload, &legacy_key_material())?
    };
    Ok(Some(api_key))
}

#[cfg(test)]
mod tests {
    use super::{
        decrypt_api_key, encrypt_api_key, encrypt_with_key, payload_needs_migration,
        previous_key_material, KEYRING_PAYLOAD_HEADER, LOCAL_PAYLOAD_HEADER,
    };

    #[test]
    fn api_key_round_trips_without_plaintext_payload() {
        let encrypted = encrypt_api_key("sk-test-value").expect("encrypt api key");

        assert!(encrypted.starts_with(LOCAL_PAYLOAD_HEADER));
        assert!(!payload_needs_migration(&encrypted));
        assert!(!String::from_utf8_lossy(&encrypted).contains("sk-test-value"));
        assert_eq!(
            decrypt_api_key(Some(encrypted)).expect("decrypt api key"),
            Some("sk-test-value".to_string())
        );
    }

    #[test]
    fn keyring_payloads_remain_readable_for_one_time_migration() {
        let encrypted = encrypt_with_key(
            "sk-previous-value",
            &previous_key_material().expect("previous key"),
            KEYRING_PAYLOAD_HEADER,
        )
        .expect("encrypt previous api key");

        assert!(payload_needs_migration(&encrypted));
        assert_eq!(
            decrypt_api_key(Some(encrypted)).expect("decrypt previous api key"),
            Some("sk-previous-value".to_string())
        );
    }
}
