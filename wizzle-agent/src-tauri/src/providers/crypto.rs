use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
use sha2::{Digest, Sha256};

const NONCE_BYTES: usize = 12;
const KEY_ENV_VAR: &str = "WIZZLE_PROVIDER_KEY";

fn derive_key_material() -> [u8; 32] {
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

pub fn encrypt_api_key(api_key: &str) -> Result<Vec<u8>, String> {
    if api_key.trim().is_empty() {
        return Ok(Vec::new());
    }

    let key = derive_key_material();
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "Could not prepare provider key storage.".to_string())?;
    let mut nonce_bytes = [0u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut ciphertext = cipher
        .encrypt(nonce, api_key.as_bytes())
        .map_err(|_| "Could not store the provider API key.".to_string())?;

    let mut payload = nonce_bytes.to_vec();
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

    if payload.len() <= NONCE_BYTES {
        return Err("Could not read the provider API key.".to_string());
    }

    let (nonce_bytes, ciphertext) = payload.split_at(NONCE_BYTES);
    let key = derive_key_material();
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "Could not prepare provider key storage.".to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| "Could not unlock the provider API key.".to_string())?;
    let api_key = String::from_utf8(plaintext)
        .map_err(|_| "Could not read the provider API key.".to_string())?;

    Ok(Some(api_key))
}

#[cfg(test)]
mod tests {
    use super::{decrypt_api_key, encrypt_api_key};

    #[test]
    fn api_key_round_trips_without_plaintext_payload() {
        let encrypted = encrypt_api_key("sk-test-value").expect("encrypt api key");

        assert!(!encrypted.is_empty());
        assert!(!String::from_utf8_lossy(&encrypted).contains("sk-test-value"));
        assert_eq!(
            decrypt_api_key(Some(encrypted)).expect("decrypt api key"),
            Some("sk-test-value".to_string())
        );
    }
}
