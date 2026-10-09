//! Loom for Windows.
//!
//! - The main window shows Loom itself (your server's web UI), signed in with
//!   this device; uploads and downloads started there go to the transfer
//!   engine (bridge.rs), which keeps going with the window closed, resumes
//!   after a restart and goes straight to the server over the home network.
//! - The app's own windows (ui/): Transfers (+ Settings), sign-in, and the
//!   folder picker for File Explorer's "Upload to Loom" / "Send to".
//! - It lives in the notification area; closing the main window hides it.

mod bridge;
mod commands;
mod config;
mod windows_shell;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use loom_engine::{Engine, Event, OnConflict, ServerConfig, Snapshot, UploadRequest, UploadSource};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

use crate::bridge::{Incoming, Message};
use crate::config::{secret, AppSettings, Config};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Files from File Explorer / Send to / the tray, waiting for a destination.
#[derive(Default)]
pub struct Pending {
    pub paths: Vec<PathBuf>,
    pub dest: Option<String>,
    pub started: Option<Instant>,
}

pub struct App {
    pub handle: AppHandle,
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
    pub config: Mutex<Config>,
    pub engine: Mutex<Option<Engine>>,
    pub pending: Mutex<Pending>,
    pub pairing: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub page_ready: AtomicBool,
    pub location: Mutex<Option<String>>,
    pub awake: windows_shell::Awake,
    pub bridge_tx: tokio::sync::mpsc::UnboundedSender<Incoming>,
    pub pause_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

pub type AppRef = Arc<App>;

impl App {
    pub fn engine(&self) -> Option<Engine> {
        self.engine.lock().unwrap().clone()
    }

    pub fn save(&self) {
        self.config.lock().unwrap().save(&self.config_path);
    }

    pub fn server(&self) -> Option<String> {
        self.config.lock().unwrap().server_url.clone()
    }
}

pub fn engine_settings(s: &AppSettings) -> loom_engine::Settings {
    loom_engine::Settings {
        parallel_files: s.parallel_files.clamp(1, 8),
        parallel_chunks: s.parallel_chunks.clamp(1, 4),
        speed_limit: s.speed_limit,
        use_lan: s.use_lan,
        ..loom_engine::Settings::default()
    }
}

fn user_agent() -> String {
    format!("LoomDesktop/{VERSION} (Windows)")
}

// ─── startup ─────────────────────────────────────────────────────────────────

fn init_logging(dir: &std::path::Path) {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let _ = std::fs::create_dir_all(dir);
    let file = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("loom")
        .filename_suffix("log")
        .max_log_files(7)
        .build(dir)
        .ok();
    let filter = EnvFilter::try_from_env("LOOM_LOG").unwrap_or_else(|_| EnvFilter::new("info,loom_engine=info,reqwest=warn,hyper=warn"));
    let registry = tracing_subscriber::registry().with(filter).with(fmt::layer().with_writer(std::io::stderr));
    if let Some(file) = file {
        let _ = registry.with(fmt::layer().with_ansi(false).with_writer(file)).try_init();
    } else {
        let _ = registry.try_init();
    }
}

/// Paths after `--upload` on the command line (File Explorer, Send to).
fn upload_args(argv: &[String]) -> Vec<PathBuf> {
    match argv.iter().position(|a| a == "--upload") {
        Some(i) => argv[i + 1..].iter().filter(|a| !a.starts_with("--")).map(PathBuf::from).collect(),
        None => Vec::new(),
    }
}

pub fn run() {
    let argv: Vec<String> = std::env::args().collect();
    tauri::Builder::default()
        // First, so a second launch (e.g. "Upload to Loom" on more files)
        // hands its arguments to the running app instead of starting again.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let a = app.state::<AppRef>().inner().clone();
            let paths = upload_args(&argv);
            if paths.is_empty() {
                show_main(&a, None);
            } else {
                queue_upload_paths(&a, paths, None);
            }
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(commands::handler())
        .setup(move |app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_local_data_dir()?;
            init_logging(&data_dir.join("logs"));
            tracing::info!("Loom for Windows {VERSION} starting");
            let config_path = config_dir.join("config.json");
            let config = Config::load(&config_path);
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let a = Arc::new(App {
                handle: handle.clone(),
                config_path,
                data_dir,
                config: Mutex::new(config),
                engine: Mutex::new(None),
                pending: Mutex::new(Pending::default()),
                pairing: Mutex::new(None),
                page_ready: AtomicBool::new(false),
                location: Mutex::new(None),
                awake: windows_shell::Awake::start(),
                bridge_tx: tx,
                pause_item: Mutex::new(None),
            });
            app.manage(a.clone());
            build_tray(&a)?;
            tauri::async_runtime::spawn(handle_bridge(a.clone(), rx));

            let hidden = argv.iter().any(|x| x == "--hidden");
            let uploads = upload_args(&argv);
            let configured = a.server().is_some() && a.config.lock().unwrap().device_id.is_some();
            let a2 = a.clone();
            tauri::async_runtime::spawn(async move {
                if configured && start_engine(&a2).await {
                    apply_windows_settings(&a2);
                    if !uploads.is_empty() {
                        queue_upload_paths(&a2, uploads, None);
                    } else if !hidden {
                        show_main(&a2, None);
                    }
                } else {
                    show_onboarding(&a2);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Loom failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                // Closing the last window keeps Loom running in the tray;
                // only Quit (code = Some) really exits.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::Exit = event {
                if let Some(e) = app.state::<AppRef>().engine() {
                    tauri::async_runtime::block_on(e.shutdown());
                }
            }
        });
}

// ─── the engine ──────────────────────────────────────────────────────────────

/// Start transfers with the saved device token. False when there's none.
pub async fn start_engine(a: &AppRef) -> bool {
    let (server, settings, instance_id, lan) = {
        let c = a.config.lock().unwrap();
        (c.server_url.clone(), c.settings.clone(), c.instance_id.clone(), c.lan.clone())
    };
    let Some(server) = server else { return false };
    let Some(token) = secret::get(&server) else {
        tracing::warn!("no device token stored for {server}");
        return false;
    };
    let cfg = ServerConfig { public_url: server, token, instance_id, lan };
    let engine = match Engine::start(a.data_dir.join("transfers.db"), cfg, engine_settings(&settings), &user_agent()) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!("can't start transfers: {e}");
            return false;
        }
    };
    *a.engine.lock().unwrap() = Some(engine.clone());
    tauri::async_runtime::spawn(forward_snapshots(a.clone(), engine.clone()));
    tauri::async_runtime::spawn(forward_events(a.clone(), engine.clone()));
    // Refresh who we are and the server's version (shown in Settings).
    let a2 = a.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if let Ok(info) = engine.api().client_info().await {
            let mut c = a2.config.lock().unwrap();
            c.server_version = Some(info.version);
            if let Some(u) = info.user {
                c.user = Some(config::UserInfo { name: u.name, email: u.email });
            }
            let api_cfg = engine.api().config();
            c.instance_id = api_cfg.instance_id;
            c.lan = api_cfg.lan;
            c.save(&a2.config_path);
        }
    });
    true
}

/// The transfer summary for Loom's page (its progress pill).
fn push_to_page(a: &AppRef, snap: &Snapshot) {
    if !a.page_ready.load(Ordering::SeqCst) {
        return;
    }
    if let Some(w) = a.handle.get_webview_window("main") {
        let detail = serde_json::json!({
            "active": snap.active, "queued": snap.queued + snap.waiting, "paused": snap.paused, "failed": snap.failed + snap.conflicts,
            "bytesDone": snap.bytes_done, "bytesTotal": snap.bytes_total, "bytesPerSecond": snap.bytes_per_second, "via": snap.via,
        });
        let _ = w.eval(bridge::event_js("loomapp:transfers", &detail));
    }
}

async fn forward_snapshots(a: AppRef, engine: Engine) {
    let mut rx = engine.subscribe();
    loop {
        let snap: Snapshot = rx.borrow_and_update().clone();
        let busy = snap.active + snap.queued + snap.waiting > 0 && !snap.all_paused;
        let _ = a.handle.emit("snapshot", &snap);
        push_to_page(&a, &snap);
        a.awake.set(busy && a.config.lock().unwrap().settings.keep_awake);
        update_tray(&a, &snap);
        if rx.changed().await.is_err() {
            break;
        }
    }
}

async fn forward_events(a: AppRef, engine: Engine) {
    let mut rx = engine.events();
    while let Ok(ev) = rx.recv().await {
        let _ = a.handle.emit("engine-event", &ev);
        let (title, body) = match &ev {
            Event::BatchFinished { title, direction, done, failed, .. } => {
                let verb = if *direction == loom_engine::Direction::Upload { "Uploaded" } else { "Downloaded" };
                if *failed > 0 {
                    (format!("{title}: {failed} file{} failed", if *failed == 1 { "" } else { "s" }), "Open Transfers to retry them.".to_string())
                } else {
                    (format!("{verb} {title}"), format!("{done} file{}", if *done == 1 { "" } else { "s" }))
                }
            }
            Event::ConflictsFound { count, .. } => (
                format!("{count} file{} already in Loom", if *count == 1 { " is" } else { "s are" }),
                "Choose whether to replace, skip or keep both.".to_string(),
            ),
            Event::SignedOut => ("This PC was signed out of Loom".into(), "Sign in again to continue your transfers.".into()),
            Event::DiskFull => ("Loom's drive is full".into(), "Uploads are paused until there's space again.".into()),
            Event::ScanFinished { .. } => continue,
        };
        let _ = a.handle.notification().builder().title(title).body(body).show();
        if matches!(ev, Event::SignedOut) {
            let _ = a.handle.emit("navigate", "transfers");
        }
    }
}

// ─── windows ─────────────────────────────────────────────────────────────────

fn app_window(a: &AppRef, label: &str, route: &str, title: &str, size: (f64, f64), min: (f64, f64), resizable: bool) {
    if let Some(w) = a.handle.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(&a.handle, label, WebviewUrl::App(format!("index.html#/{route}").into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        .resizable(resizable)
        .center()
        .build();
    if let Err(e) = built {
        tracing::error!("can't open the {label} window: {e}");
    }
}

pub fn show_transfers(a: &AppRef, settings: bool) {
    app_window(a, "transfers", if settings { "settings" } else { "transfers" }, "Loom Transfers", (1000.0, 660.0), (760.0, 480.0), true);
    if settings {
        let _ = a.handle.emit("navigate", "settings");
    }
}

pub fn show_onboarding(a: &AppRef) {
    app_window(a, "onboarding", "onboarding", "Loom", (460.0, 640.0), (420.0, 560.0), false);
}

pub fn show_destination(a: &AppRef) {
    app_window(a, "destination", "destination", "Upload to Loom", (560.0, 660.0), (480.0, 520.0), true);
    let _ = a.handle.emit("pending-upload", ());
}

/// Show Loom itself, signed in. `path` = a folder to open.
pub fn show_main(a: &AppRef, path: Option<String>) {
    let offline = a.handle.get_webview_window("main").and_then(|w| w.url().ok()).map(|u| is_app_page(&u)).unwrap_or(false);
    if let Some(w) = a.handle.get_webview_window("main").filter(|_| !offline) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(p) = path {
            let _ = w.eval(bridge::event_js("loomapp:navigate", &serde_json::json!({ "path": p })));
        }
        return;
    }
    let a = a.clone();
    tauri::async_runtime::spawn(async move {
        let Some(server) = a.server() else { return };
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
                    show_offline(&a, &server);
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

/// One of the app's own pages (tauri://localhost, or http://tauri.localhost on Windows).
fn is_app_page(u: &url::Url) -> bool {
    u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
}

/// "Can't reach Loom" in the main window (an app page; Try again calls show_main).
fn show_offline(a: &AppRef, server: &str) {
    let route = format!("index.html#/offline?server={}", url::form_urlencoded::byte_serialize(server.as_bytes()).collect::<String>());
    if let Some(w) = a.handle.get_webview_window("main") {
        // An existing window may be on Loom (and fine); only replace an error.
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(&a.handle, "main", WebviewUrl::App(route.into()))
        .title("Loom")
        .inner_size(1280.0, 820.0)
        .min_inner_size(480.0, 400.0)
        .center()
        .build();
    if let Err(e) = built {
        tracing::error!("can't open Loom's window: {e}");
    }
}

/// The main window on `url` (created if needed), with the page bridge.
pub fn open_main_at(a: &AppRef, url: &str) {
    if let Some(w) = a.handle.get_webview_window("main") {
        // The offline page is an app page without the bridge: replace the window.
        if w.url().map(|u| is_app_page(&u)).unwrap_or(false) {
            let _ = w.destroy();
            return open_main_at(a, url);
        }
        if let Ok(u) = url::Url::parse(url) {
            let _ = w.navigate(u);
        }
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(server) = a.server() else { return };
    let Ok(parsed) = url::Url::parse(url) else { return };
    let origin = parsed.origin().ascii_serialization();
    a.page_ready.store(false, Ordering::SeqCst);
    let handle = a.handle.clone();
    let nav_origin = origin.clone();
    let built = WebviewWindowBuilder::new(&a.handle, "main", WebviewUrl::External(parsed))
        .title("Loom")
        .inner_size(1280.0, 820.0)
        .min_inner_size(480.0, 400.0)
        .center()
        .initialization_script(bridge::init_script(&origin, VERSION))
        // Stay on the server; anything else opens in the browser.
        .on_navigation(move |u| {
            if bridge::same_origin(u.as_str(), &nav_origin) || u.scheme() == "about" {
                return true;
            }
            use tauri_plugin_opener::OpenerExt;
            let _ = handle.opener().open_url(u.as_str(), None::<&str>);
            false
        })
        .build();
    let w: WebviewWindow = match built {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("can't open Loom's window: {e}");
            return;
        }
    };
    if let Err(e) = bridge::install(&w, server, a.bridge_tx.clone()) {
        tracing::error!("page bridge: {e}");
    }
    let w2 = w.clone();
    let a2 = a.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            // Keep running in the tray: transfers continue.
            api.prevent_close();
            let _ = w2.hide();
            a2.page_ready.store(false, Ordering::SeqCst);
        }
    });
}

// ─── uploads from outside the page ───────────────────────────────────────────

/// Files from File Explorer / Send to (several launches in a row become one
/// upload), or from a picker: ask where they go.
pub fn queue_upload_paths(a: &AppRef, paths: Vec<PathBuf>, dest: Option<String>) {
    if a.engine().is_none() {
        show_onboarding(a);
        return;
    }
    {
        let mut p = a.pending.lock().unwrap();
        let fresh = p.started.map(|t| t.elapsed() > Duration::from_secs(20)).unwrap_or(true) && a.handle.get_webview_window("destination").is_none();
        if fresh {
            *p = Pending { paths: Vec::new(), dest, started: Some(Instant::now()) };
        }
        for path in paths {
            if !p.paths.contains(&path) {
                p.paths.push(path);
            }
        }
    }
    show_destination(a);
}

pub async fn start_upload(a: &AppRef, dest: String, sources: Vec<UploadSource>, on_conflict: OnConflict) -> Result<(), String> {
    let Some(engine) = a.engine() else { return Err("Not signed in".into()) };
    if sources.is_empty() {
        return Ok(());
    }
    engine.upload(UploadRequest { dest_dir: dest.clone(), sources, on_conflict, title: None }).await.map_err(|e| e.to_string())?;
    let mut c = a.config.lock().unwrap();
    c.remember_destination(&dest);
    c.save(&a.config_path);
    Ok(())
}

// ─── the page bridge ─────────────────────────────────────────────────────────

async fn handle_bridge(a: AppRef, mut rx: tokio::sync::mpsc::UnboundedReceiver<Incoming>) {
    use tauri_plugin_dialog::DialogExt;
    while let Some(Incoming { message, paths }) = rx.recv().await {
        match message {
            Message::Ready => {
                a.page_ready.store(true, Ordering::SeqCst);
                if let Some(e) = a.engine() {
                    push_to_page(&a, &e.snapshot());
                }
            }
            Message::UploadFiles { dest_dir, items } => {
                // Decisions were made in the page's conflict dialog; paths come
                // from WebView2 (one per file, in order).
                let sources: Vec<UploadSource> = items
                    .into_iter()
                    .zip(paths)
                    .map(|(it, p)| UploadSource {
                        path: PathBuf::from(p),
                        relative_path: Some(it.relative_path),
                        conflict: OnConflict::parse(&it.conflict).or(Some(OnConflict::KeepBoth)),
                    })
                    .collect();
                if let Err(e) = start_upload(&a, dest_dir, sources, OnConflict::KeepBoth).await {
                    tracing::warn!("upload from the page failed: {e}");
                }
            }
            Message::PickUpload { dest_dir, mode } => {
                let a2 = a.clone();
                let done = move |picked: Vec<PathBuf>| {
                    let a3 = a2.clone();
                    let dest = dest_dir.clone();
                    tauri::async_runtime::spawn(async move {
                        let sources = picked.into_iter().map(|p| UploadSource { path: p, relative_path: None, conflict: None }).collect();
                        if let Err(e) = start_upload(&a3, dest, sources, OnConflict::Ask).await {
                            tracing::warn!("upload failed: {e}");
                        }
                    });
                };
                if mode == "folder" {
                    a.handle.dialog().file().set_title("Upload a folder to Loom").pick_folder(move |f| {
                        if let Some(p) = f.and_then(|f| f.into_path().ok()) {
                            done(vec![p]);
                        }
                    });
                } else {
                    a.handle.dialog().file().set_title("Upload files to Loom").pick_files(move |fs| {
                        let picked: Vec<PathBuf> = fs.unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect();
                        if !picked.is_empty() {
                            done(picked);
                        }
                    });
                }
            }
            Message::Download { items } => {
                let entries: Vec<loom_engine::RemoteEntry> =
                    items.into_iter().map(|i| loom_engine::RemoteEntry { is_dir: i.kind == "DIRECTORY", path: i.path, name: i.name }).collect();
                commands::download_entries(&a, entries).await;
            }
            Message::OpenTransfers => show_transfers(&a, false),
            Message::SetLocation { path, can_write } => {
                *a.location.lock().unwrap() = if can_write { path } else { None };
            }
            Message::SignedOut => commands::sign_out_app(&a).await,
        }
    }
}

// ─── tray ────────────────────────────────────────────────────────────────────

fn build_tray(a: &AppRef) -> tauri::Result<()> {
    let h = &a.handle;
    let open = MenuItem::with_id(h, "open", "Open Loom", true, None::<&str>)?;
    let transfers = MenuItem::with_id(h, "transfers", "Transfers", true, None::<&str>)?;
    let upload_files = MenuItem::with_id(h, "upload-files", "Upload files…", true, None::<&str>)?;
    let upload_folder = MenuItem::with_id(h, "upload-folder", "Upload a folder…", true, None::<&str>)?;
    let pause = MenuItem::with_id(h, "pause", "Pause all", true, None::<&str>)?;
    let settings = MenuItem::with_id(h, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(h, "quit", "Quit Loom", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(h);
    let menu = Menu::with_items(h, &[&open, &transfers, &sep()?, &upload_files, &upload_folder, &sep()?, &pause, &settings, &sep()?, &quit])?;
    *a.pause_item.lock().unwrap() = Some(pause);
    let icon = h.default_window_icon().cloned().ok_or_else(|| tauri::Error::AssetNotFound("icon".into()))?;
    TrayIconBuilder::with_id("tray")
        .icon(icon)
        .tooltip("Loom")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let a = app.state::<AppRef>().inner().clone();
            match event.id().as_ref() {
                "open" => show_main(&a, None),
                "transfers" => show_transfers(&a, false),
                "settings" => show_transfers(&a, true),
                "upload-files" | "upload-folder" => {
                    let folder = event.id().as_ref() == "upload-folder";
                    tauri::async_runtime::spawn(async move { commands::pick_for_upload(&a, folder).await });
                }
                "pause" => {
                    if let Some(e) = a.engine() {
                        let _ = if e.snapshot().all_paused { e.resume(None) } else { e.pause(None) };
                    }
                }
                "quit" => {
                    let h = a.handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(e) = a.engine() {
                            e.shutdown().await;
                        }
                        h.exit(0);
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let a = tray.app_handle().state::<AppRef>().inner().clone();
                show_main(&a, None);
            }
        })
        .build(h)?;
    Ok(())
}

fn update_tray(a: &AppRef, s: &Snapshot) {
    let tip = if s.signed_out {
        "Loom: signed out".to_string()
    } else if s.offline {
        "Loom: can't reach the server".to_string()
    } else if s.all_paused {
        "Loom: paused".to_string()
    } else if s.active + s.queued > 0 && s.bytes_total > 0 {
        let pct = (s.bytes_done as f64 / s.bytes_total as f64 * 100.0).floor();
        format!("Loom: {pct}% · {} left", s.active + s.queued)
    } else {
        "Loom".to_string()
    };
    if let Some(t) = a.handle.tray_by_id("tray") {
        let _ = t.set_tooltip(Some(tip));
    }
    if let Some(p) = a.pause_item.lock().unwrap().as_ref() {
        let _ = p.set_text(if s.all_paused { "Resume all" } else { "Pause all" });
    }
}

// ─── settings that touch Windows ─────────────────────────────────────────────

pub fn apply_windows_settings(a: &AppRef) {
    use tauri_plugin_autostart::ManagerExt;
    let s = a.config.lock().unwrap().settings.clone();
    if let Err(e) = windows_shell::set_explorer_menu(s.explorer_menu) {
        tracing::warn!("Explorer menu: {e}");
    }
    if let Err(e) = windows_shell::set_send_to(s.send_to) {
        tracing::warn!("Send to: {e}");
    }
    let al = a.handle.autolaunch();
    let on = al.is_enabled().unwrap_or(false);
    if s.start_at_login && !on {
        let _ = al.enable();
    } else if !s.start_at_login && on {
        let _ = al.disable();
    }
}
