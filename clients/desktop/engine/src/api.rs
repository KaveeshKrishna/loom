//! Talking to Loom: the device-token API, over the LAN when possible.
//!
//! Two HTTP clients: one for the public address (system certificate store),
//! one for the LAN address that trusts *only* the certificate authority the
//! server handed out over the public address. The LAN is used while a probe
//! of `<lan>/api/client/info` answers with this server's instance id; any
//! connection failure on it switches back to the public address at once.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use url::Url;

use crate::error::{Error, Result};

const LAN_PROBE_EVERY: Duration = Duration::from_secs(60);
const LAN_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LanConfig {
    pub url: String,
    pub ca_pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// e.g. https://loom.example.com
    pub public_url: String,
    pub token: String,
    /// From /api/client/info; the LAN must answer with the same one.
    pub instance_id: Option<String>,
    pub lan: Option<LanConfig>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Lan,
    Internet,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadLimits {
    pub chunk_size: u64,
    #[serde(default = "d_min_chunk")]
    pub min_chunk_size: u64,
    #[serde(default = "d_max_chunk")]
    pub max_chunk_size: u64,
    #[serde(default = "d_max_chunks")]
    pub max_chunks: u64,
    #[serde(default = "d_par_upload")]
    pub parallel_chunks_per_upload: u32,
    #[serde(default = "d_par_user")]
    pub parallel_chunks_per_user: u32,
}
fn d_min_chunk() -> u64 {
    1 << 20
}
fn d_max_chunk() -> u64 {
    95 << 20
}
fn d_max_chunks() -> u64 {
    100_000
}
fn d_par_upload() -> u32 {
    4
}
fn d_par_user() -> u32 {
    8
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub product: String,
    pub version: String,
    pub api_version: u32,
    pub instance_id: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub upload: UploadLimits,
    #[serde(default)]
    pub lan: Option<LanInfo>,
    #[serde(default)]
    pub user: Option<UserInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanInfo {
    pub url: String,
    pub ca_pem: String,
    pub ca_sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub email: String,
    pub role: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub size: u64,
    pub received: u64,
    pub chunk_size: u64,
    #[serde(default)]
    pub chunks: u64,
    #[serde(default)]
    pub missing: Vec<u64>,
    #[serde(default)]
    pub window_end: Option<i64>,
    #[serde(default)]
    pub result: Option<Finished>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub renamed: bool,
    #[serde(default)]
    pub replaced: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub key: String,
    pub kind: String,
    #[serde(default)]
    pub same: bool,
    pub existing: ExistingInfo,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingInfo {
    #[serde(rename = "type")]
    pub kind: String,
    pub size: Option<f64>,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub relative_path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub modified_at: Option<String>,
}

impl Node {
    pub fn is_dir(&self) -> bool {
        self.kind == "DIRECTORY"
    }
    pub fn size(&self) -> u64 {
        self.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub children: Vec<Node>,
    #[serde(default)]
    pub can_write: bool,
}

/// Outcome of sending one numbered chunk.
#[derive(Debug, Clone)]
pub enum ChunkOutcome {
    Stored,
    /// Outside the server's write window; send earlier chunks first.
    TooFarAhead,
    /// The server is busy (429, a chunk already in flight): try again shortly.
    Busy,
    /// Checksum mismatch: send it again.
    Corrupt,
}

struct Inner {
    cfg: RwLock<ServerConfig>,
    public: RwLock<reqwest::Client>,
    lan: RwLock<Option<(Url, reqwest::Client)>>,
    lan_ok: AtomicBool,
    lan_probed: Mutex<Option<Instant>>,
    user_agent: String,
}

#[derive(Clone)]
pub struct Api {
    inner: Arc<Inner>,
}

fn base_client(user_agent: &str) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(15))
        // A chunk must finish within the proxy's limits; the read timeout
        // catches a stalled connection without capping a slow but moving one.
        .read_timeout(Duration::from_secs(90))
        .pool_idle_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
}

fn lan_client(user_agent: &str, ca_pem: &str) -> Result<reqwest::Client> {
    let ca = reqwest::Certificate::from_pem(ca_pem.as_bytes()).map_err(|e| Error::Permanent(format!("Bad LAN certificate: {e}")))?;
    base_client(user_agent)
        .tls_built_in_root_certs(false)
        .add_root_certificate(ca)
        .connect_timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| Error::Permanent(format!("Can't set up the LAN connection: {e}")))
}

/// Percent-encode a query value.
pub fn q(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

impl Api {
    pub fn new(cfg: ServerConfig, user_agent: &str) -> Result<Api> {
        Url::parse(&cfg.public_url).map_err(|e| Error::Permanent(format!("Bad server address: {e}")))?;
        let public = base_client(user_agent).build().map_err(|e| Error::Permanent(e.to_string()))?;
        let api = Api {
            inner: Arc::new(Inner {
                cfg: RwLock::new(cfg.clone()),
                public: RwLock::new(public),
                lan: RwLock::new(None),
                lan_ok: AtomicBool::new(false),
                lan_probed: Mutex::new(None),
                user_agent: user_agent.to_string(),
            }),
        };
        api.set_lan(cfg.lan)?;
        Ok(api)
    }

    pub fn config(&self) -> ServerConfig {
        self.inner.cfg.read().unwrap().clone()
    }

    pub fn set_token(&self, token: String) {
        self.inner.cfg.write().unwrap().token = token;
    }

    /// The server's instance id: the LAN address must answer with the same one.
    pub fn set_instance_id(&self, id: Option<String>) {
        self.inner.cfg.write().unwrap().instance_id = id;
    }

    /// Use (or stop using) a LAN address. Takes effect after the next probe.
    pub fn set_lan(&self, lan: Option<LanConfig>) -> Result<()> {
        let client = match &lan {
            Some(l) => Some((Url::parse(&l.url).map_err(|e| Error::Permanent(e.to_string()))?, lan_client(&self.inner.user_agent, &l.ca_pem)?)),
            None => None,
        };
        *self.inner.lan.write().unwrap() = client;
        self.inner.cfg.write().unwrap().lan = lan;
        self.inner.lan_ok.store(false, Ordering::SeqCst);
        *self.inner.lan_probed.lock().unwrap() = None;
        Ok(())
    }

    pub fn via(&self) -> Via {
        if self.inner.lan_ok.load(Ordering::SeqCst) {
            Via::Lan
        } else {
            Via::Internet
        }
    }

    /// Forget the LAN until the next successful probe (e.g. the network changed).
    pub fn lan_down(&self) {
        if self.inner.lan_ok.swap(false, Ordering::SeqCst) {
            tracing::info!("LAN address stopped answering; using the internet address");
        }
        *self.inner.lan_probed.lock().unwrap() = Some(Instant::now());
    }

    /// Probe the LAN address if it's time (or `force`). Returns whether it's in use.
    pub async fn probe_lan(&self, force: bool) -> bool {
        let lan = self.inner.lan.read().unwrap().clone();
        let Some((url, client)) = lan else {
            self.inner.lan_ok.store(false, Ordering::SeqCst);
            return false;
        };
        {
            let mut probed = self.inner.lan_probed.lock().unwrap();
            if !force && probed.map(|t| t.elapsed() < LAN_PROBE_EVERY).unwrap_or(false) {
                return self.inner.lan_ok.load(Ordering::SeqCst);
            }
            *probed = Some(Instant::now());
        }
        let expected = self.inner.cfg.read().unwrap().instance_id.clone();
        let ok = async {
            let res = client.get(url.join("/api/client/info").ok()?).timeout(LAN_PROBE_TIMEOUT).send().await.ok()?;
            if !res.status().is_success() {
                return None;
            }
            let info: serde_json::Value = res.json().await.ok()?;
            let id = info.get("instanceId")?.as_str()?.to_string();
            Some(expected.as_deref() == Some(id.as_str()))
        }
        .await
        .unwrap_or(false);
        let was = self.inner.lan_ok.swap(ok, Ordering::SeqCst);
        if ok != was {
            tracing::info!(lan = ok, "LAN address {}", if ok { "is reachable: using it" } else { "isn't reachable" });
        }
        ok
    }

    fn pick(&self) -> (Url, reqwest::Client, Via) {
        if self.inner.lan_ok.load(Ordering::SeqCst) {
            if let Some((url, client)) = self.inner.lan.read().unwrap().clone() {
                return (url, client, Via::Lan);
            }
        }
        let base = Url::parse(&self.inner.cfg.read().unwrap().public_url).expect("checked when configured");
        (base, self.inner.public.read().unwrap().clone(), Via::Internet)
    }

    fn token(&self) -> String {
        self.inner.cfg.read().unwrap().token.clone()
    }

    /// Send a request (built fresh for each attempt), over the LAN when it's
    /// up; a LAN failure retries once over the internet. Any failure to get a
    /// response counts, not only "can't connect": leaving the home network
    /// also kills connections that are already open, and reusing one of those
    /// fails as "connection closed".
    async fn send(&self, make: impl Fn(&reqwest::Client, Url) -> RequestBuilder, path: &str) -> Result<Response> {
        let (base, client, via) = self.pick();
        let url = base.join(path).map_err(|e| Error::Permanent(e.to_string()))?;
        let res = make(&client, url).bearer_auth(self.token()).send().await;
        match res {
            Err(e) if via == Via::Lan && !e.is_builder() => {
                tracing::debug!("LAN request failed ({e}); retrying over the internet");
                self.lan_down();
                let (base, client, _) = self.pick();
                let url = base.join(path).map_err(|e| Error::Permanent(e.to_string()))?;
                Ok(make(&client, url).bearer_auth(self.token()).send().await?)
            }
            Err(e) => Err(e.into()),
            Ok(r) => Ok(r),
        }
    }

    async fn json<T: DeserializeOwned>(&self, method: Method, path: &str, body: Option<serde_json::Value>) -> Result<T> {
        let res = self
            .send(
                |c, url| {
                    let r = c.request(method.clone(), url);
                    match &body {
                        Some(b) => r.json(b),
                        None => r,
                    }
                },
                path,
            )
            .await?;
        let res = check(res).await?;
        Ok(res.json::<T>().await?)
    }

    // ── server ───────────────────────────────────────────────────────────────

    pub async fn client_info(&self) -> Result<ClientInfo> {
        self.json(Method::GET, "/api/client/info", None).await
    }

    /// Checks the token still works (401 → SignedOut).
    pub async fn me(&self) -> Result<serde_json::Value> {
        self.json(Method::GET, "/api/devices/me", None).await
    }

    /// A one-time path that signs the app's web view in.
    pub async fn web_login(&self) -> Result<String> {
        let v: serde_json::Value = self.json(Method::POST, "/api/devices/web-login", Some(json!({}))).await?;
        v.get("path").and_then(|p| p.as_str()).map(String::from).ok_or_else(|| Error::Permanent("Unexpected answer".into()))
    }

    pub async fn sign_out(&self) -> Result<()> {
        let _: serde_json::Value = self.json(Method::DELETE, "/api/devices/me", None).await?;
        Ok(())
    }

    // ── folders ──────────────────────────────────────────────────────────────

    pub async fn list(&self, path: &str) -> Result<Listing> {
        self.json(Method::GET, &format!("/api/files?path={}", q(path)), None).await
    }

    pub async fn mkdir(&self, parent: &str, name: &str) -> Result<()> {
        let res = self.send(|c, url| c.post(url).json(&json!({ "parentPath": parent, "name": name })), "/api/fs/mkdir").await?;
        if res.status() == StatusCode::CONFLICT {
            return Ok(()); // already there
        }
        check(res).await?;
        Ok(())
    }

    /// Which of these files (paths relative to dest_dir) already exist.
    pub async fn conflicts(&self, dest_dir: &str, files: &[(String, u64, i64)]) -> Result<Vec<ConflictInfo>> {
        let mut out = Vec::new();
        for batch in files.chunks(5000) {
            let body = json!({
                "op": "upload",
                "destDir": dest_dir,
                "files": batch.iter().map(|(p, s, m)| json!({ "path": p, "size": s, "lastModified": m })).collect::<Vec<_>>(),
            });
            #[derive(Deserialize)]
            struct R {
                conflicts: Vec<ConflictInfo>,
            }
            let r: R = self.json(Method::POST, "/api/fs/conflicts", Some(body)).await?;
            out.extend(r.conflicts);
        }
        Ok(out)
    }

    // ── uploads ──────────────────────────────────────────────────────────────

    pub async fn create_session(
        &self,
        dest_dir: &str,
        relative_path: &str,
        size: u64,
        last_modified: i64,
        client_ref: &str,
        chunk_size: u64,
    ) -> Result<Session> {
        self.json(
            Method::POST,
            "/api/upload/sessions",
            Some(json!({
                "destDir": dest_dir,
                "relativePath": relative_path,
                "size": size,
                "lastModified": last_modified,
                "mode": "chunks",
                "clientRef": client_ref,
                "chunkSize": chunk_size,
            })),
        )
        .await
    }

    pub async fn get_session(&self, id: &str) -> Result<Session> {
        let res = self.send(|c, url| c.get(url), &format!("/api/upload/sessions/{id}")).await?;
        if res.status() == StatusCode::NOT_FOUND {
            return Err(Error::SessionGone);
        }
        Ok(check(res).await?.json().await?)
    }

    pub async fn delete_session(&self, id: &str) -> Result<()> {
        let res = self.send(|c, url| c.delete(url), &format!("/api/upload/sessions/{id}")).await?;
        if res.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        check(res).await?;
        Ok(())
    }

    /// Send chunk `index`. `body` streams it (lets the caller count progress and limit speed).
    pub async fn put_chunk(
        &self,
        id: &str,
        index: u64,
        len: u64,
        sha256_hex: &str,
        make_body: impl Fn() -> reqwest::Body,
    ) -> Result<ChunkOutcome> {
        let path = format!("/api/upload/sessions/{id}?chunk={index}");
        let res = self
            .send(
                |c, url| {
                    c.put(url)
                        .header("content-type", "application/octet-stream")
                        .header("content-length", len)
                        .header("x-chunk-sha256", sha256_hex)
                        .timeout(Duration::from_secs(600))
                        .body(make_body())
                },
                &path,
            )
            .await?;
        let status = res.status();
        if status.is_success() {
            return Ok(ChunkOutcome::Stored);
        }
        let body: serde_json::Value = res.json().await.unwrap_or_default();
        match status.as_u16() {
            409 if body.get("windowEnd").is_some() => Ok(ChunkOutcome::TooFarAhead),
            409 if body.get("retry").is_some() => Ok(ChunkOutcome::Busy),
            409 if body.get("result").is_some() => Ok(ChunkOutcome::Stored), // already finished
            422 => Ok(ChunkOutcome::Corrupt),
            429 => Ok(ChunkOutcome::Busy),
            404 => Err(Error::SessionGone),
            _ => Err(classify(status, &body)),
        }
    }

    /// Finish an upload whose chunks have all arrived. Repeating it is safe.
    pub async fn complete(&self, id: &str, conflict: &str) -> Result<std::result::Result<Finished, Vec<u64>>> {
        let res = self
            .send(|c, url| c.post(url).json(&json!({})), &format!("/api/upload/sessions/{id}/complete?conflict={}", q(conflict)))
            .await?;
        let status = res.status();
        let body: serde_json::Value = res.json().await.unwrap_or_default();
        if status.is_success() {
            return serde_json::from_value(body).map(Ok).map_err(|e| Error::Permanent(format!("Unexpected answer: {e}")));
        }
        match status.as_u16() {
            404 => Err(Error::SessionGone),
            409 if body.get("missing").is_some() => {
                let missing = body["missing"].as_array().map(|a| a.iter().filter_map(|v| v.as_u64()).collect()).unwrap_or_default();
                Ok(Err(missing))
            }
            409 => Err(Error::Transient("The upload is being finished".into())),
            _ => Err(classify(status, &body)),
        }
    }

    // ── downloads ────────────────────────────────────────────────────────────

    /// GET a file from `offset` on (Range + If-Range when resuming).
    pub async fn download(&self, path: &str, offset: u64, etag: Option<&str>) -> Result<Response> {
        let p = format!("/api/files/serve?path={}&download=1", q(path));
        let res = self
            .send(
                |c, url| {
                    let mut r = c.get(url).timeout(Duration::from_secs(24 * 3600));
                    if offset > 0 {
                        r = r.header("range", format!("bytes={offset}-"));
                        if let Some(e) = etag {
                            r = r.header("if-range", e);
                        }
                    }
                    r
                },
                &p,
            )
            .await?;
        let s = res.status();
        if s.is_success() || s == StatusCode::RANGE_NOT_SATISFIABLE {
            return Ok(res);
        }
        let body: serde_json::Value = res.json().await.unwrap_or_default();
        if s == StatusCode::NOT_FOUND {
            return Err(Error::Permanent("The file is no longer in Loom".into()));
        }
        Err(classify(s, &body))
    }
}

/// Turn a non-success answer into an error the engine knows how to handle.
fn classify(status: StatusCode, body: &serde_json::Value) -> Error {
    let msg = body.get("error").and_then(|e| e.as_str()).map(String::from);
    match status.as_u16() {
        401 => Error::SignedOut,
        507 => Error::DiskFull,
        408 | 425 | 429 => Error::Transient(msg.unwrap_or_else(|| "Loom is busy".into())),
        500..=599 => Error::Transient(msg.unwrap_or_else(|| format!("Loom isn't answering properly ({status})"))),
        _ => Error::Permanent(format!("{} {}", status.as_u16(), msg.unwrap_or_else(|| status.canonical_reason().unwrap_or("error").to_string()))),
    }
}

async fn check(res: Response) -> Result<Response> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    Err(classify(status, &body))
}

/// SHA-256 of a chunk, hex.
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(data))
}

/// Make a request body that streams `data` in small pieces, calling `on_piece`
/// (progress + speed limit) before each.
pub fn piece_stream<F, Fut>(data: Bytes, piece: usize, on_piece: F) -> reqwest::Body
where
    F: Fn(usize) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let on_piece = Arc::new(on_piece);
    let pieces: Vec<Bytes> = (0..data.len()).step_by(piece.max(1)).map(|o| data.slice(o..(o + piece).min(data.len()))).collect();
    let stream = futures_util::stream::iter(pieces).then(move |p| {
        let f = on_piece.clone();
        async move {
            f(p.len()).await;
            Ok::<Bytes, std::io::Error>(p)
        }
    });
    reqwest::Body::wrap_stream(stream)
}

