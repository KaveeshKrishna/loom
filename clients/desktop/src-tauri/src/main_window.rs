//! The main window: Loom's own web page, signed in with this PC, with the
//! page bridge (bridge.rs).
//!
//! When Loom can't be reached (offline, or restarting during an update) the
//! window shows the app's "Can't reach Loom" screen instead of a browser or
//! proxy error page. That screen checks every few seconds and brings Loom
//! back by itself, at the folder you were in. A page that failed to load is
//! reloaded the next time the window is opened, so it never stays stuck.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::bridge::{self, Incoming, Navigation};
use crate::{AppRef, VERSION};

/// The main window when it's on screen: the app's other windows open in
/// front of it and stay attached to it (an owned window on Windows).
pub fn visible_main(a: &AppRef) -> Option<WebviewWindow> {
    a.handle.get_webview_window("main").filter(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
}

/// One of the app's own pages (tauri://localhost, or http://tauri.localhost on Windows).
pub fn is_app_page(u: &url::Url) -> bool {
    u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
}

/// The address of one of the app's own pages, e.g. `index.html#/offline`.
fn app_url(route: &str) -> url::Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    url::Url::parse(base).and_then(|b| b.join(route)).expect("app page address")
}

/// Show Loom itself, signed in. `path` = a folder to open.
pub fn show_main(a: &AppRef, path: Option<String>) {
    let healthy_page = a
        .handle
        .get_webview_window("main")
        .filter(|w| !w.url().map(|u| is_app_page(&u)).unwrap_or(true) && !a.page_failed.load(Ordering::SeqCst));
    if let Some(w) = healthy_page {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(p) = path {
            let _ = w.eval(bridge::event_js("loomapp:navigate", &serde_json::json!({ "path": p })));
        }
        return;
    }
    // No window yet, or it shows an error or the offline screen: load Loom (again).
    reload_main(a, path);
}

/// Load Loom in the main window (again), signed in, at `path` or the folder
/// that was last open.
pub fn reload_main(a: &AppRef, path: Option<String>) {
    let a = a.clone();
    tauri::async_runtime::spawn(async move {
        let Some(server) = a.server() else { return };
        let path = path.or_else(|| a.last_folder.lock().unwrap().clone());
        let next = match &path {
            Some(p) if !p.is_empty() => format!("/files/{}", p.split('/').map(|s| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>().replace('+', "%20")).collect::<Vec<_>>().join("/")),
            _ => "/files".to_string(),
        };
        // Sign the window in with this device (reuses its session if it has one).
        let url = match a.engine().map(|e| e.api().clone()) {
            Some(api) => match api.web_login().await {
                Ok(p) => format!("{server}{p}&next={}", url::form_urlencoded::byte_serialize(next.as_bytes()).collect::<String>()),
                Err(loom_engine::Error::Transient(e)) => {
                    tracing::warn!("Loom isn't reachable ({e})");
                    show_offline(&a);
                    return;
                }
                Err(e) => {
                    tracing::warn!("web sign-in link failed ({e}); opening Loom directly");
                    format!("{server}{next}")
                }
            },
            None => format!("{server}{next}"),
        };
        open_main_at(&a, &url);
    });
}

/// "Can't reach Loom" in the main window. It checks by itself and brings Loom back.
pub fn show_offline(a: &AppRef) {
    let Some(server) = a.server() else { return };
    a.page_ready.store(false, Ordering::SeqCst);
    let route = format!("index.html#/offline?server={}", url::form_urlencoded::byte_serialize(server.as_bytes()).collect::<String>());
    match a.handle.get_webview_window("main") {
        Some(w) => {
            if !w.url().map(|u| is_app_page(&u)).unwrap_or(false) {
                let _ = w.navigate(app_url(&route));
            }
            let _ = w.show();
        }
        None => match build_main_window(&a.handle, WebviewUrl::App(route.into()), &server, a.bridge_tx.clone(), a.nav_tx.clone()) {
            Ok(w) => watch_main(a, &w),
            Err(e) => tracing::error!("can't open Loom's window: {e}"),
        },
    }
}

/// The main window on `url` (created if needed).
pub fn open_main_at(a: &AppRef, url: &str) {
    let Ok(parsed) = url::Url::parse(url) else { return };
    a.page_failed.store(false, Ordering::SeqCst);
    if let Some(w) = a.handle.get_webview_window("main") {
        a.page_ready.store(false, Ordering::SeqCst);
        let _ = w.navigate(parsed);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(server) = a.server() else { return };
    a.page_ready.store(false, Ordering::SeqCst);
    match build_main_window(&a.handle, WebviewUrl::External(parsed), &server, a.bridge_tx.clone(), a.nav_tx.clone()) {
        Ok(w) => watch_main(a, &w),
        Err(e) => tracing::error!("can't open Loom's window: {e}"),
    }
}

/// Closing the main window hides it: transfers continue in the tray.
fn watch_main(a: &AppRef, w: &WebviewWindow) {
    let w2 = w.clone();
    let a2 = a.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = w2.hide();
            a2.page_ready.store(false, Ordering::SeqCst);
        }
    });
}

/// The window for Loom's page on `server`, starting at `url`, with the page
/// bridge (also used by the self-tests, so CI checks exactly this).
pub fn build_main_window(
    handle: &AppHandle,
    url: WebviewUrl,
    server: &str,
    tx: tokio::sync::mpsc::UnboundedSender<Incoming>,
    nav_tx: tokio::sync::mpsc::UnboundedSender<Navigation>,
) -> tauri::Result<WebviewWindow> {
    let origin = url::Url::parse(server).map(|u| u.origin().ascii_serialization()).unwrap_or_else(|_| server.to_string());
    let nav_origin = origin.clone();
    let nav_handle = handle.clone();
    let dl_handle = handle.clone();
    let w = WebviewWindowBuilder::new(handle, "main", url)
        .title("Loom")
        .inner_size(1280.0, 820.0)
        .min_inner_size(480.0, 400.0)
        .center()
        // Files dropped on the window go to the page (its drop zones,
        // confirmation and the bridge), not to Tauri.
        .disable_drag_drop_handler()
        .initialization_script(bridge::init_script(&origin, VERSION))
        // Stay on the server (or the app's own offline page); anything else opens in the browser.
        .on_navigation(move |u| {
            if bridge::same_origin(u.as_str(), &nav_origin) || u.scheme() == "about" || is_app_page(u) {
                return true;
            }
            use tauri_plugin_opener::OpenerExt;
            let _ = nav_handle.opener().open_url(u.as_str(), None::<&str>);
            false
        })
        // The browser-style downloads that are left (Download as ZIP).
        .on_download(move |_, event| browser_download(&dl_handle, event))
        .build()?;
    bridge::install(&w, origin, tx, nav_tx)?;
    Ok(w)
}

/// Is Loom at `server` up? (`/api/health` answers "ok")
pub async fn healthy(server: &str) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(5)).build() else { return false };
    match client.get(format!("{server}/api/health")).send().await {
        Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.map(|v| v["status"] == "ok").unwrap_or(false),
        _ => false,
    }
}

/// Follow page loads in the main window: when one fails, check Loom. Down →
/// the offline screen; up → try the page again (twice), else leave it.
pub async fn handle_navigation(a: AppRef, mut rx: tokio::sync::mpsc::UnboundedReceiver<Navigation>) {
    let mut retries = 0u32;
    while let Some(nav) = rx.recv().await {
        let Some(server) = a.server() else { continue };
        if !bridge::same_origin(&nav.url, &server) {
            continue; // the app's own pages
        }
        if !nav.failed() {
            retries = 0;
            a.page_failed.store(false, Ordering::SeqCst);
            continue;
        }
        tracing::warn!(url = %nav.url, status = nav.status, ok = nav.ok, "Loom's page didn't load");
        a.page_ready.store(false, Ordering::SeqCst);
        a.page_failed.store(true, Ordering::SeqCst);
        if !healthy(&server).await {
            show_offline(&a);
        } else if retries < 2 {
            retries += 1;
            tokio::time::sleep(Duration::from_secs(2)).await;
            page_eval(&a, "location.reload()".into());
        }
    }
}

/// A download the page started itself (a ZIP): saved in the download folder
/// without asking, and reported in the page.
fn browser_download(handle: &AppHandle, event: tauri::webview::DownloadEvent<'_>) -> bool {
    use tauri::webview::DownloadEvent;
    let Some(a) = handle.try_state::<AppRef>().map(|s| s.inner().clone()) else { return true };
    match event {
        DownloadEvent::Requested { destination, .. } => {
            let dir = PathBuf::from(a.config.lock().unwrap().settings.download_dir.clone());
            if let Err(e) = std::fs::create_dir_all(&dir) {
                tracing::warn!("can't create {}: {e}", dir.display());
                return true; // WebView2's own choice of folder
            }
            let name = destination.file_name().map(|n| n.to_owned()).unwrap_or_else(|| "Loom download.zip".into());
            *destination = unique_path(&dir.join(name));
            page_toast(&a, "info", &format!("Downloading {}…", file_label(destination)), false);
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            match (success, path) {
                (true, Some(p)) => page_toast(&a, "success", &format!("Saved {} to {}", file_label(&p), p.parent().map(|d| d.display().to_string()).unwrap_or_default()), false),
                _ => page_toast(&a, "error", "The download didn't finish. Try again.", false),
            }
            true
        }
        _ => true,
    }
}

fn file_label(p: &std::path::Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// `name.zip`, or `name (2).zip` … when that's taken.
fn unique_path(p: &std::path::Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..10_000).map(|i| p.with_file_name(format!("{stem} ({i}){ext}"))).find(|c| !c.exists()).unwrap_or_else(|| p.to_path_buf())
}

/// Run `js` in Loom's page (when it's there).
pub fn page_eval(a: &AppRef, js: String) {
    if let Some(w) = a.handle.get_webview_window("main") {
        let _ = w.eval(js);
    }
}

/// A toast in Loom's page; `transfers` adds an "Open Transfers" button.
pub fn page_toast(a: &AppRef, kind: &str, message: &str, transfers: bool) {
    if !a.page_ready.load(Ordering::SeqCst) {
        return;
    }
    let detail = serde_json::json!({ "kind": kind, "message": message, "action": if transfers { Some("transfers") } else { None } });
    page_eval(a, bridge::event_js("loomapp:toast", &detail));
}

/// A file/folder picker in front of the window the user is looking at.
pub fn file_dialog(a: &AppRef) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::DialogExt;
    let d = a.handle.dialog().file();
    match visible_main(a).or_else(|| a.handle.get_webview_window("transfers")) {
        Some(w) => d.set_parent(&w),
        None => d,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_pages() {
        assert!(is_app_page(&app_url("index.html#/offline")));
        assert!(!is_app_page(&url::Url::parse("https://loom.example.com/files").unwrap()));
        assert!(app_url("index.html#/offline?server=x").as_str().ends_with("index.html#/offline?server=x"));
    }

    #[test]
    fn unique_names() {
        let dir = std::env::temp_dir().join(format!("loom-unique-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.zip");
        assert_eq!(unique_path(&p), p);
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(unique_path(&p), dir.join("a (2).zip"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
