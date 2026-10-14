//! Storage for user-provided API keys. Keys are write-only from the frontend's
//! point of view: they can be set, cleared, or checked for presence, but are
//! only ever read back inside the backend when calling the provider.

const SERVICE: &str = "com.virtualvoice.app.tts";

#[cfg(windows)]
mod imp {
    use super::SERVICE;

    fn entry(name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
    }

    pub fn get(name: &str) -> Result<Option<String>, String> {
        match entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        entry(name)?.set_password(value).map_err(|e| e.to_string())
    }

    pub fn delete(name: &str) -> Result<(), String> {
        match entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Non-Windows builds are only used for development, so a plain file in the
/// config directory is acceptable there.
#[cfg(not(windows))]
mod imp {
    use super::SERVICE;
    use std::collections::BTreeMap;

    fn path() -> std::path::PathBuf {
        crate::get_config_dir().join(format!("{SERVICE}.secrets.json"))
    }

    fn load() -> BTreeMap<String, String> {
        std::fs::read_to_string(path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn store(map: &BTreeMap<String, String>) -> Result<(), String> {
        let p = path();
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
        std::fs::write(&p, json).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn get(name: &str) -> Result<Option<String>, String> {
        Ok(load().get(name).cloned())
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        let mut map = load();
        map.insert(name.to_string(), value.to_string());
        store(&map)
    }

    pub fn delete(name: &str) -> Result<(), String> {
        let mut map = load();
        map.remove(name);
        store(&map)
    }
}

pub use imp::{delete, get, set};
