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
mod main_window;
mod self_test;
mod updates;
mod windows_shell;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use loom_engine::{BatchId, Engine, Event, OnConflict, ServerConfig, Snapshot, UploadRequest, UploadSource};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

use crate::bridge::{Incoming, Message, Navigation};
pub use crate::main_window::{file_dialog, open_main_at, page_eval, page_toast, reload_main, show_main, visible_main};
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
    pub nav_tx: tokio::sync::mpsc::UnboundedSender<Navigation>,
    /// The last page load in the main window failed (reload it when it's opened)
    pub page_failed: AtomicBool,
    /// The folder last open in Loom's page (to come back to after a reload)
    pub last_folder: Mutex<Option<String>>,
    pub updates: updates::Updates,
    pub pause_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    pub update_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    /// A transfer whose name conflicts the Transfers window should open
    pub review: Mutex<Option<BatchId>>,
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
    let self_test = self_test::args(&argv);
    let mut builder = tauri::Builder::default();
    if self_test.is_none() {
        // First, so a second launch (e.g. "Upload to Loom" on more files)
        // hands its arguments to the running app instead of starting again.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let a = app.state::<AppRef>().inner().clone();
            let paths = upload_args(&argv);
            if paths.is_empty() {
                show_main(&a, None);
            } else {
                queue_upload_paths(&a, paths, None);
            }
        }));
    }
    builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(commands::handler())
        .setup(move |app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_local_data_dir()?;
            init_logging(&data_dir.join("logs"));
            tracing::info!("Loom for Windows {VERSION} starting");
            if let Some((mode, url, report)) = self_test.clone() {
                return self_test::start(&handle, mode, url, report);
            }
            let config_path = config_dir.join("config.json");
            let (a, rx, nav_rx) = new_app(&handle, config_path, data_dir);
            app.manage(a.clone());
            build_tray(&a)?;
            tauri::async_runtime::spawn(handle_bridge(a.clone(), rx));
            tauri::async_runtime::spawn(main_window::handle_navigation(a.clone(), nav_rx));
            tauri::async_runtime::spawn(updates::run(a.clone()));

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
                if let Some(e) = app.try_state::<AppRef>().and_then(|a| a.engine()) {
                    tauri::async_runtime::block_on(e.shutdown());
                }
            }
        });
}

/// The app's state, and the receiving ends of the page's messages and page loads.
pub fn new_app(
    handle: &AppHandle,
    config_path: PathBuf,
    data_dir: PathBuf,
) -> (AppRef, tokio::sync::mpsc::UnboundedReceiver<Incoming>, tokio::sync::mpsc::UnboundedReceiver<Navigation>) {
    let config = Config::load(&config_path);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (nav_tx, nav_rx) = tokio::sync::mpsc::unbounded_channel();
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
        nav_tx,
        page_failed: AtomicBool::new(false),
        last_folder: Mutex::new(None),
        updates: updates::Updates::default(),
        pause_item: Mutex::new(None),
        update_item: Mutex::new(None),
        review: Mutex::new(None),
    });
    (a, rx, nav_rx)
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
        match ev {
            Event::SignedOut => {
                let _ = a.handle.emit("navigate", "transfers");
            }
            // Someone has to choose: open the question right away.
            Event::ConflictsFound { batch_id, .. } => {
                *a.review.lock().unwrap() = Some(batch_id);
                show_transfers(&a, false);
                let _ = a.handle.emit("review", batch_id);
            }
            _ => {}
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
    let builder = || {
        WebviewWindowBuilder::new(&a.handle, label, WebviewUrl::App(format!("index.html#/{route}").into()))
            .title(title)
            .inner_size(size.0, size.1)
            .min_inner_size(min.0, min.1)
            .resizable(resizable)
            .center()
    };
    let attached = match visible_main(a).filter(|_| label != "onboarding") {
        Some(main) => builder().owner(&main).unwrap_or_else(|e| {
            tracing::warn!("can't attach the {label} window to Loom's: {e}");
            builder()
        }),
        None => builder(),
    };
    match attached.build() {
        Ok(w) if label == "transfers" => watch_transfers(a, &w),
        Ok(_) => {}
        Err(e) => tracing::error!("can't open the {label} window: {e}"),
    }
}

pub fn show_transfers(a: &AppRef, settings: bool) {
    close_mini(a);
    if let Some(w) = a.handle.get_webview_window("transfers") {
        let _ = w.unminimize();
    }
    app_window(a, "transfers", if settings { "settings" } else { "transfers" }, "Loom Transfers", (1000.0, 660.0), (760.0, 480.0), true);
    let _ = a.handle.emit("navigate", if settings { "settings" } else { "transfers" });
}

/// Minimizing Transfers turns it into the floating mini bar (an attached
/// window would otherwise shrink into a title-bar stub above the taskbar).
fn watch_transfers(a: &AppRef, w: &WebviewWindow) {
    let a2 = a.clone();
    let w2 = w.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::Resized(_) = e {
            if w2.is_minimized().unwrap_or(false) && w2.is_visible().unwrap_or(false) {
                let _ = w2.hide();
                show_mini(&a2);
            }
        }
    });
}

const MINI_SIZE: (f64, f64) = (360.0, 76.0);

/// The floating mini Transfers bar: small, on top, draggable, no taskbar entry.
pub fn show_mini(a: &AppRef) {
    if let Some(w) = a.handle.get_webview_window("mini") {
        let _ = w.show();
        return;
    }
    let (x, y) = a.config.lock().unwrap().mini_position.unwrap_or_else(|| {
        // Bottom right, above the taskbar.
        a.handle
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| {
                let size = m.size().to_logical::<f64>(m.scale_factor());
                (size.width - MINI_SIZE.0 - 24.0, size.height - MINI_SIZE.1 - 72.0)
            })
            .unwrap_or((40.0, 40.0))
    });
    let built = WebviewWindowBuilder::new(&a.handle, "mini", WebviewUrl::App("index.html#/mini".into()))
        .title("Loom Transfers")
        .inner_size(MINI_SIZE.0, MINI_SIZE.1)
        .position(x, y)
        .decorations(false)
        .shadow(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .build();
    match built {
        Ok(w) => {
            let a2 = a.clone();
            let w2 = w.clone();
            w.on_window_event(move |e| {
                if let WindowEvent::Moved(p) = e {
                    let scale = w2.scale_factor().unwrap_or(1.0);
                    let l = p.to_logical::<f64>(scale);
                    a2.config.lock().unwrap().mini_position = Some((l.x, l.y));
                }
            });
        }
        Err(e) => tracing::error!("can't open the mini Transfers bar: {e}"),
    }
}

/// Close the mini bar (remembering where it was).
pub fn close_mini(a: &AppRef) {
    if let Some(w) = a.handle.get_webview_window("mini") {
        let _ = w.destroy();
        a.save();
    }
}

pub fn show_onboarding(a: &AppRef) {
    app_window(a, "onboarding", "onboarding", "Loom", (460.0, 640.0), (420.0, 560.0), false);
}

pub fn show_destination(a: &AppRef) {
    app_window(a, "destination", "destination", "Upload to Loom", (560.0, 660.0), (480.0, 520.0), true);
    let _ = a.handle.emit("pending-upload", ());
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
    while let Some(Incoming { id, message, paths }) = rx.recv().await {
        // Tell the page it was heard (it falls back to doing it itself if not).
        let result: Result<serde_json::Value, String> = match message {
            Message::Ready => {
                a.page_ready.store(true, Ordering::SeqCst);
                if let Some(e) = a.engine() {
                    push_to_page(&a, &e.snapshot());
                }
                Ok(serde_json::Value::Null)
            }
            Message::UploadFiles { dest_dir, items } => {
                // Decisions were made in the page's conflict dialog; paths come
                // from WebView2 (one per file, in order).
                if paths.len() != items.len() {
                    // Some files have no path on disk: let the page upload them all itself.
                    tracing::warn!(items = items.len(), files = paths.len(), "bridge: files and their details don't match");
                    if let Some(id) = id {
                        page_eval(&a, bridge::ack_js(id, Err("Some of these files aren't on this PC's disk".into())));
                    }
                    continue;
                }
                let sources: Vec<UploadSource> = items
                    .into_iter()
                    .zip(paths)
                    .map(|(it, p)| UploadSource {
                        path: PathBuf::from(p),
                        relative_path: Some(it.relative_path),
                        conflict: OnConflict::parse(&it.conflict).or(Some(OnConflict::KeepBoth)),
                    })
                    .collect();
                if sources.is_empty() {
                    Err("No files came through. Try again, or use Upload files.".to_string())
                } else {
                    // Answer at once: a late answer would make the page upload them itself too.
                    if let Some(id) = id {
                        page_eval(&a, bridge::ack_js(id, Ok(serde_json::json!({ "count": sources.len() }))));
                    }
                    let a2 = a.clone();
                    tauri::async_runtime::spawn(async move {
                        let n = sources.len();
                        match start_upload(&a2, dest_dir.clone(), sources, OnConflict::KeepBoth).await {
                            Ok(()) => page_toast(&a2, "info", &uploading_text(n, &dest_dir), true),
                            Err(e) => {
                                tracing::warn!("upload from the page failed: {e}");
                                page_toast(&a2, "error", &format!("Couldn't start the upload: {e}"), false);
                            }
                        }
                    });
                    continue;
                }
            }
            Message::UploadDropped { dest_dir, items } => {
                // Files and whole folders dropped on the page: their paths come
                // from WebView2, and folders are walked here (like the pickers).
                if paths.len() != items.len() || paths.is_empty() {
                    tracing::warn!(items = items.len(), files = paths.len(), "bridge: dropped items without paths");
                    if let Some(id) = id {
                        page_eval(&a, bridge::ack_js(id, Err("Some of these aren't on this PC's disk".into())));
                    }
                    continue;
                }
                if let Some(id) = id {
                    page_eval(&a, bridge::ack_js(id, Ok(serde_json::json!({ "count": paths.len() }))));
                }
                let a2 = a.clone();
                tauri::async_runtime::spawn(async move {
                    let n = paths.len();
                    let sources = paths.into_iter().map(|p| UploadSource { path: PathBuf::from(p), relative_path: None, conflict: None }).collect();
                    match start_upload(&a2, dest_dir.clone(), sources, OnConflict::Ask).await {
                        Ok(()) => page_toast(&a2, "info", &uploading_text(n, &dest_dir), true),
                        Err(e) => {
                            tracing::warn!("upload of dropped items failed: {e}");
                            page_toast(&a2, "error", &format!("Couldn't start the upload: {e}"), false);
                        }
                    }
                });
                continue;
            }
            Message::PickUpload { dest_dir, mode } => {
                let a2 = a.clone();
                let done = move |picked: Vec<PathBuf>| {
                    let a3 = a2.clone();
                    let dest = dest_dir.clone();
                    tauri::async_runtime::spawn(async move {
                        let n = picked.len();
                        let sources = picked.into_iter().map(|p| UploadSource { path: p, relative_path: None, conflict: None }).collect();
                        match start_upload(&a3, dest.clone(), sources, OnConflict::Ask).await {
                            Ok(()) => page_toast(&a3, "info", &uploading_text(n, &dest), true),
                            Err(e) => {
                                tracing::warn!("upload failed: {e}");
                                page_toast(&a3, "error", &format!("Couldn't start the upload: {e}"), false);
                            }
                        }
                    });
                };
                if mode == "folder" {
                    file_dialog(&a).set_title("Upload a folder to Loom").pick_folder(move |f| {
                        if let Some(p) = f.and_then(|f| f.into_path().ok()) {
                            done(vec![p]);
                        }
                    });
                } else {
                    file_dialog(&a).set_title("Upload files to Loom").pick_files(move |fs| {
                        let picked: Vec<PathBuf> = fs.unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect();
                        if !picked.is_empty() {
                            done(picked);
                        }
                    });
                }
                Ok(serde_json::Value::Null)
            }
            Message::Download { items } => {
                let entries: Vec<loom_engine::RemoteEntry> =
                    items.into_iter().map(|i| loom_engine::RemoteEntry { is_dir: i.kind == "DIRECTORY", path: i.path, name: i.name }).collect();
                // Answer first: "ask where to save" shows a folder picker.
                if let Some(id) = id {
                    page_eval(&a, bridge::ack_js(id, Ok(serde_json::Value::Null)));
                }
                let a2 = a.clone();
                tauri::async_runtime::spawn(async move { commands::download_entries(&a2, entries).await });
                continue;
            }
            Message::OpenTransfers => {
                show_transfers(&a, false);
                Ok(serde_json::Value::Null)
            }
            Message::OpenSettings => {
                show_transfers(&a, true);
                Ok(serde_json::Value::Null)
            }
            Message::SetLocation { path, can_write } => {
                if path.is_some() {
                    a.last_folder.lock().unwrap().clone_from(&path);
                }
                *a.location.lock().unwrap() = if can_write { path } else { None };
                Ok(serde_json::Value::Null)
            }
            Message::SignedOut => {
                commands::sign_out_app(&a).await;
                continue;
            }
            Message::Log { level, message } => {
                match level.as_str() {
                    "error" => tracing::error!("page: {message}"),
                    "warn" => tracing::warn!("page: {message}"),
                    _ => tracing::info!("page: {message}"),
                }
                Ok(serde_json::Value::Null)
            }
        };
        if let Some(id) = id {
            page_eval(&a, bridge::ack_js(id, result));
        }
    }
}

fn uploading_text(n: usize, dest: &str) -> String {
    let to = if dest.is_empty() { "Loom".to_string() } else { dest.rsplit('/').next().unwrap_or(dest).to_string() };
    format!("Uploading {n} item{} to {to}", if n == 1 { "" } else { "s" })
}

// ─── tray ────────────────────────────────────────────────────────────────────

fn build_tray(a: &AppRef) -> tauri::Result<()> {
    let h = &a.handle;
    let open = MenuItem::with_id(h, "open", "Open Loom", true, None::<&str>)?;
    let transfers = MenuItem::with_id(h, "transfers", "Transfers", true, None::<&str>)?;
    let reload = MenuItem::with_id(h, "reload", "Reload Loom", true, None::<&str>)?;
    let upload_files = MenuItem::with_id(h, "upload-files", "Upload files…", true, None::<&str>)?;
    let upload_folder = MenuItem::with_id(h, "upload-folder", "Upload a folder…", true, None::<&str>)?;
    let pause = MenuItem::with_id(h, "pause", "Pause all", true, None::<&str>)?;
    let settings = MenuItem::with_id(h, "settings", "Settings", true, None::<&str>)?;
    let updates = MenuItem::with_id(h, "updates", "Check for updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(h, "quit", "Quit Loom", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(h);
    let menu = Menu::with_items(h, &[&open, &reload, &transfers, &sep()?, &upload_files, &upload_folder, &sep()?, &pause, &settings, &updates, &sep()?, &quit])?;
    *a.pause_item.lock().unwrap() = Some(pause);
    *a.update_item.lock().unwrap() = Some(updates);
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
                "reload" => reload_main(&a, None),
                "transfers" => show_transfers(&a, false),
                "settings" => show_transfers(&a, true),
                "updates" => {
                    if matches!(a.updates.status(), updates::Status::Ready { .. }) {
                        tauri::async_runtime::spawn(async move {
                            let _ = updates::install(&a).await;
                        });
                    } else {
                        show_transfers(&a, true);
                        let a2 = a.clone();
                        tauri::async_runtime::spawn(async move { updates::check(&a2, true).await });
                    }
                }
                "upload-files" | "upload-folder" => {
                    let folder = event.id().as_ref() == "upload-folder";
                    tauri::async_runtime::spawn(async move { commands::pick_for_upload(&a, folder, None).await });
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

/// The tray's update entry follows the update's progress.
pub fn update_tray_for_updates(a: &AppRef, status: &updates::Status) {
    let text = match status {
        updates::Status::Ready { version, .. } => format!("Install Loom {version}"),
        updates::Status::Downloading { version, percent } => format!("Downloading Loom {version} ({percent}%)"),
        updates::Status::Installing { .. } => "Installing the update…".to_string(),
        _ => "Check for updates…".to_string(),
    };
    if let Some(item) = a.update_item.lock().unwrap().as_ref() {
        let _ = item.set_text(text);
    }
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
