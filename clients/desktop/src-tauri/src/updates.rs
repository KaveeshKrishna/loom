//! Updates from GitHub Releases (tauri-plugin-updater, signed packages).
//!
//! The app checks shortly after it starts and every 6 hours, then follows
//! the mode chosen in Settings:
//! - "ask" (default): download in the background, then ask before installing;
//! - "auto": download, and install once no transfers have been running for a
//!   minute (Loom restarts by itself; transfers continue where they were);
//! - "notify": only say that an update exists.
//!
//! The manifest address comes from tauri.conf.json, or from `LOOM_UPDATE_URL`
//! at build time (builds of a fork point it at their own releases).

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::AppRef;

const EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    #[default]
    Idle,
    Checking,
    #[serde(rename_all = "camelCase")]
    UpToDate { checked_at: u64 },
    #[serde(rename_all = "camelCase")]
    Available { version: String, notes: String },
    #[serde(rename_all = "camelCase")]
    Downloading { version: String, percent: u8 },
    #[serde(rename_all = "camelCase")]
    Ready { version: String, notes: String },
    #[serde(rename_all = "camelCase")]
    Installing { version: String },
    #[serde(rename_all = "camelCase")]
    Failed { error: String },
}

#[derive(Default)]
pub struct Updates {
    status: Mutex<Status>,
    found: Mutex<Option<Update>>,
    package: Mutex<Option<Vec<u8>>>,
    busy: tokio::sync::Mutex<()>,
}

impl Updates {
    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
}

fn set(a: &AppRef, status: Status) {
    *a.updates.status.lock().unwrap() = status.clone();
    let _ = a.handle.emit("update-status", &status);
    crate::update_tray_for_updates(a, &status);
}

fn mode(a: &AppRef) -> String {
    a.config.lock().unwrap().settings.update_mode.clone()
}

/// Seconds since 1970 (the screens format it).
fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Background loop: check at start (after a short wait) and every 6 hours;
/// in "auto" mode, install a downloaded update once transfers are idle.
pub async fn run(a: AppRef) {
    tokio::time::sleep(Duration::from_secs(20)).await;
    let mut last_check = None::<std::time::Instant>;
    let mut idle_for = 0u32;
    loop {
        if last_check.map(|t| t.elapsed() >= EVERY).unwrap_or(true) {
            last_check = Some(std::time::Instant::now());
            check(&a, false).await;
        }
        if mode(&a) == "auto" && matches!(a.updates.status(), Status::Ready { .. }) {
            let busy = a.engine().map(|e| {
                let s = e.snapshot();
                s.active + s.queued + s.waiting > 0 && !s.all_paused
            });
            idle_for = if busy.unwrap_or(false) { 0 } else { idle_for + 1 };
            if idle_for >= 2 {
                if let Err(e) = install(&a).await {
                    tracing::warn!("installing the update failed: {e}");
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

fn updater(a: &AppRef) -> Result<tauri_plugin_updater::Updater, String> {
    let mut b = a.handle.updater_builder();
    if let Some(url) = option_env!("LOOM_UPDATE_URL").filter(|u| !u.is_empty()) {
        let url = url::Url::parse(url).map_err(|e| e.to_string())?;
        b = b.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    b.build().map_err(|e| e.to_string())
}

/// Look for an update; download it unless the mode is "notify". `manual`:
/// the user pressed Check now (report "up to date" too, and download even in
/// "notify" mode since they asked).
pub async fn check(a: &AppRef, manual: bool) {
    let Ok(_guard) = a.updates.busy.try_lock() else { return };
    if matches!(a.updates.status(), Status::Ready { .. } | Status::Installing { .. }) {
        return;
    }
    set(a, Status::Checking);
    let found = match updater(a) {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    let update = match found {
        Ok(Some(u)) => u,
        Ok(None) => {
            set(a, Status::UpToDate { checked_at: now() });
            return;
        }
        Err(e) => {
            tracing::warn!("checking for updates failed: {e}");
            set(a, if manual { Status::Failed { error: friendly(&e) } } else { Status::Idle });
            return;
        }
    };
    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();
    tracing::info!("Loom {version} is available");
    *a.updates.found.lock().unwrap() = Some(update);
    if mode(a) == "notify" && !manual {
        set(a, Status::Available { version: version.clone(), notes });
        notify(a, &format!("Loom {version} is available"), "Open Loom's settings to install it.");
        return;
    }
    drop(_guard);
    download(a).await;
}

/// Download the update found by `check`.
pub async fn download(a: &AppRef) {
    let Ok(_guard) = a.updates.busy.try_lock() else { return };
    let Some(update) = a.updates.found.lock().unwrap().clone() else { return };
    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();
    set(a, Status::Downloading { version: version.clone(), percent: 0 });
    let mut got = 0usize;
    let mut last_pct = 0u8;
    let a2 = a.clone();
    let v2 = version.clone();
    let result = update
        .download(
            move |chunk, total| {
                got += chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let pct = ((got as u64 * 100) / total).min(100) as u8;
                    if pct >= last_pct + 5 {
                        last_pct = pct;
                        set(&a2, Status::Downloading { version: v2.clone(), percent: pct });
                    }
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => {
            *a.updates.package.lock().unwrap() = Some(bytes);
            set(a, Status::Ready { version: version.clone(), notes });
            if mode(a) != "auto" {
                notify(a, &format!("Loom {version} is ready to install"), "Install it from Transfers or Settings. Transfers continue afterwards.");
            }
        }
        Err(e) => {
            tracing::warn!("downloading the update failed: {e}");
            set(a, Status::Failed { error: friendly(&e.to_string()) });
        }
    }
}

/// Install the downloaded update: Loom closes, the installer runs without
/// questions, and Loom starts again. Transfers continue from the queue on disk.
pub async fn install(a: &AppRef) -> Result<(), String> {
    if !matches!(a.updates.status(), Status::Ready { .. }) {
        // Not downloaded yet (e.g. "notify" mode): fetch it first.
        download(a).await;
    }
    let Some(update) = a.updates.found.lock().unwrap().clone() else { return Err("No update to install".into()) };
    let Some(bytes) = a.updates.package.lock().unwrap().clone() else { return Err("The update hasn't been downloaded".into()) };
    set(a, Status::Installing { version: update.version.clone() });
    tracing::info!("installing Loom {}", update.version);
    if let Some(e) = a.engine() {
        e.shutdown().await;
    }
    // On Windows this exits the app; the installer starts Loom again.
    update.install(bytes).map_err(|e| {
        let msg = friendly(&e.to_string());
        set(a, Status::Failed { error: msg.clone() });
        msg
    })
}

fn notify(a: &AppRef, title: &str, body: &str) {
    let _ = a.handle.notification().builder().title(title).body(body).show();
}

fn friendly(e: &str) -> String {
    if e.contains("signature") {
        "The update's signature didn't match, so it wasn't installed.".into()
    } else if e.contains("error sending request") || e.contains("dns") || e.contains("connect") {
        "Couldn't reach GitHub to check for updates.".into()
    } else {
        format!("Updating didn't work: {e}")
    }
}

/// What Settings shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub mode: String,
    pub status: Status,
}

pub fn info(a: &AppRef) -> UpdateInfo {
    UpdateInfo { current: crate::VERSION.into(), mode: mode(a), status: a.updates.status() }
}
