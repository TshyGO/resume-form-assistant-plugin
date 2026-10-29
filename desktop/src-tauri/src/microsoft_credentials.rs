//! Versioned credential chunks stay entirely in the OS vault. Windows password
//! entries are UTF-16 and have a small size limit; a Graph JWT can exceed it.
//! The root entry is the atomic generation pointer. Old generations remain
//! discoverable until cleanup succeeds, including after a crash or failed delete.
use crate::ai_credentials::CredentialStore;
use crate::microsoft_auth::AuthError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
type Result<T> = std::result::Result<T, AuthError>;
const CHUNK: usize = 1000;
const MAX_CHUNKS: usize = 128;
#[derive(Clone, Serialize, Deserialize)]
struct Generation {
    id: String,
    chunks: usize,
    digest: String,
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u8,
    active: Generation,
    retired: Vec<Generation>,
}
fn chunk_key(root: &str, generation: &Generation, index: usize) -> String {
    format!("{root}:oauth:{}:{index}", generation.id)
}
fn manifest(raw: &str) -> Result<Manifest> {
    let value: Manifest = serde_json::from_str(raw).map_err(|_| AuthError::Credentials)?;
    if value.version != 1
        || value.retired.len() > 128
        || std::iter::once(&value.active)
            .chain(value.retired.iter())
            .any(|g| {
                uuid::Uuid::parse_str(&g.id).is_err()
                    || g.chunks == 0
                    || g.chunks > MAX_CHUNKS
                    || g.digest.len() != 64
            })
    {
        return Err(AuthError::Credentials);
    }
    Ok(value)
}
fn root_value(store: &dyn CredentialStore, root: &str) -> Result<Option<String>> {
    store.get_key(root).map_err(|_| AuthError::Credentials)
}
fn set_manifest(store: &dyn CredentialStore, root: &str, value: &Manifest) -> Result<()> {
    // Metadata can also grow after repeated cleanup failures. Bound the root
    // password to the same cross-platform limit and fail without replacing it.
    let raw = serde_json::to_string(value).map_err(|_| AuthError::Credentials)?;
    if raw.len() > CHUNK {
        return Err(AuthError::Credentials);
    }
    store
        .set_key(root, &raw)
        .map_err(|_| AuthError::Credentials)
}
fn clear_generation(store: &dyn CredentialStore, root: &str, generation: &Generation) -> bool {
    let mut cleared = true;
    for index in 0..generation.chunks {
        cleared &= store.clear_key(&chunk_key(root, generation, index)).is_ok();
    }
    cleared
}
pub fn read(store: &dyn CredentialStore, root: &str) -> Result<Option<String>> {
    use base64::Engine;
    let Some(raw) = root_value(store, root)? else {
        return Ok(None);
    };
    let value = manifest(&raw)?;
    let mut encoded = String::new();
    for index in 0..value.active.chunks {
        let chunk = store
            .get_key(&chunk_key(root, &value.active, index))
            .map_err(|_| AuthError::Credentials)?
            .ok_or(AuthError::Credentials)?;
        if chunk.len() > CHUNK || !chunk.is_ascii() {
            return Err(AuthError::Credentials);
        }
        encoded.push_str(&chunk);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| AuthError::Credentials)?;
    if format!("{:x}", Sha256::digest(&bytes)) != value.active.digest {
        return Err(AuthError::Credentials);
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| AuthError::Credentials)
}
/// Caller serializes all access. Write chunks first, switch the root last, and
/// retain old generations until the caller's short database commit succeeds.
pub fn replace<T>(
    store: &dyn CredentialStore,
    root: &str,
    secret: &str,
    commit: impl FnOnce() -> Result<T>,
) -> Result<T> {
    use base64::Engine;
    let previous = root_value(store, root)?;
    let old = previous.as_deref().map(manifest).transpose()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(secret);
    let generation = Generation {
        id: uuid::Uuid::new_v4().to_string(),
        chunks: encoded.len().div_ceil(CHUNK),
        digest: format!("{:x}", Sha256::digest(secret.as_bytes())),
    };
    if generation.chunks == 0 || generation.chunks > MAX_CHUNKS {
        return Err(AuthError::Credentials);
    }
    let mut retired = Vec::new();
    if let Some(old) = old {
        retired.push(old.active);
        retired.extend(old.retired);
    }
    let mut next = Manifest {
        version: 1,
        active: generation.clone(),
        retired,
    };
    // Record the staged generation before writing chunks. A crash while
    // replacing an existing account leaves its old active generation readable,
    // and disconnect can still find every partially written generation.
    let staging = match previous.as_deref().map(manifest).transpose()? {
        Some(mut old) => {
            old.retired.push(generation.clone());
            old
        }
        None => Manifest {
            version: 1,
            active: generation.clone(),
            retired: vec![],
        },
    };
    set_manifest(store, root, &staging)?;
    let written = (|| {
        for (index, chunk) in encoded.as_bytes().chunks(CHUNK).enumerate() {
            store
                .set_key(
                    &chunk_key(root, &generation, index),
                    std::str::from_utf8(chunk).map_err(|_| AuthError::Credentials)?,
                )
                .map_err(|_| AuthError::Credentials)?;
        }
        set_manifest(store, root, &next)
    })();
    if let Err(error) = written {
        if clear_generation(store, root, &generation) {
            match &previous {
                Some(raw) => store.set_key(root, raw),
                None => store.clear_key(root),
            }
            .map_err(|_| AuthError::Credentials)?;
        } else {
            // Retain intent; a later disconnect retries the failed OS deletes.
            set_manifest(store, root, &staging)?;
        }
        return Err(error);
    }
    let result = commit();
    if result.is_err() {
        if !clear_generation(store, root, &generation) {
            set_manifest(store, root, &staging)?;
            return Err(AuthError::Credentials);
        }
        match previous {
            Some(raw) => store.set_key(root, &raw),
            None => store.clear_key(root),
        }
        .map_err(|_| AuthError::Credentials)?;
        return result;
    }
    next.retired
        .retain(|old| !clear_generation(store, root, old));
    // If compacting the pointer fails, the prior manifest still lists every
    // retired generation, so disconnect can retry (missing chunks are harmless).
    let _ = set_manifest(store, root, &next);
    result
}
pub fn clear(store: &dyn CredentialStore, root: &str) -> Result<()> {
    let Some(raw) = root_value(store, root)? else {
        return Ok(());
    };
    let value = manifest(&raw)?;
    let mut cleared = clear_generation(store, root, &value.active);
    for old in &value.retired {
        cleared &= clear_generation(store, root, old);
    }
    if !cleared {
        return Err(AuthError::Credentials);
    }
    store.clear_key(root).map_err(|_| AuthError::Credentials)
}
