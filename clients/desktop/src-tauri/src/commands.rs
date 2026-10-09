//! Commands for the app's own windows (ui/src/lib/ipc.ts). Not available to
//! Loom's web page, which only has the bridge (bridge.rs).

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use loom_engine::{BatchId, BatchView, ConflictView, ItemId, ItemView, OnConflict, RemoteEntry, Snapshot, UploadSource};
use serde::Serialize;
use sha2::Digest;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::config::{secret, AppSettings, UserInfo};
use crate::{AppRef, VERSION};

type R<T> = Result<T, String>;

fn engine(a: &AppRef) -> R<loom_engine::Engine> {
    a.engine().ok_or_else(|| "Not signed in to Loom".to_string())
}

pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app_state, check_server, start_pairing, cancel_pairing, sign_out, snapshot, batches, items, conflicts, decide, pause, resume, cancel, retry,
        remove_batch, clear_finished, pick_upload, list_folder, create_folder, pending_upload, confirm_upload, cancel_pending_upload,
        recent_destinations, settings, set_settings, choose_download_dir, open_main, open_transfers, reveal, open_logs, close_window, take_review,
        server_status, reload_loom, close_mini, update_info, check_updates, install_update
    ]
}

// ─── account ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    configured: bool,
    server_url: Option<String>,
    server_version: Option<String>,
    user: Option<UserInfo>,
    device_name: String,
    version: String,
}

#[tauri::command]
fn app_state(a: State<AppRef>) -> AppState {
    let c = a.config.lock().unwrap();
    AppState {
        configured: c.device_id.is_some() && a.engine().is_some(),
        server_url: c.server_url.clone(),
        server_version: c.server_version.clone(),
        user: c.user.clone(),
        device_name: c.device_name.clone(),
        version: VERSION.into(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCheck {
    ok: bool,
    url: String,
    version: Option<String>,
    error: Option<String>,
}

/// "loom.example.com" → "https://loom.example.com" (no path, no trailing slash).
fn normalize_url(input: &str) -> Option<String> {
    let s = input.trim();
    let with_scheme = if s.contains("://") { s.to_string() } else { format!("https://{s}") };
    let u = url::Url::parse(&with_scheme).ok()?;
    if !matches!(u.scheme(), "https" | "http") || u.host_str().is_none() {
        return None;
    }
    Some(u.origin().ascii_serialization())
}

#[tauri::command]
async fn check_server(url: String) -> ServerCheck {
    let Some(url) = normalize_url(&url) else {
        return ServerCheck { ok: false, url, version: None, error: Some("That isn't a web address.".into()) };
    };
    let fail = |url: &str, e: &str| ServerCheck { ok: false, url: url.to_string(), version: None, error: Some(e.to_string()) };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap();
    let res = match client.get(format!("{url}/api/client/info")).send().await {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => return fail(&url, "Can't reach that address. Check it, and that this PC is online."),
        Err(e) => return fail(&url, &format!("Couldn't connect: {e}")),
    };
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return fail(&url, "This Loom is too old for the app. Update Loom to 2.2 or later.");
    }
    let Ok(info) = res.json::<serde_json::Value>().await else { return fail(&url, "There's no Loom at that address.") };
    if info.get("product").and_then(|p| p.as_str()) != Some("loom") {
        return fail(&url, "There's no Loom at that address.");
    }
    let version = info.get("version").and_then(|v| v.as_str()).map(String::from);
    ServerCheck { ok: true, url, version, error: None }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    check_code: String,
}

/// Ask Loom to pair this PC, open the approval page in Loom's window, and
/// wait (in the background) for the user to allow it. The token is made
/// here; Loom only ever sees its hash.
#[tauri::command]
async fn start_pairing(a: State<'_, AppRef>, url: String, device_name: String) -> R<Pairing> {
    let a = a.inner().clone();
    let url = normalize_url(&url).ok_or("That isn't a web address.")?;
    let mut raw = [0u8; 32];
    rand::Rng::fill(&mut rand::thread_rng(), &mut raw);
    let token = format!("loomd_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw));
    let token_hash = hex::encode(sha2::Sha256::digest(token.as_bytes()));
    let name = if device_name.trim().is_empty() { crate::config::default_device_name() } else { device_name.trim().to_string() };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap();
    let res = client
        .post(format!("{url}/api/devices/pair/start"))
        .json(&serde_json::json!({ "name": name, "platform": "windows", "appVersion": VERSION, "tokenHash": token_hash }))
        .send()
        .await
        .map_err(|e| format!("Can't reach Loom: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(body.get("error").and_then(|e| e.as_str()).unwrap_or("Loom refused the request").to_string());
    }
    let pair_id = body["pairId"].as_str().unwrap_or_default().to_string();
    let secret_str = body["secret"].as_str().unwrap_or_default().to_string();
    let check_code = body["checkCode"].as_str().unwrap_or_default().to_string();
    let approve = format!("{url}{}", body["approvePath"].as_str().unwrap_or_default());
    {
        let mut c = a.config.lock().unwrap();
        c.server_url = Some(url.clone());
        c.device_name = name;
    }
    crate::open_main_at(&a, &approve);
    // Keep the check code in view next to the approval page.
    on_top(&a, true);

    if let Some(old) = a.pairing.lock().unwrap().take() {
        old.abort();
    }
    let a2 = a.clone();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let res = client.post(format!("{url}/api/devices/pair/poll")).json(&serde_json::json!({ "pairId": pair_id, "secret": secret_str })).send().await;
            let Ok(res) = res else { continue };
            let code = res.status().as_u16();
            let body: serde_json::Value = res.json().await.unwrap_or_default();
            match (code, body.get("status").and_then(|s| s.as_str())) {
                (200, Some("approved")) => {
                    {
                        let mut c = a2.config.lock().unwrap();
                        c.device_id = body["device"]["id"].as_str().map(String::from);
                        c.user = Some(UserInfo {
                            name: body["user"]["name"].as_str().unwrap_or_default().into(),
                            email: body["user"]["email"].as_str().unwrap_or_default().into(),
                        });
                        c.save(&a2.config_path);
                    }
                    if !secret::set(&url, &token) {
                        tracing::error!("couldn't store the device token");
                        on_top(&a2, false);
                        let _ = a2.handle.emit("pairing", "error");
                        return;
                    }
                    crate::start_engine(&a2).await;
                    crate::apply_windows_settings(&a2);
                    on_top(&a2, false);
                    let _ = a2.handle.emit("pairing", "approved");
                    // The approval page is done; show Loom.
                    if let Some(w) = a2.handle.get_webview_window("main") {
                        let _ = w.eval("location.href = '/files'");
                    }
                    return;
                }
                (200, _) => {}
                (403, _) => {
                    on_top(&a2, false);
                    let _ = a2.handle.emit("pairing", "denied");
                    return;
                }
                (404 | 410, _) => {
                    on_top(&a2, false);
                    let _ = a2.handle.emit("pairing", "expired");
                    return;
                }
                _ => {}
            }
        }
    });
    *a.pairing.lock().unwrap() = Some(task);
    Ok(Pairing { check_code })
}

#[tauri::command]
fn cancel_pairing(a: State<AppRef>) {
    if let Some(t) = a.pairing.lock().unwrap().take() {
        t.abort();
    }
    on_top(a.inner(), false);
}

/// The sign-in window above everything while it waits for approval.
fn on_top(a: &AppRef, yes: bool) {
    if let Some(w) = a.handle.get_webview_window("onboarding") {
        let _ = w.set_always_on_top(yes);
    }
}

/// Unpair: tell Loom (best effort), forget the token, back to sign-in.
pub async fn sign_out_app(a: &AppRef) {
    let engine = a.engine.lock().unwrap().take();
    if let Some(e) = engine {
        let _ = e.api().sign_out().await;
        e.shutdown().await;
    }
    if let Some(server) = a.server() {
        secret::delete(&server);
    }
    {
        let mut c = a.config.lock().unwrap();
        c.device_id = None;
        c.user = None;
        c.save(&a.config_path);
    }
    for label in ["main", "transfers", "destination"] {
        if let Some(w) = a.handle.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
    crate::show_onboarding(a);
}

#[tauri::command]
async fn sign_out(a: State<'_, AppRef>) -> R<()> {
    sign_out_app(a.inner()).await;
    Ok(())
}

// ─── transfers ───────────────────────────────────────────────────────────────

#[tauri::command]
fn snapshot(a: State<AppRef>) -> Snapshot {
    a.engine().map(|e| e.snapshot()).unwrap_or_default()
}

#[tauri::command]
fn batches(a: State<AppRef>, include_finished: bool) -> R<Vec<BatchView>> {
    engine(&a)?.batches(include_finished).map_err(|e| e.to_string())
}

#[tauri::command]
fn items(a: State<AppRef>, batch_id: BatchId, offset: i64, limit: i64) -> R<Vec<ItemView>> {
    engine(&a)?.items(batch_id, offset, limit.min(2000)).map_err(|e| e.to_string())
}

#[tauri::command]
fn conflicts(a: State<AppRef>, batch_id: BatchId) -> R<Vec<ConflictView>> {
    engine(&a)?.conflicts(batch_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn decide(a: State<AppRef>, batch_id: BatchId, item_id: Option<ItemId>, decision: String) -> R<usize> {
    let d = OnConflict::parse(&decision).ok_or("Unknown decision")?;
    engine(&a)?.decide(batch_id, item_id, d).map_err(|e| e.to_string())
}

#[tauri::command]
fn pause(a: State<AppRef>, batch_id: Option<BatchId>) -> R<()> {
    engine(&a)?.pause(batch_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn resume(a: State<AppRef>, batch_id: Option<BatchId>) -> R<()> {
    engine(&a)?.resume(batch_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel(a: State<'_, AppRef>, batch_id: BatchId, item_id: Option<ItemId>) -> R<()> {
    engine(&a)?.cancel(batch_id, item_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn retry(a: State<AppRef>, batch_id: Option<BatchId>, item_id: Option<ItemId>) -> R<usize> {
    engine(&a)?.retry(batch_id, item_id).map_err(|e| e.to_string())
}

/// A transfer with name conflicts to ask about now (once).
#[tauri::command]
fn take_review(a: State<AppRef>) -> Option<BatchId> {
    a.review.lock().unwrap().take()
}

#[tauri::command]
fn remove_batch(a: State<AppRef>, batch_id: BatchId) -> R<()> {
    engine(&a)?.remove_batch(batch_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_finished(a: State<AppRef>) -> R<usize> {
    engine(&a)?.clear_finished().map_err(|e| e.to_string())
}

// ─── uploading from the app ──────────────────────────────────────────────────

/// Pick files or a folder, then ask where in Loom (the folder open in Loom's
/// window is suggested).
pub async fn pick_for_upload(a: &AppRef, folder: bool, over: Option<tauri::WebviewWindow>) {
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<PathBuf>>();
    let d = match over {
        Some(w) => a.handle.dialog().file().set_parent(&w),
        None => crate::file_dialog(a),
    };
    if folder {
        d.set_title("Upload a folder to Loom").pick_folder(move |f| {
            let _ = tx.send(f.and_then(|f| f.into_path().ok()).into_iter().collect());
        });
    } else {
        d.set_title("Upload files to Loom").pick_files(move |fs| {
            let _ = tx.send(fs.unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect());
        });
    }
    let picked = rx.await.unwrap_or_default();
    if !picked.is_empty() {
        let here = a.location.lock().unwrap().clone();
        crate::queue_upload_paths(a, picked, here);
    }
}

#[tauri::command]
async fn pick_upload(a: State<'_, AppRef>, window: tauri::WebviewWindow, kind: String) -> R<()> {
    pick_for_upload(a.inner(), kind == "folder", Some(window)).await;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    path: String,
    folders: Vec<Folder>,
    can_write: bool,
}

#[tauri::command]
async fn list_folder(a: State<'_, AppRef>, path: String) -> R<FolderListing> {
    let l = engine(&a)?.api().list(&path).await.map_err(|e| e.to_string())?;
    let mut folders: Vec<Folder> = l.children.into_iter().filter(|n| n.is_dir()).map(|n| Folder { name: n.name, path: n.relative_path }).collect();
    folders.sort_by_key(|f| f.name.to_lowercase());
    Ok(FolderListing { path, folders, can_write: l.can_write })
}

#[tauri::command]
async fn create_folder(a: State<'_, AppRef>, parent: String, name: String) -> R<String> {
    let name = name.trim().to_string();
    engine(&a)?.api().mkdir(&parent, &name).await.map_err(|e| e.to_string())?;
    Ok(if parent.is_empty() { name } else { format!("{parent}/{name}") })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpload {
    names: Vec<String>,
    count: usize,
    dest_dir: Option<String>,
}

#[tauri::command]
fn pending_upload(a: State<AppRef>) -> Option<PendingUpload> {
    let p = a.pending.lock().unwrap();
    if p.paths.is_empty() {
        return None;
    }
    let names = p.paths.iter().take(5).map(|x| x.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).collect();
    let dest = p.dest.clone().or_else(|| a.config.lock().unwrap().recent_destinations.first().cloned());
    Some(PendingUpload { names, count: p.paths.len(), dest_dir: dest })
}

#[tauri::command]
async fn confirm_upload(a: State<'_, AppRef>, dest_dir: String, on_conflict: String) -> R<()> {
    let a = a.inner().clone();
    let paths = std::mem::take(&mut a.pending.lock().unwrap().paths);
    let policy = OnConflict::parse(&on_conflict).unwrap_or(OnConflict::Ask);
    let n = paths.len();
    let sources = paths.into_iter().map(|p| UploadSource { path: p, relative_path: None, conflict: None }).collect();
    crate::start_upload(&a, dest_dir.clone(), sources, policy).await?;
    if let Some(w) = a.handle.get_webview_window("destination") {
        let _ = w.close();
    }
    use tauri_plugin_notification::NotificationExt;
    let to = if dest_dir.is_empty() { "Loom".to_string() } else { dest_dir.rsplit('/').next().unwrap_or("").to_string() };
    let _ = a
        .handle
        .notification()
        .builder()
        .title(format!("Uploading {n} item{} to {to}", if n == 1 { "" } else { "s" }))
        .body("It continues in the background. Open Transfers to follow it.")
        .show();
    Ok(())
}

#[tauri::command]
fn cancel_pending_upload(a: State<AppRef>) {
    a.pending.lock().unwrap().paths.clear();
    if let Some(w) = a.handle.get_webview_window("destination") {
        let _ = w.close();
    }
}

#[tauri::command]
fn recent_destinations(a: State<AppRef>) -> Vec<String> {
    a.config.lock().unwrap().recent_destinations.clone()
}

// ─── downloads ───────────────────────────────────────────────────────────────

pub async fn download_entries(a: &AppRef, entries: Vec<RemoteEntry>) {
    let Some(engine) = a.engine() else {
        crate::page_toast(a, "error", "This PC isn't signed in to Loom. Open Transfers to sign in.", true);
        return;
    };
    let s = a.config.lock().unwrap().settings.clone();
    let dir = if s.ask_download_dir {
        let (tx, rx) = tokio::sync::oneshot::channel();
        crate::file_dialog(a).set_title("Save to").pick_folder(move |f| {
            let _ = tx.send(f.and_then(|f| f.into_path().ok()));
        });
        match rx.await.ok().flatten() {
            Some(d) => d,
            None => return,
        }
    } else {
        PathBuf::from(&s.download_dir)
    };
    let what = match entries.as_slice() {
        [one] => one.name.clone(),
        many => format!("{} items", many.len()),
    };
    match engine.download(loom_engine::DownloadRequest { entries, local_dir: dir.clone(), title: None }).await {
        Ok(_) => crate::page_toast(a, "info", &format!("Downloading {what} to {}", dir.display()), true),
        Err(e) => {
            tracing::warn!("download failed to start: {e}");
            crate::page_toast(a, "error", &format!("Couldn't start the download: {e}"), false);
        }
    }
}

#[tauri::command]
async fn choose_download_dir(a: State<'_, AppRef>, window: tauri::WebviewWindow) -> R<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    a.handle.dialog().file().set_parent(&window).set_title("Save downloads to").pick_folder(move |f| {
        let _ = tx.send(f.and_then(|f| f.into_path().ok()));
    });
    Ok(rx.await.ok().flatten().map(|p| p.to_string_lossy().into_owned()))
}

// ─── settings ────────────────────────────────────────────────────────────────

#[tauri::command]
fn settings(a: State<AppRef>) -> AppSettings {
    a.config.lock().unwrap().settings.clone()
}

#[tauri::command]
fn set_settings(a: State<AppRef>, settings: AppSettings) {
    let a = a.inner().clone();
    {
        let mut c = a.config.lock().unwrap();
        c.settings = settings.clone();
        c.save(&a.config_path);
    }
    if let Some(e) = a.engine() {
        e.set_settings(crate::engine_settings(&settings));
    }
    crate::apply_windows_settings(&a);
}

// ─── windows and files ───────────────────────────────────────────────────────

#[tauri::command]
fn open_main(a: State<AppRef>, path: Option<String>) {
    crate::show_main(a.inner(), path);
}

#[tauri::command]
fn open_transfers(a: State<AppRef>) {
    crate::show_transfers(a.inner(), false);
}

#[tauri::command]
fn reveal(a: State<AppRef>, path: String) -> R<()> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        a.handle.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
    } else {
        a.handle.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn open_logs(a: State<AppRef>) -> R<()> {
    let dir = a.data_dir.join("logs");
    a.handle.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Is Loom answering? (the offline screen asks every few seconds)
#[tauri::command]
async fn server_status(a: State<'_, AppRef>) -> R<bool> {
    let Some(server) = a.server() else { return Ok(false) };
    Ok(crate::main_window::healthy(&server).await)
}

/// Load Loom in the main window again (offline screen, tray).
#[tauri::command]
fn reload_loom(a: State<AppRef>) {
    crate::reload_main(a.inner(), None);
}

/// The mini bar's Close: it and the minimized Transfers window go away.
#[tauri::command]
fn close_mini(a: State<AppRef>) {
    crate::close_mini(a.inner());
    if let Some(w) = a.handle.get_webview_window("transfers") {
        if !w.is_visible().unwrap_or(true) {
            let _ = w.destroy();
        }
    }
}

#[tauri::command]
fn update_info(a: State<AppRef>) -> crate::updates::UpdateInfo {
    crate::updates::info(a.inner())
}

#[tauri::command]
async fn check_updates(a: State<'_, AppRef>) -> R<crate::updates::UpdateInfo> {
    let a = a.inner().clone();
    crate::updates::check(&a, true).await;
    Ok(crate::updates::info(&a))
}

#[tauri::command]
async fn install_update(a: State<'_, AppRef>) -> R<()> {
    crate::updates::install(a.inner()).await
}

/// Close the calling window (sign-in "Open Loom" also shows Loom).
#[tauri::command]
fn close_window(a: State<AppRef>, window: tauri::Window) {
    if window.label() == "onboarding" {
        crate::show_main(a.inner(), None);
    }
    let _ = window.close();
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn server_addresses() {
        assert_eq!(normalize_url("loom.example.com").as_deref(), Some("https://loom.example.com"));
        assert_eq!(normalize_url(" https://loom.example.com/files/ ").as_deref(), Some("https://loom.example.com"));
        assert_eq!(normalize_url("http://192.168.0.10:8085").as_deref(), Some("http://192.168.0.10:8085"));
        assert_eq!(normalize_url("ftp://x"), None);
        assert_eq!(normalize_url("https://"), None);
    }
}
