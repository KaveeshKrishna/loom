//! What the app remembers: which Loom, this device, settings. The device
//! token itself lives in Windows Credential Manager (see `secret`), never in
//! this file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub parallel_files: usize,
    pub parallel_chunks: usize,
    pub speed_limit: u64,
    pub use_lan: bool,
    pub keep_awake: bool,
    pub start_at_login: bool,
    pub explorer_menu: bool,
    pub send_to: bool,
    pub download_dir: String,
    pub ask_download_dir: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        let downloads = dirs::download_dir().unwrap_or_else(|| PathBuf::from(".")).join("Loom");
        AppSettings {
            parallel_files: 3,
            parallel_chunks: 2,
            speed_limit: 0,
            use_lan: true,
            keep_awake: true,
            start_at_login: true,
            explorer_menu: true,
            send_to: true,
            download_dir: downloads.to_string_lossy().into_owned(),
            ask_download_dir: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub server_url: Option<String>,
    pub server_version: Option<String>,
    pub device_id: Option<String>,
    pub device_name: String,
    pub user: Option<UserInfo>,
    pub settings: AppSettings,
    pub recent_destinations: Vec<String>,
    /// Remembered so the LAN address works even before the first refresh.
    pub instance_id: Option<String>,
    pub lan: Option<loom_engine::LanConfig>,
}

impl Config {
    pub fn load(path: &Path) -> Config {
        let mut c: Config = std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        if c.device_name.is_empty() {
            c.device_name = default_device_name();
        }
        c
    }

    /// Written to a temp file and renamed, so a crash never leaves half a file.
    pub fn save(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(self).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    pub fn remember_destination(&mut self, dir: &str) {
        self.recent_destinations.retain(|d| d != dir);
        self.recent_destinations.insert(0, dir.to_string());
        self.recent_destinations.truncate(8);
    }
}

pub fn default_device_name() -> String {
    std::env::var("COMPUTERNAME").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "Windows PC".into())
}

/// The device token, kept by the operating system's credential store.
pub mod secret {
    const SERVICE: &str = "Loom";

    fn account(server: &str) -> String {
        format!("device-token:{server}")
    }

    #[cfg(windows)]
    pub fn get(server: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, &account(server)).ok()?.get_password().ok()
    }

    #[cfg(windows)]
    pub fn set(server: &str, token: &str) -> bool {
        keyring::Entry::new(SERVICE, &account(server)).and_then(|e| e.set_password(token)).is_ok()
    }

    #[cfg(windows)]
    pub fn delete(server: &str) {
        if let Ok(e) = keyring::Entry::new(SERVICE, &account(server)) {
            let _ = e.delete_credential();
        }
    }

    // Elsewhere (development builds on Linux/macOS): a file only this user can read.
    #[cfg(not(windows))]
    fn file(server: &str) -> std::path::PathBuf {
        use sha2::Digest;
        let name = hex::encode(&sha2::Sha256::digest(account(server).as_bytes())[..8]);
        dirs::config_dir().unwrap_or_default().join("loom-desktop").join(format!("{SERVICE}-{name}.token"))
    }

    #[cfg(not(windows))]
    pub fn get(server: &str) -> Option<String> {
        std::fs::read_to_string(file(server)).ok()
    }

    #[cfg(not(windows))]
    pub fn set(server: &str, token: &str) -> bool {
        use std::os::unix::fs::PermissionsExt;
        let f = file(server);
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        std::fs::write(&f, token).is_ok() && std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).is_ok()
    }

    #[cfg(not(windows))]
    pub fn delete(server: &str) {
        let _ = std::fs::remove_file(file(server));
    }
}
