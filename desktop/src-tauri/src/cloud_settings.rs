//! Machine-local settings. Caller serializes all access with AppState.host.
use crate::{
    cloud_backup::{fail, model::Options, Result},
    cloud_credentials::{Binding, ConnectionDescriptor},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub connection: ConnectionDescriptor,
    pub options: Options,
    // Reserved gate for #307. No scheduler may run while this is false.
    #[serde(default)]
    pub automatic_enabled: bool,
    #[serde(default)]
    pub requires_confirmation: bool,
}
fn document(path: &Path) -> Result<serde_json::Value> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!({})),
        Err(_) => return Err(fail("SETTINGS_IO")),
    };
    let mut bytes = Vec::new();
    file.take(512 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 512 * 1024 {
        return Err(fail("INVALID_SETTINGS"));
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| fail("INVALID_SETTINGS"))?;
    if !value.is_object() {
        return Err(fail("INVALID_SETTINGS"));
    }
    Ok(value)
}
pub fn load(path: &Path) -> Result<Option<Config>> {
    document(path)?
        .get("cloudBackup")
        .map(|v| {
            let config: Config =
                serde_json::from_value(v.clone()).map_err(|_| fail("INVALID_SETTINGS"))?;
            Binding::checked(&config.connection)?;
            config.options.check()?;
            Ok(config)
        })
        .transpose()
}
pub fn save(path: &Path, config: &Config) -> Result<()> {
    Binding::checked(&config.connection)?;
    config.options.check()?;
    let mut value = document(path)?;
    value["cloudBackup"] = serde_json::to_value(config).map_err(|_| fail("INVALID_SETTINGS"))?;
    let bytes = serde_json::to_vec_pretty(&value).map_err(|_| fail("INVALID_SETTINGS"))?;
    if bytes.len() > 512 * 1024 {
        return Err(fail("INVALID_SETTINGS"));
    }
    let parent = path.parent().ok_or_else(|| fail("SETTINGS_IO"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|_| fail("SETTINGS_IO"))?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
/// Write before activation: inability to persist the gate must prevent switching.
pub fn suspend(path: &Path) -> Result<()> {
    if let Some(mut config) = load(path)? {
        config.automatic_enabled = false;
        config.requires_confirmation = true;
        save(path, &config)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_are_local_preserve_pairing_and_suspend_durably() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"chromeExtensionId":"kept"}"#).unwrap();
        let config = Config {
            connection: ConnectionDescriptor {
                connection_id: uuid::Uuid::new_v4().to_string(),
                endpoint: "https://dav.jianguoyun.com/dav/".into(),
                username: "synthetic".into(),
            },
            options: Options::default(),
            automatic_enabled: true,
            requires_confirmation: false,
        };
        save(&path, &config).unwrap();
        assert_eq!(document(&path).unwrap()["chromeExtensionId"], "kept");
        assert!(backup::exclude::portable_settings(&fs::read_to_string(&path).unwrap()).is_none());
        suspend(&path).unwrap();
        let restored = load(&path).unwrap().unwrap();
        assert!(!restored.automatic_enabled && restored.requires_confirmation);
        assert_eq!(
            restored.connection.connection_id,
            config.connection.connection_id
        );
        fs::write(&path, "broken").unwrap();
        assert!(suspend(&path).is_err());
        assert!(save(&path, &config).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken");
    }
}
