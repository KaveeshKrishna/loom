//! loom-engine: the transfer manager behind the Loom desktop app.
//!
//! - Every upload and download is a row in a SQLite queue (store.rs), so
//!   nothing is lost when the app closes, crashes or the PC restarts.
//! - Uploads use Loom's numbered-chunk protocol: several files at once,
//!   several chunks per file, each checked with SHA-256; resuming asks the
//!   server what it's missing (upload.rs). Downloads resume with HTTP ranges
//!   (download.rs).
//! - Network trouble never fails a transfer: it waits and retries, forever,
//!   with backoff. Only real problems (file deleted, no permission) do.
//! - On the home network, transfers go straight to the server's LAN address
//!   over HTTPS with the certificate it handed out (api.rs).
//!
//! The app drives it through `Engine` and shows `Snapshot`s and `Event`s.

pub mod api;
pub mod download;
pub mod error;
pub mod meter;
pub mod model;
pub mod scan;
pub mod store;
pub mod upload;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, watch, Notify};

pub use api::{Api, ClientInfo, LanConfig, ServerConfig, Via};
pub use error::{Error, Result};
pub use model::*;

use meter::{Limiter, Meter};
use store::{now_ms, Store};
use upload::tokio_util_lite::CancelFlag;
use upload::{Stop, UploadCtx};

/// User-adjustable settings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Files transferred at the same time.
    pub parallel_files: usize,
    /// Chunks of one file sent at the same time.
    pub parallel_chunks: usize,
    /// Bytes per second, 0 = no limit.
    pub speed_limit: u64,
    /// Chunk size over the internet (smaller copes better with slow links).
    pub chunk_internet: u64,
    /// Chunk size on the home network.
    pub chunk_lan: u64,
    /// Go straight to the server's LAN address when it answers.
    #[serde(default = "yes")]
    pub use_lan: bool,
}

fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings { parallel_files: 3, parallel_chunks: 2, speed_limit: 0, chunk_internet: 4 << 20, chunk_lan: 32 << 20, use_lan: true }
    }
}

struct Running {
    cancel: CancelFlag,
    batch: BatchId,
}

struct Shared {
    api: Api,
    store: Store,
    meter: Arc<Meter>,
    limiter: Arc<Limiter>,
    settings: Mutex<Settings>,
    limits: Mutex<Option<api::UploadLimits>>,
    running: Mutex<HashMap<ItemId, Running>>,
    wake: Notify,
    events: broadcast::Sender<Event>,
    snapshot: watch::Sender<Snapshot>,
    offline: AtomicBool,
    signed_out: AtomicBool,
    disk_full: AtomicBool,
    all_paused: AtomicBool,
    /// Batches being scanned (cancel flag), and whose name check is running.
    scans: Mutex<HashMap<BatchId, CancelFlag>>,
    checking: Mutex<HashSet<BatchId>>,
    shutdown: AtomicBool,
}

/// The transfer manager. Cheap to clone.
#[derive(Clone)]
pub struct Engine {
    s: Arc<Shared>,
}

fn backoff_ms(attempts: i64) -> i64 {
    // 1 s, 2 s, 4 s … up to a minute, with jitter so retries don't line up.
    let base = (1000i64 << attempts.clamp(0, 6)).min(60_000);
    base + (rand::random::<u16>() as i64 % 750)
}

fn title_for(sources: &[UploadSource]) -> String {
    match sources {
        [one] => one.relative_path.clone().unwrap_or_else(|| one.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        many => format!("{} items", many.len()),
    }
}

impl Engine {
    /// Open the queue at `db_path` and start working. Needs a Tokio runtime.
    pub fn start(db_path: PathBuf, server: ServerConfig, settings: Settings, user_agent: &str) -> Result<Engine> {
        Self::with_store(Store::open(&db_path)?, server, settings, user_agent)
    }

    pub fn with_store(store: Store, server: ServerConfig, settings: Settings, user_agent: &str) -> Result<Engine> {
        let api = Api::new(server, user_agent)?;
        let (events, _) = broadcast::channel(256);
        let (snapshot, _) = watch::channel(Snapshot::default());
        let all_paused = store.get_meta("all_paused")?.as_deref() == Some("1");
        let engine = Engine {
            s: Arc::new(Shared {
                api,
                store,
                meter: Arc::new(Meter::default()),
                limiter: Arc::new(Limiter::new(settings.speed_limit)),
                settings: Mutex::new(settings),
                limits: Mutex::new(None),
                running: Mutex::new(HashMap::new()),
                wake: Notify::new(),
                events,
                snapshot,
                offline: AtomicBool::new(false),
                signed_out: AtomicBool::new(false),
                disk_full: AtomicBool::new(false),
                all_paused: AtomicBool::new(all_paused),
                scans: Mutex::new(HashMap::new()),
                checking: Mutex::new(HashSet::new()),
                shutdown: AtomicBool::new(false),
            }),
        };

        // Folders whose scan was interrupted continue where they were.
        for id in engine.s.store.batches_to_scan()? {
            let e = engine.clone();
            tokio::spawn(async move { e.rescan(id).await });
        }

        // The scheduler: starts work whenever something changes, and every second.
        let e = engine.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    _ = e.s.wake.notified() => {}
                    _ = tick.tick() => {}
                }
                if e.s.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                e.schedule();
            }
        });

        // Snapshots for the UI, a few times a second.
        let e = engine.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(400));
            loop {
                tick.tick().await;
                if e.s.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                e.publish();
            }
        });

        // Server limits, the LAN probe, and "are we back online?".
        let e = engine.clone();
        tokio::spawn(async move {
            e.refresh_server().await;
            let mut tick = tokio::time::interval(Duration::from_secs(20));
            loop {
                tick.tick().await;
                if e.s.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                if e.s.offline.load(Ordering::SeqCst) || e.s.limits.lock().unwrap().is_none() {
                    e.refresh_server().await;
                } else {
                    e.s.api.probe_lan(false).await;
                }
            }
        });
        Ok(engine)
    }

    /// Ask the server for its limits and LAN details (this also tells us
    /// whether it's reachable at all).
    pub async fn refresh_server(&self) {
        match self.s.api.client_info().await {
            Ok(info) => {
                let was_offline = self.s.offline.swap(false, Ordering::SeqCst);
                *self.s.limits.lock().unwrap() = Some(info.upload.clone());
                let cfg = self.s.api.config();
                if cfg.instance_id.as_deref() != Some(info.instance_id.as_str()) {
                    self.s.api.set_instance_id(Some(info.instance_id.clone()));
                }
                let lan = info.lan.filter(|_| self.settings().use_lan).map(|l| LanConfig { url: l.url, ca_pem: l.ca_pem });
                if cfg.lan != lan {
                    if let Err(e) = self.s.api.set_lan(lan) {
                        tracing::warn!("LAN details from the server are unusable: {e}");
                    }
                }
                self.s.api.probe_lan(true).await;
                if was_offline {
                    tracing::info!("Loom is reachable again");
                }
                self.s.wake.notify_one();
            }
            Err(Error::SignedOut) => self.signed_out(),
            Err(e) => {
                if !self.s.offline.swap(true, Ordering::SeqCst) {
                    tracing::info!("Loom isn't reachable ({e}); transfers wait");
                }
            }
        }
    }

    pub fn api(&self) -> &Api {
        &self.s.api
    }

    pub fn subscribe(&self) -> watch::Receiver<Snapshot> {
        self.s.snapshot.subscribe()
    }

    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.s.events.subscribe()
    }

    pub fn settings(&self) -> Settings {
        self.s.settings.lock().unwrap().clone()
    }

    pub fn set_settings(&self, settings: Settings) {
        self.s.limiter.set_rate(settings.speed_limit);
        let lan_changed = self.settings().use_lan != settings.use_lan;
        *self.s.settings.lock().unwrap() = settings;
        if lan_changed {
            let e = self.clone();
            tokio::spawn(async move { e.refresh_server().await });
        }
        self.s.wake.notify_one();
    }

    /// A new token (after pairing again): transfers continue.
    pub fn set_token(&self, token: String) {
        self.s.api.set_token(token);
        self.s.signed_out.store(false, Ordering::SeqCst);
        let e = self.clone();
        tokio::spawn(async move { e.refresh_server().await });
    }

    // ── queueing ─────────────────────────────────────────────────────────────

    /// Queue files and folders for upload. Folders are scanned in the
    /// background; files start as soon as their name is checked (or right
    /// away with Keep both / Replace).
    pub async fn upload(&self, req: UploadRequest) -> Result<BatchId> {
        let title = req.title.clone().unwrap_or_else(|| title_for(&req.sources));
        let id = self.s.store.create_batch(Direction::Upload, &title, &req.dest_dir, None, req.on_conflict)?;
        self.s.store.set_meta(&format!("sources:{id}"), &serde_json::to_string(&req.sources).unwrap_or_default())?;
        let e = self.clone();
        tokio::spawn(async move { e.scan_upload(id).await });
        Ok(id)
    }

    /// Queue files and folders from Loom for download into `local_dir`.
    pub async fn download(&self, req: DownloadRequest) -> Result<BatchId> {
        let title = req.title.clone().unwrap_or_else(|| match req.entries.as_slice() {
            [one] => one.name.clone(),
            many => format!("{} items", many.len()),
        });
        let remote_dir = req.entries.first().map(|e| e.path.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default()).unwrap_or_default();
        let local_dir = req.local_dir.to_string_lossy().into_owned();
        let id = self.s.store.create_batch(Direction::Download, &title, &remote_dir, Some(&local_dir), OnConflict::KeepBoth)?;
        self.s.store.set_meta(&format!("entries:{id}"), &serde_json::to_string(&req.entries).unwrap_or_default())?;
        let e = self.clone();
        tokio::spawn(async move { e.scan_download(id).await });
        Ok(id)
    }

    async fn rescan(&self, id: BatchId) {
        match self.s.store.batch_info(id) {
            Ok(Some((Direction::Upload, ..))) => self.scan_upload(id).await,
            Ok(Some((Direction::Download, ..))) => self.scan_download(id).await,
            _ => {}
        }
    }

    async fn scan_upload(&self, id: BatchId) {
        let Ok(Some((_, _, dest, _, policy, _))) = self.s.store.batch_info(id) else { return };
        let sources: Vec<UploadSource> = self.s.store.get_meta(&format!("sources:{id}")).ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let flag = CancelFlag::default();
        self.s.scans.lock().unwrap().insert(id, flag.clone());
        let _ = self.s.store.set_batch_state(id, "scanning");
        // A resumed scan skips what an earlier, interrupted one already queued.
        let known = self.s.store.batch_paths(id).unwrap_or_default();
        self.start_checking(id, dest.clone(), policy);

        let store = self.s.store.clone();
        let engine = self.clone();
        let flag2 = flag.clone();
        let result = tokio::task::spawn_blocking(move || {
            scan::walk_upload_sources(&sources, |items| {
                if flag2.is_cancelled() {
                    return Err(Error::Permanent("cancelled".into()));
                }
                let fresh: Vec<_> = items.into_iter().filter(|i| !known.contains(&i.remote_path)).collect();
                store.insert_items(id, policy, fresh)?;
                engine.s.wake.notify_one();
                Ok(())
            })
        })
        .await;
        self.s.scans.lock().unwrap().remove(&id);
        if flag.is_cancelled() {
            return;
        }
        let files = match result {
            Ok(Ok(n)) => n as i64,
            Ok(Err(e)) => {
                let _ = self.s.store.set_batch_error(id, Some(&e.to_string()));
                0
            }
            Err(e) => {
                let _ = self.s.store.set_batch_error(id, Some(&e.to_string()));
                0
            }
        };
        let _ = self.s.store.set_batch_state(id, "active");
        let _ = self.s.events.send(Event::ScanFinished { batch_id: id, files });
        self.s.wake.notify_one();
    }

    /// Check names against Loom while the scan runs: files whose name is
    /// free go ahead; taken ones wait for the user (Ask) or are skipped (Skip).
    fn start_checking(&self, id: BatchId, dest: String, policy: OnConflict) {
        if !matches!(policy, OnConflict::Ask | OnConflict::Skip) || !self.s.checking.lock().unwrap().insert(id) {
            return;
        }
        let e = self.clone();
        tokio::spawn(async move {
            let mut asked = 0i64;
            loop {
                let scanning = e.s.scans.lock().unwrap().contains_key(&id);
                let todo = e.s.store.checking(id, 2000).unwrap_or_default();
                if todo.is_empty() {
                    if !scanning {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    continue;
                }
                let query: Vec<(String, u64, i64)> = todo.iter().map(|t| (t.1.clone(), t.2 as u64, t.3)).collect();
                let conflicts = match e.s.api.conflicts(&dest, &query).await {
                    Ok(c) => c,
                    Err(err) if err.is_transient() => {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                    Err(Error::SignedOut) => {
                        e.signed_out();
                        break;
                    }
                    Err(err) => {
                        // Can't check: upload anyway, the server never overwrites (numbered names).
                        tracing::warn!("name check failed ({err}); uploading with numbered names where taken");
                        Vec::new()
                    }
                };
                let by_path: HashMap<&str, ItemId> = todo.iter().map(|t| (t.1.as_str(), t.0)).collect();
                let mut taken = HashSet::new();
                for c in &conflicts {
                    let Some(&item) = by_path.get(c.key.as_str()) else { continue };
                    taken.insert(item);
                    if policy == OnConflict::Skip {
                        let _ = e.s.store.skip_item(item);
                    } else {
                        let existing = serde_json::json!({ "type": c.existing.kind, "size": c.existing.size, "modifiedAt": c.existing.modified_at, "same": c.same });
                        let _ = e.s.store.ask_conflict(item, &existing.to_string());
                        asked += 1;
                    }
                }
                let free: Vec<ItemId> = todo.iter().map(|t| t.0).filter(|i| !taken.contains(i)).collect();
                let _ = e.s.store.checked(&free);
                e.s.wake.notify_one();
            }
            e.s.checking.lock().unwrap().remove(&id);
            if asked > 0 {
                let _ = e.s.events.send(Event::ConflictsFound { batch_id: id, count: asked });
            }
            e.s.wake.notify_one();
        });
    }

    async fn scan_download(&self, id: BatchId) {
        let Ok(Some((_, _, _, Some(local_dir), _, _))) = self.s.store.batch_info(id) else { return };
        let entries: Vec<RemoteEntry> = self.s.store.get_meta(&format!("entries:{id}")).ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let _ = self.s.store.set_batch_state(id, "scanning");
        loop {
            let known = self.s.store.batch_paths(id).unwrap_or_default();
            let store = self.s.store.clone();
            let r = scan::walk_remote(&self.s.api, &entries, std::path::Path::new(&local_dir), |items| {
                let fresh: Vec<_> = items.into_iter().filter(|i| !known.contains(&i.remote_path)).collect();
                store.insert_items(id, OnConflict::KeepBoth, fresh)
            })
            .await;
            match r {
                Ok(n) => {
                    let _ = self.s.events.send(Event::ScanFinished { batch_id: id, files: n as i64 });
                    break;
                }
                Err(e) if e.is_transient() => tokio::time::sleep(Duration::from_secs(5)).await,
                Err(Error::SignedOut) => {
                    self.signed_out();
                    return;
                }
                Err(e) => {
                    let _ = self.s.store.set_batch_error(id, Some(&e.to_string()));
                    break;
                }
            }
        }
        let _ = self.s.store.set_batch_state(id, "active");
        self.s.wake.notify_one();
    }

    // ── controls ─────────────────────────────────────────────────────────────

    /// Pause one batch, or everything (None). Running transfers stop at the
    /// next chunk and continue from there on resume.
    pub fn pause(&self, batch: Option<BatchId>) -> Result<()> {
        self.s.store.set_paused(batch, true)?;
        if batch.is_none() {
            self.s.all_paused.store(true, Ordering::SeqCst);
            self.s.store.set_meta("all_paused", "1")?;
        }
        for r in self.s.running.lock().unwrap().values() {
            if batch.is_none() || batch == Some(r.batch) {
                r.cancel.cancel();
            }
        }
        self.publish();
        Ok(())
    }

    pub fn resume(&self, batch: Option<BatchId>) -> Result<()> {
        self.s.store.set_paused(batch, false)?;
        if batch.is_none() {
            self.s.all_paused.store(false, Ordering::SeqCst);
            self.s.store.set_meta("all_paused", "0")?;
            self.s.disk_full.store(false, Ordering::SeqCst);
        }
        self.s.wake.notify_one();
        self.publish();
        Ok(())
    }

    /// Cancel a batch (or one of its files). Unfinished uploads are discarded
    /// on the server, partial downloads on disk.
    pub async fn cancel(&self, batch: BatchId, item: Option<ItemId>) -> Result<()> {
        if item.is_none() {
            if let Some(f) = self.s.scans.lock().unwrap().get(&batch) {
                f.cancel();
            }
        }
        for (id, r) in self.s.running.lock().unwrap().iter() {
            if r.batch == batch && (item.is_none() || item == Some(*id)) {
                r.cancel.cancel();
            }
        }
        let sessions = self.s.store.cancel(batch, item)?;
        for s in sessions {
            let _ = self.s.api.delete_session(&s).await;
        }
        if let Some((Direction::Download, ..)) = self.s.store.batch_info(batch)? {
            for it in self.s.store.items(batch, 0, i64::MAX)? {
                if it.state == ItemState::Cancelled {
                    download::discard_part(&it.local_path);
                }
            }
        }
        self.publish();
        Ok(())
    }

    /// Try failed (and waiting) transfers again now.
    pub fn retry(&self, batch: Option<BatchId>, item: Option<ItemId>) -> Result<usize> {
        let n = self.s.store.retry(batch, item)?;
        self.s.wake.notify_one();
        Ok(n)
    }

    /// Answer a name conflict (None item = all remaining in the batch).
    pub fn decide(&self, batch: BatchId, item: Option<ItemId>, decision: OnConflict) -> Result<usize> {
        let n = self.s.store.decide(batch, item, decision)?;
        self.s.wake.notify_one();
        Ok(n)
    }

    pub fn conflicts(&self, batch: BatchId) -> Result<Vec<ConflictView>> {
        self.s.store.conflicts(batch)
    }

    pub fn remove_batch(&self, batch: BatchId) -> Result<()> {
        self.s.store.remove_batch(batch)
    }

    pub fn clear_finished(&self) -> Result<usize> {
        self.s.store.clear_finished()
    }

    /// Bytes moved since each running item's progress was last saved, per batch.
    fn live_deltas(&self) -> HashMap<BatchId, i64> {
        let live = self.s.meter.live();
        let ids: Vec<ItemId> = live.keys().copied().collect();
        let saved = self.s.store.saved_bytes(&ids).unwrap_or_default();
        let mut out: HashMap<BatchId, i64> = HashMap::new();
        for (id, (batch, bytes)) in live {
            *out.entry(batch).or_default() += bytes - saved.get(&id).copied().unwrap_or(bytes);
        }
        out
    }

    /// The Transfers list, with live progress and speeds.
    pub fn batches(&self, include_finished: bool) -> Result<Vec<BatchView>> {
        let mut list = self.s.store.batches(include_finished)?;
        let deltas = self.live_deltas();
        let (_, speeds) = self.s.meter.speeds();
        for b in &mut list {
            b.bytes_done = (b.bytes_done + deltas.get(&b.id).copied().unwrap_or(0)).clamp(0, b.bytes_total);
            b.bytes_per_second = speeds.get(&b.id).copied().unwrap_or(0.0);
        }
        Ok(list)
    }

    pub fn items(&self, batch: BatchId, offset: i64, limit: i64) -> Result<Vec<ItemView>> {
        let mut list = self.s.store.items(batch, offset, limit)?;
        let live = self.s.meter.live();
        for it in &mut list {
            if let Some((_, bytes)) = live.get(&it.id) {
                it.bytes_done = *bytes;
            }
        }
        Ok(list)
    }

    pub fn snapshot(&self) -> Snapshot {
        self.s.snapshot.borrow().clone()
    }

    /// Stop everything, saving progress (transfers continue on the next start).
    pub async fn shutdown(&self) {
        self.s.shutdown.store(true, Ordering::SeqCst);
        for r in self.s.running.lock().unwrap().values() {
            r.cancel.cancel();
        }
        for (id, (_, bytes)) in self.s.meter.live() {
            let _ = self.s.store.set_progress(id, bytes);
        }
        // Give workers a moment to stop cleanly.
        for _ in 0..50 {
            if self.s.running.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn signed_out(&self) {
        if !self.s.signed_out.swap(true, Ordering::SeqCst) {
            tracing::warn!("this device was signed out of Loom");
            let _ = self.s.events.send(Event::SignedOut);
        }
        for r in self.s.running.lock().unwrap().values() {
            r.cancel.cancel();
        }
    }

    // ── the scheduler ────────────────────────────────────────────────────────

    fn schedule(&self) {
        // Batches with nothing left: tell the app.
        if let Ok(done) = self.s.store.finish_batches() {
            for (batch_id, title, direction, done, failed, skipped) in done {
                let _ = self.s.events.send(Event::BatchFinished { batch_id, title, direction, done, failed, skipped });
            }
        }
        if self.s.signed_out.load(Ordering::SeqCst) || self.s.all_paused.load(Ordering::SeqCst) || self.s.offline.load(Ordering::SeqCst) {
            return;
        }
        let parallel = self.settings().parallel_files.max(1);
        let running: Vec<ItemId> = self.s.running.lock().unwrap().keys().copied().collect();
        let free = parallel.saturating_sub(running.len());
        if free == 0 {
            return;
        }
        let Ok(items) = self.s.store.pick(free, &running) else { return };
        for item in items {
            if self.s.disk_full.load(Ordering::SeqCst) && item.direction == Direction::Upload {
                continue;
            }
            let cancel = CancelFlag::default();
            self.s.running.lock().unwrap().insert(item.id, Running { cancel: cancel.clone(), batch: item.batch_id });
            let _ = self.s.store.set_state(item.id, ItemState::Running, None);
            let e = self.clone();
            tokio::spawn(async move { e.work(item, cancel).await });
        }
    }

    async fn work(&self, item: store::Item, cancel: CancelFlag) {
        let progress: Arc<AtomicI64> = self.s.meter.track(item.id, item.batch_id, item.bytes_done);
        // Save progress every few seconds, so the list shows it after a restart.
        let saver = {
            let store = self.s.store.clone();
            let p = progress.clone();
            let id = item.id;
            tokio::spawn(async move {
                let mut t = tokio::time::interval(Duration::from_secs(3));
                loop {
                    t.tick().await;
                    let _ = store.set_progress(id, p.load(Ordering::Relaxed));
                }
            })
        };
        let result = self.transfer(&item, cancel, progress.clone()).await;
        saver.abort();
        let bytes = progress.load(Ordering::Relaxed);
        let store = &self.s.store;
        let _ = store.set_progress(item.id, bytes);
        self.s.meter.untrack(item.id);
        self.s.running.lock().unwrap().remove(&item.id);
        match result {
            Ok(Ok(path)) => {
                let _ = store.finish(item.id, Some(&path));
            }
            Ok(Err(Stop::Cancelled)) => {
                // Paused (back to the queue) or cancelled (cancel() set that already).
                if let Ok(Some(cur)) = store.get_item(item.id) {
                    if cur.state == ItemState::Running {
                        let _ = store.set_state(item.id, ItemState::Queued, None);
                    }
                }
            }
            Err(Error::SignedOut) => {
                let _ = store.set_state(item.id, ItemState::Queued, None);
                self.signed_out();
            }
            Err(Error::DiskFull) => {
                let _ = store.set_waiting(item.id, "Loom's drive is full", now_ms() + 60_000);
                if !self.s.disk_full.swap(true, Ordering::SeqCst) {
                    let _ = self.s.events.send(Event::DiskFull);
                }
            }
            Err(e) if e.is_transient() || matches!(e, Error::SessionGone | Error::SourceChanged) => {
                let _ = store.set_waiting(item.id, &e.to_string(), now_ms() + backoff_ms(item.attempts));
                if e.is_transient() {
                    // Is the server reachable at all? Stops hammering it while it isn't.
                    self.s.api.lan_down();
                    let e2 = self.clone();
                    tokio::spawn(async move { e2.refresh_server().await });
                }
            }
            Err(e) => {
                let _ = store.set_state(item.id, ItemState::Failed, Some(&e.to_string()));
            }
        }
        self.s.wake.notify_one();
    }

    async fn transfer(&self, item: &store::Item, cancel: CancelFlag, progress: Arc<AtomicI64>) -> Result<std::result::Result<String, Stop>> {
        if item.kind == "dir" {
            // An empty folder: create each level (existing ones are fine).
            let full = join_remote(&item.remote_dir, &item.remote_path);
            let mut parent = String::new();
            for part in full.split('/') {
                self.s.api.mkdir(&parent, part).await?;
                parent = join_remote(&parent, part);
            }
            return Ok(Ok(full));
        }
        match item.direction {
            Direction::Upload => {
                let settings = self.settings();
                let limits = self.s.limits.lock().unwrap().clone();
                let (min, max, max_chunks, server_par) = limits
                    .map(|l| (l.min_chunk_size, l.max_chunk_size, l.max_chunks, l.parallel_chunks_per_upload as usize))
                    .unwrap_or((1 << 20, 95 << 20, 100_000, 4));
                UploadCtx {
                    api: self.s.api.clone(),
                    store: self.s.store.clone(),
                    meter: self.s.meter.clone(),
                    limiter: self.s.limiter.clone(),
                    parallel_chunks: settings.parallel_chunks.clamp(1, server_par.max(1)),
                    chunk_lan: settings.chunk_lan,
                    chunk_internet: settings.chunk_internet,
                    min_chunk: min,
                    max_chunk: max,
                    max_chunks,
                    cancel,
                }
                .run(item, progress)
                .await
            }
            Direction::Download => {
                download::DownloadCtx {
                    api: self.s.api.clone(),
                    store: self.s.store.clone(),
                    meter: self.s.meter.clone(),
                    limiter: self.s.limiter.clone(),
                    cancel,
                }
                .run(item, progress)
                .await
            }
        }
    }

    fn publish(&self) {
        let Ok((queued, waiting, failed, conflicts, paused, bytes_total, bytes_saved)) = self.s.store.totals() else { return };
        let (bps, _) = self.s.meter.tick();
        let deltas: i64 = self.live_deltas().values().sum();
        let snap = Snapshot {
            active: self.s.running.lock().unwrap().len() as i64,
            queued,
            paused,
            waiting,
            failed,
            conflicts,
            bytes_done: (bytes_saved + deltas).clamp(0, bytes_total),
            bytes_total,
            bytes_per_second: bps,
            via: Some(if self.s.api.via() == Via::Lan { "lan".into() } else { "internet".into() }),
            offline: self.s.offline.load(Ordering::SeqCst),
            signed_out: self.s.signed_out.load(Ordering::SeqCst),
            disk_full: self.s.disk_full.load(Ordering::SeqCst),
            all_paused: self.s.all_paused.load(Ordering::SeqCst),
        };
        self.s.snapshot.send_if_modified(|old| {
            if *old != snap {
                *old = snap;
                true
            } else {
                false
            }
        });
    }
}

fn join_remote(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a}/{b}"),
    }
}
