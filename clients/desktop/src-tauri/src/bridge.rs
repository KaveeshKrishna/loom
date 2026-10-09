//! The bridge between Loom's web page (in the main window) and the app.
//!
//! The page talks to us through WebView2's own message channel
//! (`chrome.webview.postMessage`), not Tauri's IPC: the remote page gets no
//! Tauri permissions at all. Every message is checked to come from the
//! configured server's origin. Files the user drops or picks in the page
//! arrive as WebView2 file objects, which carry their real paths
//! (`postMessageWithAdditionalObjects`); the page can never name a path itself.
//!
//! The app answers by dispatching DOM events into the page (`eval`), see
//! web/lib/client/native.ts for the page's side.

use serde::Deserialize;

/// The script that defines `window.LoomApp` before Loom's page loads.
pub fn init_script(origin: &str, version: &str) -> String {
    format!(
        r#"(() => {{
  const wv = window.chrome && window.chrome.webview;
  if (!wv || location.origin !== {origin:?}) return;
  const post = (msg, files) =>
    files && files.length ? wv.postMessageWithAdditionalObjects(msg, files) : wv.postMessage(msg);
  Object.defineProperty(window, "LoomApp", {{
    configurable: false,
    value: Object.freeze({{
      apiVersion: 1,
      platform: "windows",
      appVersion: {version:?},
      capabilities: ["uploads.files", "uploads.picker", "downloads", "transfers"],
      uploadFiles: (destDir, items, files) => post({{ type: "uploadFiles", destDir, items }}, Array.from(files || [])),
      pickUpload: (destDir, mode) => post({{ type: "pickUpload", destDir, mode }}),
      download: (req) => post({{ type: "download", items: req.items }}),
      openTransfers: () => post({{ type: "openTransfers" }}),
      setLocation: (loc) => post({{ type: "setLocation", path: loc.path, canWrite: loc.canWrite }}),
      signedOut: () => post({{ type: "signedOut" }}),
      ready: () => post({{ type: "ready" }}),
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
    #[serde(rename_all = "camelCase")]
    SetLocation { path: Option<String>, can_write: bool },
    SignedOut,
    Ready,
}

/// A message from the page, with the real paths of any files attached.
#[derive(Debug)]
pub struct Incoming {
    pub message: Message,
    pub paths: Vec<String>,
}

/// JavaScript that dispatches `name` with `detail` in the page.
pub fn event_js(name: &str, detail: &serde_json::Value) -> String {
    format!("window.dispatchEvent(new CustomEvent({name:?}, {{ detail: {detail} }}));")
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
        let Ok(core) = wv.controller().CoreWebView2() else {
            tracing::error!("bridge: no CoreWebView2");
            return;
        };
        let handler = WebMessageReceivedEventHandler::create(Box::new(
            move |_sender: Option<ICoreWebView2>, args: Option<ICoreWebView2WebMessageReceivedEventArgs>| {
                let Some(args) = args else { return Ok(()) };
                let mut source = PWSTR::null();
                args.Source(&mut source)?;
                let source = take_pwstr(source);
                if !same_origin(&source, &origin) {
                    tracing::warn!(%source, "bridge: message from another origin ignored");
                    return Ok(());
                }
                let mut json = PWSTR::null();
                args.WebMessageAsJson(&mut json)?;
                let json = take_pwstr(json);
                let mut paths = Vec::new();
                if let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                    if let Ok(objects) = args2.AdditionalObjects() {
                        let mut n = 0u32;
                        objects.Count(&mut n)?;
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
                match serde_json::from_str::<Message>(&json) {
                    Ok(message) => {
                        let _ = tx.send(Incoming { message, paths });
                    }
                    Err(e) => tracing::warn!("bridge: unknown message ({e})"),
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        if let Err(e) = core.add_WebMessageReceived(&handler, &mut token) {
            tracing::error!("bridge: can't listen to the page: {e}");
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

    #[test]
    fn messages() {
        let m: Message = serde_json::from_str(r#"{"type":"uploadFiles","destDir":"Photos","items":[{"relativePath":"a/b.jpg","size":3,"lastModified":1,"conflict":"replace"}]}"#).unwrap();
        assert!(matches!(m, Message::UploadFiles { ref dest_dir, ref items } if dest_dir == "Photos" && items[0].conflict == "replace"));
        let m: Message = serde_json::from_str(r#"{"type":"setLocation","path":null,"canWrite":false}"#).unwrap();
        assert!(matches!(m, Message::SetLocation { path: None, can_write: false }));
        assert!(serde_json::from_str::<Message>(r#"{"type":"rm -rf"}"#).is_err());
    }

    #[test]
    fn script_pins_the_origin() {
        let s = init_script("https://loom.example.com", "1.0.0");
        assert!(s.contains(r#"location.origin !== "https://loom.example.com""#));
    }
}
