//! The bridge between Loom's web page (in the main window) and the app.
//!
//! The page talks to us through WebView2's own message channel
//! (`chrome.webview.postMessage`), not Tauri's IPC: the remote page gets no
//! Tauri permissions at all. Every message is checked to come from the
//! configured server's origin. Files the user drops or picks in the page
//! arrive as WebView2 file objects, which carry their real paths
//! (`postMessageWithAdditionalObjects`); the page can never name a path itself.
//!
//! Messages are JSON *strings*, not objects. wry (under Tauri) listens on the
//! same channel and fails on anything that isn't a string, and WebView2 then
//! doesn't reliably reach the next listener: object messages never got here.
//!
//! Requests carry an `id`; the app answers each with a `loomapp:ack` event
//! so the page knows it was heard (and can fall back to doing it itself when
//! it wasn't). The app talks to the page by dispatching DOM events (`eval`),
//! see web/lib/client/native.ts for the page's side.

use serde::Deserialize;

/// The script that defines `window.LoomApp` before Loom's page loads.
pub fn init_script(origin: &str, version: &str) -> String {
    format!(
        r#"(() => {{
  const wv = window.chrome && window.chrome.webview;
  if (!wv || location.origin !== {origin:?} || window.LoomApp) return;
  let seq = 0;
  const pending = new Map();
  window.addEventListener("loomapp:ack", (e) => {{
    const d = (e && e.detail) || {{}};
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.ok) p.resolve(d.detail === undefined ? null : d.detail);
    else p.reject(new Error(d.error || "Loom for Windows couldn't do that"));
  }});
  const send = (msg, files) => {{
    const text = JSON.stringify(msg);
    if (files && files.length) wv.postMessageWithAdditionalObjects(text, files);
    else wv.postMessage(text);
  }};
  const request = (msg, files) =>
    new Promise((resolve, reject) => {{
      const id = ++seq;
      const timer = setTimeout(() => {{
        pending.delete(id);
        reject(new Error("Loom for Windows didn't answer"));
      }}, 60000);
      pending.set(id, {{ resolve, reject, timer }});
      try {{
        send(Object.assign({{}}, msg, {{ id }}), files);
      }} catch (err) {{
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }}
    }});
  Object.defineProperty(window, "LoomApp", {{
    configurable: false,
    value: Object.freeze({{
      apiVersion: 2,
      platform: "windows",
      appVersion: {version:?},
      capabilities: ["uploads.files", "uploads.picker", "downloads", "transfers", "settings"],
      uploadFiles: (destDir, items, files) => request({{ type: "uploadFiles", destDir, items }}, Array.from(files || [])),
      pickUpload: (destDir, mode) => request({{ type: "pickUpload", destDir, mode }}),
      download: (req) => request({{ type: "download", items: req.items }}),
      openTransfers: () => request({{ type: "openTransfers" }}),
      openSettings: () => request({{ type: "openSettings" }}),
      setLocation: (loc) => send({{ type: "setLocation", path: loc.path, canWrite: !!loc.canWrite }}),
      signedOut: () => send({{ type: "signedOut" }}),
      ready: () => send({{ type: "ready" }}),
      log: (level, message) => send({{ type: "log", level: String(level), message: String(message).slice(0, 2000) }}),
    }}),
  }});
}})();"#
    )
}

#[derive(Debug, Deserialize)]
pub struct UploadItem {
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    pub conflict: String,
}

#[derive(Debug, Deserialize)]
pub struct DownloadItem {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Message {
    #[serde(rename_all = "camelCase")]
    UploadFiles { dest_dir: String, items: Vec<UploadItem> },
    #[serde(rename_all = "camelCase")]
    PickUpload { dest_dir: String, mode: String },
    Download { items: Vec<DownloadItem> },
    OpenTransfers,
    OpenSettings,
    #[serde(rename_all = "camelCase")]
    SetLocation { path: Option<String>, can_write: bool },
    SignedOut,
    Ready,
    /// A line for the app's log (the page reporting a problem)
    Log { level: String, message: String },
}

impl Message {
    pub fn kind(&self) -> &'static str {
        match self {
            Message::UploadFiles { .. } => "uploadFiles",
            Message::PickUpload { .. } => "pickUpload",
            Message::Download { .. } => "download",
            Message::OpenTransfers => "openTransfers",
            Message::OpenSettings => "openSettings",
            Message::SetLocation { .. } => "setLocation",
            Message::SignedOut => "signedOut",
            Message::Ready => "ready",
            Message::Log { .. } => "log",
        }
    }
}

/// A message from the page, with the real paths of any files attached.
#[derive(Debug)]
pub struct Incoming {
    /// Set on requests: answer with `ack_js`
    pub id: Option<u64>,
    pub message: Message,
    pub paths: Vec<String>,
}

/// Parse what the page sent (a JSON string; older pages sent the object).
pub fn parse(text: &str) -> Result<(Option<u64>, Message), String> {
    #[derive(Deserialize)]
    struct Id {
        id: Option<u64>,
    }
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    // postMessage(JSON.stringify(..)) arrives as a JSON string literal through
    // WebMessageAsJson; unwrap it.
    let value = match value {
        serde_json::Value::String(inner) => serde_json::from_str(&inner).map_err(|e| e.to_string())?,
        v => v,
    };
    let id = serde_json::from_value::<Id>(value.clone()).ok().and_then(|i| i.id);
    let message = serde_json::from_value::<Message>(value).map_err(|e| e.to_string())?;
    Ok((id, message))
}

/// JavaScript that dispatches `name` with `detail` in the page.
pub fn event_js(name: &str, detail: &serde_json::Value) -> String {
    format!("window.dispatchEvent(new CustomEvent({name:?}, {{ detail: {detail} }}));")
}

/// The answer to request `id`.
pub fn ack_js(id: u64, result: Result<serde_json::Value, String>) -> String {
    let detail = match result {
        Ok(detail) => serde_json::json!({ "id": id, "ok": true, "detail": detail }),
        Err(error) => serde_json::json!({ "id": id, "ok": false, "error": error }),
    };
    event_js("loomapp:ack", &detail)
}

/// Is `url` on `origin` (scheme + host + port)?
pub fn same_origin(url: &str, origin: &str) -> bool {
    match (url::Url::parse(url), url::Url::parse(origin)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}

#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow, origin: String, tx: tokio::sync::mpsc::UnboundedSender<Incoming>) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::{Interface, PWSTR};

    window.with_webview(move |wv| unsafe {
        let core = match wv.controller().CoreWebView2() {
            Ok(core) => core,
            Err(e) => {
                tracing::error!("bridge: no CoreWebView2 ({e})");
                return;
            }
        };
        let listening_for = origin.clone();
        let handler = WebMessageReceivedEventHandler::create(Box::new(
            move |_sender: Option<ICoreWebView2>, args: Option<ICoreWebView2WebMessageReceivedEventArgs>| {
                let Some(args) = args else { return Ok(()) };
                let mut source = PWSTR::null();
                if let Err(e) = args.Source(&mut source) {
                    tracing::warn!("bridge: message without a source ({e})");
                    return Ok(());
                }
                let source = take_pwstr(source);
                if !same_origin(&source, &origin) {
                    tracing::warn!(%source, "bridge: message from another origin ignored");
                    return Ok(());
                }
                let mut json = PWSTR::null();
                if let Err(e) = args.WebMessageAsJson(&mut json) {
                    tracing::warn!("bridge: unreadable message ({e})");
                    return Ok(());
                }
                let json = take_pwstr(json);
                let mut paths = Vec::new();
                if let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                    if let Ok(objects) = args2.AdditionalObjects() {
                        let mut n = 0u32;
                        let _ = objects.Count(&mut n);
                        for i in 0..n {
                            let Ok(obj) = objects.GetValueAtIndex(i) else { continue };
                            if let Ok(file) = obj.cast::<ICoreWebView2File>() {
                                let mut p = PWSTR::null();
                                if file.Path(&mut p).is_ok() {
                                    paths.push(take_pwstr(p));
                                }
                            }
                        }
                    }
                }
                match parse(&json) {
                    Ok((id, message)) => {
                        tracing::info!(id, files = paths.len(), "bridge: {} from the page", message.kind());
                        if tx.send(Incoming { id, message, paths }).is_err() {
                            tracing::error!("bridge: nothing is handling the page's messages");
                        }
                    }
                    Err(e) => tracing::warn!("bridge: unknown message ({e}): {}", json.chars().take(200).collect::<String>()),
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        match core.add_WebMessageReceived(&handler, &mut token) {
            Ok(()) => tracing::info!("bridge: listening to the page on {listening_for}"),
            Err(e) => tracing::error!("bridge: can't listen to the page: {e}"),
        }
    })
}

/// Other platforms (development builds): no page bridge.
#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow, _origin: String, _tx: tokio::sync::mpsc::UnboundedSender<Incoming>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert!(same_origin("https://loom.example.com/files/a?b=1", "https://loom.example.com"));
        assert!(!same_origin("https://loom.example.com.evil.net/", "https://loom.example.com"));
        assert!(!same_origin("http://loom.example.com/", "https://loom.example.com"));
        assert!(!same_origin("https://loom.example.com:8443/", "https://loom.example.com"));
    }

    /// What WebMessageAsJson returns for postMessage(JSON.stringify(msg)).
    fn wire(msg: &str) -> String {
        serde_json::to_string(msg).unwrap()
    }

    #[test]
    fn every_message() {
        let (id, m) = parse(&wire(r#"{"type":"uploadFiles","destDir":"Photos","items":[{"relativePath":"a/b.jpg","size":3,"lastModified":1,"conflict":"replace"}],"id":7}"#)).unwrap();
        assert_eq!(id, Some(7));
        assert!(matches!(m, Message::UploadFiles { ref dest_dir, ref items } if dest_dir == "Photos" && items[0].conflict == "replace" && items[0].relative_path == "a/b.jpg"));
        let (id, m) = parse(&wire(r#"{"type":"pickUpload","destDir":"","mode":"folder","id":1}"#)).unwrap();
        assert_eq!(id, Some(1));
        assert!(matches!(m, Message::PickUpload { ref dest_dir, ref mode } if dest_dir.is_empty() && mode == "folder"));
        let (_, m) = parse(&wire(r#"{"type":"download","items":[{"path":"A/b.txt","name":"b.txt","type":"FILE"}],"id":2}"#)).unwrap();
        assert!(matches!(m, Message::Download { ref items } if items[0].path == "A/b.txt" && items[0].kind == "FILE"));
        assert!(matches!(parse(&wire(r#"{"type":"openTransfers","id":3}"#)).unwrap(), (Some(3), Message::OpenTransfers)));
        assert!(matches!(parse(&wire(r#"{"type":"openSettings","id":4}"#)).unwrap(), (Some(4), Message::OpenSettings)));
        assert!(matches!(parse(&wire(r#"{"type":"setLocation","path":null,"canWrite":false}"#)).unwrap(), (None, Message::SetLocation { path: None, can_write: false })));
        assert!(matches!(parse(&wire(r#"{"type":"signedOut"}"#)).unwrap(), (None, Message::SignedOut)));
        assert!(matches!(parse(&wire(r#"{"type":"ready"}"#)).unwrap(), (None, Message::Ready)));
        assert!(matches!(parse(&wire(r#"{"type":"log","level":"error","message":"x"}"#)).unwrap(), (None, Message::Log { .. })));
        // Older pages posted objects.
        assert!(matches!(parse(r#"{"type":"ready"}"#).unwrap(), (None, Message::Ready)));
        assert!(parse(&wire(r#"{"type":"rm -rf"}"#)).is_err());
        assert!(parse("not json").is_err());
    }

    #[test]
    fn acks() {
        let js = ack_js(5, Ok(serde_json::json!({ "dir": "C:\\Users\\a\\Downloads\\Loom" })));
        assert!(js.starts_with(r#"window.dispatchEvent(new CustomEvent("loomapp:ack""#));
        assert!(js.contains(r#""id":5"#) && js.contains(r#""ok":true"#));
        assert!(ack_js(6, Err("no".into())).contains(r#""ok":false"#));
    }

    #[test]
    fn script_pins_the_origin() {
        let s = init_script("https://loom.example.com", "1.0.0");
        assert!(s.contains(r#"location.origin !== "https://loom.example.com""#));
        assert!(s.contains("JSON.stringify(msg)"));
    }
}
