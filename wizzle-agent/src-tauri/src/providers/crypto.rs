use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
use sha2::{Digest, Sha256};

const KEY_ENV_VAR: &str = "WIZZLE_PROVIDER_KEY";
#[cfg(not(test))]
const KEYRING_ACCOUNT: &str = "provider-master-key-v1";
#[cfg(not(test))]
const KEYRING_SERVICE: &str = "com.wizzle.agent";
const NONCE_BYTES: usize = 12;
const PAYLOAD_HEADER: &[u8; 4] = b"WZK2";

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
            let mut key = [0_u8; 32];
            OsRng.fill_bytes(&mut key);
            entry.set_secret(&key).map_err(|_| {
                "Could not protect the provider key in the OS credential vault.".to_string()
            })?;
            Ok(key)
        }
        Err(_) => {
            Err("Could not unlock the provider key from the OS credential vault.".to_string())
        }
    }
}

fn encrypt_with_key(api_key: &str, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
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
    !payload.starts_with(PAYLOAD_HEADER)
}

pub fn encrypt_api_key(api_key: &str) -> Result<Vec<u8>, String> {
    if api_key.trim().is_empty() {
        return Ok(Vec::new());
    }
    encrypt_with_key(api_key, &current_key_material()?)
}

pub fn decrypt_api_key(payload: Option<Vec<u8>>) -> Result<Option<String>, String> {
    let Some(payload) = payload else {
        return Ok(None);
    };
    if payload.is_empty() {
        return Ok(None);
    }

    let api_key = if payload.starts_with(PAYLOAD_HEADER) {
        decrypt_with_key(&payload[PAYLOAD_HEADER.len()..], &current_key_material()?)?
    } else {
        decrypt_with_key(&payload, &legacy_key_material())?
    };
    Ok(Some(api_key))
}

#[cfg(test)]
mod tests {
    use super::{decrypt_api_key, encrypt_api_key, payload_needs_migration, PAYLOAD_HEADER};

    #[test]
    fn api_key_round_trips_without_plaintext_payload() {
        let encrypted = encrypt_api_key("sk-test-value").expect("encrypt api key");

        assert!(encrypted.starts_with(PAYLOAD_HEADER));
        assert!(!payload_needs_migration(&encrypted));
        assert!(!String::from_utf8_lossy(&encrypted).contains("sk-test-value"));
        assert_eq!(
            decrypt_api_key(Some(encrypted)).expect("decrypt api key"),
            Some("sk-test-value".to_string())
        );
    }
}
