//! Self-tests that CI runs against the installed app, in a real WebView2:
//!
//! `Loom.exe --bridge-self-test <url> <report-file>`
//!   A page on <url> (self-test/bridge.html) gets `window.LoomApp`, its
//!   messages reach the app and the app's answers reach the page. Then a
//!   real file-and-folder drop (through the DevTools protocol, the way
//!   Windows hands a drop to the page) must arrive with the right paths.
//!
//! `Loom.exe --offline-self-test <base-url> <report-file>`
//!   self-test/server.py pretends Loom is down: the window must show the
//!   app's "Can't reach Loom" screen, then come back to Loom by itself once
//!   the server is up again.
//!
//! `Loom.exe --update-self-test <unused> <report-file>`
//!   Checks for an update the way the app does, downloads it, verifies its
//!   signature and installs it (CI serves a newer signed build locally and
//!   then checks the installed version changed).
//!
//! The first two open the main window exactly as the app does
//! (`build_main_window`, `show_main`). Exit code 0 = passed; the report file
//! says what happened.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};

use crate::bridge::{self, Incoming, Message};

/// What the page must send before it reports success.
const EXPECTED: &[&str] = &["ready", "openTransfers", "openSettings", "pickUpload", "download", "setLocation", "uploadDropped", "log"];

#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
    Bridge,
    Offline,
    Update,
}

/// `(mode, url, report file)` when started with a self-test flag.
pub fn args(argv: &[String]) -> Option<(Mode, String, PathBuf)> {
    let (i, mode) = argv.iter().enumerate().find_map(|(i, a)| match a.as_str() {
        "--bridge-self-test" => Some((i, Mode::Bridge)),
        "--offline-self-test" => Some((i, Mode::Offline)),
        "--update-self-test" => Some((i, Mode::Update)),
        _ => None,
    })?;
    let url = argv.get(i + 1)?.clone();
    let report = argv.get(i + 2).map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("loom-self-test.txt"));
    Some((mode, url, report))
}

pub fn start(handle: &AppHandle, mode: Mode, url: String, report: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    match mode {
        Mode::Bridge => {
            let parsed = url::Url::parse(&url)?;
            let origin = parsed.origin().ascii_serialization();
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let (nav_tx, _nav_rx) = tokio::sync::mpsc::unbounded_channel();
            let window = crate::main_window::build_main_window(handle, WebviewUrl::External(parsed), &origin, tx, nav_tx)?;
            tauri::async_runtime::spawn(bridge_test(handle.clone(), window, rx, report));
        }
        Mode::Offline => {
            // A throwaway config: never the user's own.
            let dir = std::env::temp_dir().join(format!("loom-offline-self-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir)?;
            let base = url.trim_end_matches('/').to_string();
            std::fs::write(dir.join("config.json"), serde_json::json!({ "serverUrl": base, "deviceName": "Self-test" }).to_string())?;
            let (a, rx, nav_rx) = crate::new_app(handle, dir.join("config.json"), dir.clone());
            handle.manage(a.clone());
            tauri::async_runtime::spawn(crate::main_window::handle_navigation(a.clone(), nav_rx));
            tauri::async_runtime::spawn(offline_test(a, base, rx, report));
        }
        Mode::Update => {
            let dir = std::env::temp_dir().join(format!("loom-update-self-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir)?;
            let (a, _rx, _nav_rx) = crate::new_app(handle, dir.join("config.json"), dir.clone());
            handle.manage(a.clone());
            tauri::async_runtime::spawn(update_test(a, report));
        }
    }
    Ok(())
}

struct Log {
    started: Instant,
    lines: Vec<String>,
}

impl Log {
    fn new(first: String) -> Log {
        Log { started: Instant::now(), lines: vec![first] }
    }
    fn add(&mut self, s: impl Into<String>) {
        self.lines.push(format!("{:>6} ms  {}", self.started.elapsed().as_millis(), s.into()));
    }
    fn finish(self, handle: &AppHandle, report: &PathBuf, code: i32) {
        let text = self.lines.join("\n") + "\n";
        eprint!("{text}");
        if let Err(e) = std::fs::write(report, &text) {
            eprintln!("can't write {}: {e}", report.display());
        }
        handle.exit(code);
    }
}

/// Files and a folder to drop on the page.
fn drop_fixture() -> std::io::Result<(PathBuf, Vec<PathBuf>)> {
    let dir = std::env::temp_dir().join(format!("loom-drop-self-test-{}", std::process::id()));
    let folder = dir.join("Trip");
    std::fs::create_dir_all(folder.join("day 1"))?;
    std::fs::write(folder.join("day 1").join("a.txt"), b"hello")?;
    let file = dir.join("notes.txt");
    std::fs::write(&file, b"notes")?;
    Ok((dir, vec![folder, file]))
}

/// Same path, as Windows spells it (case, separators, \\?\ prefixes aside).
fn same_path(a: &str, b: &std::path::Path) -> bool {
    let norm = |s: &str| s.trim_start_matches(r"\\?\").replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(&b.to_string_lossy())
}

async fn bridge_test(handle: AppHandle, window: WebviewWindow, mut rx: tokio::sync::mpsc::UnboundedReceiver<Incoming>, report: PathBuf) {
    let mut log = Log::new(format!("bridge self-test on {}", window.url().map(|u| u.to_string()).unwrap_or_default()));
    let mut seen = BTreeSet::new();
    let deadline = tokio::time::sleep(Duration::from_secs(90));
    tokio::pin!(deadline);
    let mut dropped: Option<Vec<PathBuf>> = None;
    let code = loop {
        tokio::select! {
            _ = &mut deadline => {
                log.add("FAIL: timed out waiting for the page");
                break 2;
            }
            msg = rx.recv() => {
                let Some(Incoming { id, message, paths }) = msg else { break 3 };
                log.add(format!("{} id={id:?} files={}", message.kind(), paths.len()));
                seen.insert(message.kind());
                let mut outcome = None;
                match &message {
                    Message::Ready => {
                        let detail = serde_json::json!({ "active": 1, "queued": 0, "paused": 0, "failed": 0, "bytesDone": 1, "bytesTotal": 2, "bytesPerSecond": 0, "via": null });
                        let _ = window.eval(bridge::event_js("loomapp:transfers", &detail));
                    }
                    Message::Log { message, .. } if message.starts_with("self-test: drop at ") => {
                        // The page is ready for a drop on its drop zone.
                        let xy: Vec<f64> = message.trim_start_matches("self-test: drop at ").split(',').filter_map(|v| v.trim().parse().ok()).collect();
                        match (drop_fixture(), xy.as_slice()) {
                            (Ok((_, items)), [x, y]) => {
                                let files: Vec<String> = items.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                                let data = serde_json::json!({ "items": [], "files": files, "dragOperationsMask": 1 });
                                for kind in ["dragEnter", "dragOver", "drop"] {
                                    let r = bridge::devtools(&window, "Input.dispatchDragEvent", serde_json::json!({ "type": kind, "x": x, "y": y, "data": data })).await;
                                    log.add(format!("devtools {kind}: {:?}", r.ok()));
                                }
                                dropped = Some(items);
                            }
                            (Err(e), _) => log.add(format!("can't make the drop fixture: {e}")),
                            _ => log.add(format!("bad drop position: {message}")),
                        }
                    }
                    Message::UploadDropped { items, .. } => {
                        let names: Vec<String> = items.iter().map(|i| format!("{} ({})", i.name, i.kind)).collect();
                        log.add(format!("dropped: {names:?} paths: {paths:?}"));
                        let expected = dropped.clone().unwrap_or_default();
                        let ok = !expected.is_empty()
                            && paths.len() == expected.len()
                            && expected.iter().all(|e| paths.iter().any(|p| same_path(p, e)))
                            && items.iter().any(|i| i.name == "Trip" && i.kind == "folder");
                        if !ok {
                            log.add(format!("FAIL: expected the paths {expected:?}"));
                            outcome = Some(1);
                        }
                    }
                    Message::Log { message, .. } if message.starts_with("self-test: fail") => {
                        log.add(format!("FAIL (page): {message}"));
                        outcome = Some(1);
                    }
                    Message::Log { message, .. } if message == "self-test: pass" => {
                        let missing: Vec<_> = EXPECTED.iter().filter(|k| !seen.contains(*k)).collect();
                        if missing.is_empty() {
                            log.add("PASS");
                            outcome = Some(0);
                        } else {
                            log.add(format!("FAIL: never received {missing:?}"));
                            outcome = Some(1);
                        }
                    }
                    _ => {}
                }
                if let Some(id) = id {
                    let _ = window.eval(bridge::ack_js(id, Ok(serde_json::json!({ "selfTest": true }))));
                }
                if let Some(code) = outcome {
                    break code;
                }
            }
        }
    };
    // The report's last line is what CI looks for.
    if code == 0 {
        log.lines.push("PASS".into());
    }
    log.finish(&handle, &report, code);
}

async fn offline_test(a: crate::AppRef, base: String, mut rx: tokio::sync::mpsc::UnboundedReceiver<Incoming>, report: PathBuf) {
    let handle = a.handle.clone();
    let mut log = Log::new(format!("offline self-test against {base}"));
    let main_url = || a.handle.get_webview_window("main").and_then(|w| w.url().ok());
    crate::show_main(&a, None);
    // 1. Loom is "down": the window must switch to the offline screen.
    let until = Instant::now() + Duration::from_secs(45);
    loop {
        if main_url().map(|u| crate::main_window::is_app_page(&u)).unwrap_or(false) {
            log.add(format!("offline screen shown ({})", main_url().map(|u| u.to_string()).unwrap_or_default()));
            break;
        }
        if Instant::now() > until {
            log.add(format!("FAIL: no offline screen; the window shows {:?}", main_url().map(|u| u.to_string())));
            return log.finish(&handle, &report, 1);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // 2. Bring the server up; the offline screen must notice and load Loom again.
    match reqwest::get(format!("{base}/__up")).await {
        Ok(r) => log.add(format!("server up: {}", r.status())),
        Err(e) => {
            log.add(format!("FAIL: can't reach the test server: {e}"));
            return log.finish(&handle, &report, 1);
        }
    }
    let deadline = tokio::time::sleep(Duration::from_secs(45));
    tokio::pin!(deadline);
    let code = loop {
        tokio::select! {
            _ = &mut deadline => {
                log.add(format!("FAIL: Loom didn't come back; the window shows {:?}", main_url().map(|u| u.to_string())));
                break 1;
            }
            msg = rx.recv() => {
                let Some(Incoming { message, .. }) = msg else { break 3 };
                log.add(format!("{} from {:?}", message.kind(), main_url().map(|u| u.to_string())));
                if matches!(message, Message::Ready) && main_url().map(|u| bridge::same_origin(u.as_str(), &base)).unwrap_or(false) {
                    log.add("back on Loom");
                    log.add("PASS");
                    break 0;
                }
            }
        }
    };
    log.finish(&handle, &report, code);
}

async fn update_test(a: crate::AppRef, report: PathBuf) {
    use crate::updates::{self, Status};
    let handle = a.handle.clone();
    let mut log = Log::new(format!("update self-test from {}", crate::VERSION));
    updates::check(&a, true).await;
    let status = a.updates.status();
    log.add(format!("after checking: {status:?}"));
    if !matches!(status, Status::Ready { .. }) {
        log.add("FAIL: no update was downloaded");
        return log.finish(&handle, &report, 1);
    }
    log.add("installing (Loom exits now; the installer starts the new version)");
    log.add("PASS");
    let text = log.lines.join("\n") + "\n";
    let _ = std::fs::write(&report, &text);
    if let Err(e) = updates::install(&a).await {
        log.add(format!("FAIL: {e}"));
        log.finish(&handle, &report, 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments() {
        let argv: Vec<String> = ["Loom.exe", "--bridge-self-test", "http://127.0.0.1:1/b.html", "C:\\r.txt"].iter().map(|s| s.to_string()).collect();
        let (mode, url, report) = args(&argv).unwrap();
        assert_eq!(mode, Mode::Bridge);
        assert_eq!(url, "http://127.0.0.1:1/b.html");
        assert_eq!(report.to_string_lossy(), "C:\\r.txt");
        let argv: Vec<String> = ["Loom.exe", "--offline-self-test", "http://127.0.0.1:2"].iter().map(|s| s.to_string()).collect();
        assert_eq!(args(&argv).unwrap().0, Mode::Offline);
        let argv: Vec<String> = ["Loom.exe", "--update-self-test", "-", "r.txt"].iter().map(|s| s.to_string()).collect();
        assert_eq!(args(&argv).unwrap().0, Mode::Update);
        assert!(args(&["Loom.exe".to_string()]).is_none());
    }

    #[test]
    fn paths_compare_like_windows() {
        assert!(same_path(r"C:\Users\A\Temp\Trip", std::path::Path::new(r"c:\users\a\temp\Trip\")));
        assert!(same_path(r"\\?\C:\x\notes.txt", std::path::Path::new(r"C:\x\notes.txt")));
        assert!(!same_path(r"C:\x\a.txt", std::path::Path::new(r"C:\x\b.txt")));
    }
}
