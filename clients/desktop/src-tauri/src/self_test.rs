//! `Loom.exe --bridge-self-test <url> <report-file>`: checks, in a real
//! WebView2, that a page on <url> gets `window.LoomApp` and that its messages
//! reach the app and the app's answers reach the page. It opens the main
//! window exactly as the app does (`build_main_window`); CI serves
//! clients/desktop/self-test/bridge.html, which drives the page side.
//!
//! Exit code 0 = everything arrived; the report file says what happened.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::{AppHandle, WebviewWindow};

use crate::bridge::{self, Incoming, Message};

/// What the page must send before it reports success.
const EXPECTED: &[&str] = &["ready", "openTransfers", "openSettings", "pickUpload", "download", "setLocation", "log"];

/// `(url, report file)` when started with `--bridge-self-test`.
pub fn args(argv: &[String]) -> Option<(String, PathBuf)> {
    let i = argv.iter().position(|a| a == "--bridge-self-test")?;
    let url = argv.get(i + 1)?.clone();
    let report = argv.get(i + 2).map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("loom-bridge-self-test.txt"));
    Some((url, report))
}

pub fn start(handle: &AppHandle, url: String, report: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let parsed = url::Url::parse(&url)?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let window = crate::build_main_window(handle, parsed, tx)?;
    tauri::async_runtime::spawn(drive(handle.clone(), window, rx, report));
    Ok(())
}

async fn drive(handle: AppHandle, window: WebviewWindow, mut rx: tokio::sync::mpsc::UnboundedReceiver<Incoming>, report: PathBuf) {
    let started = Instant::now();
    let mut log = vec![format!("bridge self-test on {}", window.url().map(|u| u.to_string()).unwrap_or_default())];
    let mut seen = BTreeSet::new();
    let deadline = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(deadline);
    let code = loop {
        tokio::select! {
            _ = &mut deadline => {
                log.push("FAIL: timed out waiting for the page".into());
                break 2;
            }
            msg = rx.recv() => {
                let Some(Incoming { id, message, paths }) = msg else { break 3 };
                log.push(format!("{:>6} ms  {} id={id:?} files={}", started.elapsed().as_millis(), message.kind(), paths.len()));
                seen.insert(message.kind());
                let mut outcome = None;
                match &message {
                    Message::Ready => {
                        let detail = serde_json::json!({ "active": 1, "queued": 0, "paused": 0, "failed": 0, "bytesDone": 1, "bytesTotal": 2, "bytesPerSecond": 0, "via": null });
                        let _ = window.eval(bridge::event_js("loomapp:transfers", &detail));
                    }
                    Message::Log { message, .. } if message.starts_with("self-test: fail") => {
                        log.push(format!("FAIL (page): {message}"));
                        outcome = Some(1);
                    }
                    Message::Log { message, .. } if message == "self-test: pass" => {
                        let missing: Vec<_> = EXPECTED.iter().filter(|k| !seen.contains(*k)).collect();
                        if missing.is_empty() {
                            log.push("PASS".into());
                            outcome = Some(0);
                        } else {
                            log.push(format!("FAIL: never received {missing:?}"));
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
    let text = log.join("\n") + "\n";
    eprint!("{text}");
    if let Err(e) = std::fs::write(&report, &text) {
        eprintln!("can't write {}: {e}", report.display());
    }
    handle.exit(code);
}

#[cfg(test)]
mod tests {
    #[test]
    fn arguments() {
        let argv: Vec<String> = ["Loom.exe", "--bridge-self-test", "http://127.0.0.1:1/b.html", "C:\\r.txt"].iter().map(|s| s.to_string()).collect();
        let (url, report) = super::args(&argv).unwrap();
        assert_eq!(url, "http://127.0.0.1:1/b.html");
        assert_eq!(report.to_string_lossy(), "C:\\r.txt");
        assert!(super::args(&["Loom.exe".to_string()]).is_none());
    }
}
