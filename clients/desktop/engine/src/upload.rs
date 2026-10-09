//! Uploading one file: Loom's numbered-chunk protocol, resumable from
//! whatever the server already has (it's the source of truth: the engine
//! never needs to remember which chunks it sent).

use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use tokio::task::JoinSet;
use tokio_util_lite::CancelFlag;

use crate::api::{piece_stream, sha256_hex, Api, ChunkOutcome, Via};
use crate::error::{Error, Result};
use crate::meter::{Limiter, Meter};
use crate::store::{Item, Store};

pub mod tokio_util_lite {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Set when the user pauses or cancels; workers stop at the next chunk.
    #[derive(Clone, Default)]
    pub struct CancelFlag(Arc<AtomicBool>);
    impl CancelFlag {
        pub fn cancel(&self) {
            self.0.store(true, Ordering::SeqCst);
        }
        pub fn is_cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }
}

pub struct UploadCtx {
    pub api: Api,
    pub store: Store,
    pub meter: Arc<Meter>,
    pub limiter: Arc<Limiter>,
    pub parallel_chunks: usize,
    pub chunk_lan: u64,
    pub chunk_internet: u64,
    pub min_chunk: u64,
    pub max_chunk: u64,
    pub max_chunks: u64,
    pub cancel: CancelFlag,
}

/// Why an upload stopped early.
pub enum Stop {
    Cancelled,
}

fn file_fingerprint(path: &str) -> Result<(u64, i64)> {
    let meta = std::fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::Permanent("The file was moved or deleted".into()),
        std::io::ErrorKind::PermissionDenied => Error::Permanent("Windows didn't allow reading this file".into()),
        _ => Error::Io(e),
    })?;
    if !meta.is_file() {
        return Err(Error::Permanent("This isn't a file any more".into()));
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok((meta.len(), mtime))
}

fn read_chunk(path: &str, offset: u64, len: u64) -> Result<Vec<u8>> {
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).map_err(|e| if e.kind() == std::io::ErrorKind::UnexpectedEof { Error::SourceChanged } else { Error::Io(e) })?;
    Ok(buf)
}

impl UploadCtx {
    fn chunk_size_for(&self, size: u64) -> u64 {
        let want = if self.api.via() == Via::Lan { self.chunk_lan } else { self.chunk_internet };
        // Huge files need bigger chunks to stay under the server's chunk count.
        let min_for_count = size.div_ceil(self.max_chunks.max(1));
        want.max(min_for_count).clamp(self.min_chunk, self.max_chunk)
    }

    /// Upload `item` to completion. Returns the path it got in Loom.
    pub async fn run(&self, item: &Item, progress: Arc<AtomicI64>) -> Result<std::result::Result<String, Stop>> {
        // The file's own decision, else the batch's policy; anything but
        // Replace means "keep both" (the server adds a number to the name).
        let conflict = match item.conflict.as_deref() {
            Some("replace") => "replace",
            Some(_) => "keep_both",
            None if item.policy == crate::model::OnConflict::Replace => "replace",
            None => "keep_both",
        };
        let mut item = item.clone();
        let mut session_id = item.session_id.clone();
        let mut restarts = 0;
        loop {
            if self.cancel.is_cancelled() {
                return Ok(Err(Stop::Cancelled));
            }
            // The file must still be the one that was queued; if it changed,
            // the new version is uploaded from the start.
            let (now_size, now_mtime) = file_fingerprint(&item.local_path)?;
            if now_size != item.size as u64 || now_mtime != item.mtime_ms {
                tracing::info!(path = %item.local_path, "file changed while queued or uploading: starting it again");
                if let Some(id) = session_id.take() {
                    let _ = self.api.delete_session(&id).await;
                }
                self.store.set_session(item.id, None)?;
                self.store.set_source(item.id, now_size as i64, now_mtime)?;
                item.size = now_size as i64;
                item.mtime_ms = now_mtime;
                progress.store(0, Ordering::Relaxed);
                continue;
            }
            let size = item.size as u64;

            let session = match &session_id {
                Some(id) => match self.api.get_session(id).await {
                    Ok(s) => s,
                    Err(Error::SessionGone) => {
                        session_id = None;
                        self.store.set_session(item.id, None)?;
                        continue;
                    }
                    Err(e) => return Err(e),
                },
                None => {
                    let s = self
                        .api
                        .create_session(&item.remote_dir, &item.remote_path, size, item.mtime_ms, &item.client_ref, self.chunk_size_for(size))
                        .await?;
                    self.store.set_session(item.id, Some(&s.id))?;
                    session_id = Some(s.id.clone());
                    s
                }
            };
            if let Some(done) = session.result {
                return Ok(Ok(done.path));
            }
            progress.store(session.received as i64, Ordering::Relaxed);
            // How far past the first missing chunk the server accepts chunks.
            let first_missing = session.missing.first().copied().unwrap_or(0) as i64;
            let window = session.window_end.map(|end| (end - first_missing).max(1) as u64).unwrap_or(4);

            match self.send_missing(&item, &session.id, size, session.chunk_size, session.missing, window, progress.clone()).await {
                Ok(true) => {}
                Ok(false) => return Ok(Err(Stop::Cancelled)),
                Err(Error::SessionGone) => {
                    restarts += 1;
                    if restarts > 3 {
                        return Err(Error::Transient("The server keeps losing this upload".into()));
                    }
                    session_id = None;
                    self.store.set_session(item.id, None)?;
                    continue;
                }
                Err(Error::SourceChanged) => continue, // caught by the fingerprint check above
                Err(e) => return Err(e),
            }

            match self.api.complete(&session.id, conflict).await {
                Ok(Ok(done)) => return Ok(Ok(done.path)),
                Ok(Err(_missing)) => continue, // something got lost; ask again
                Err(Error::SessionGone) => {
                    // The answer to an earlier "complete" may have been lost
                    // and the session cleaned up since: check the file is there.
                    if let Some(path) = self.find_uploaded(&item, size).await? {
                        return Ok(Ok(path));
                    }
                    session_id = None;
                    self.store.set_session(item.id, None)?;
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Is a file of this size at the destination already?
    async fn find_uploaded(&self, item: &Item, size: u64) -> Result<Option<String>> {
        let full = if item.remote_dir.is_empty() { item.remote_path.clone() } else { format!("{}/{}", item.remote_dir, item.remote_path) };
        let parent = full.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
        match self.api.list(&parent).await {
            Ok(l) => Ok(l.children.into_iter().find(|n| n.relative_path == full && n.size() == size).map(|n| n.relative_path)),
            Err(Error::Permanent(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Send the missing chunks, several at a time, staying inside the
    /// server's write window. Ok(false) = cancelled.
    #[allow(clippy::too_many_arguments)]
    async fn send_missing(
        &self,
        item: &Item,
        session: &str,
        size: u64,
        chunk_size: u64,
        missing: Vec<u64>,
        window_chunks: u64,
        progress: Arc<AtomicI64>,
    ) -> Result<bool> {
        let total_chunks = if size == 0 { 0 } else { size.div_ceil(chunk_size) };
        let mut todo: std::collections::VecDeque<u64> = missing.into_iter().collect();
        let mut done: std::collections::BTreeSet<u64> = (0..total_chunks).filter(|i| !todo.contains(i)).collect();
        let mut in_flight: JoinSet<(u64, Result<ChunkOutcome>, i64)> = JoinSet::new();
        let mut corrupt_tries = 0;
        // Chunks beyond this wait (the server refuses far-ahead ones on drives without sparse files).
        let window = |done: &std::collections::BTreeSet<u64>| {
            let mut first = 0;
            while done.contains(&first) {
                first += 1;
            }
            first + window_chunks
        };
        loop {
            while in_flight.len() < self.parallel_chunks.max(1) {
                if self.cancel.is_cancelled() {
                    break;
                }
                let limit = window(&done);
                let Some(pos) = todo.iter().position(|i| *i <= limit) else { break };
                let index = todo.remove(pos).unwrap();
                let offset = index * chunk_size;
                let len = chunk_size.min(size - offset);
                let path = item.local_path.clone();
                let data = tokio::task::spawn_blocking(move || read_chunk(&path, offset, len)).await.map_err(|e| Error::Transient(e.to_string()))??;
                let sha = sha256_hex(&data);
                let data = Bytes::from(data);
                let api = self.api.clone();
                let session = session.to_string();
                let limiter = self.limiter.clone();
                let meter = self.meter.clone();
                let progress = progress.clone();
                let batch = item.batch_id;
                in_flight.spawn(async move {
                    let sent = Arc::new(AtomicI64::new(0));
                    let make = {
                        let sent = sent.clone();
                        move || {
                            let limiter = limiter.clone();
                            let meter = meter.clone();
                            let progress = progress.clone();
                            let sent = sent.clone();
                            piece_stream(data.clone(), 64 * 1024, move |n| {
                                let limiter = limiter.clone();
                                let meter = meter.clone();
                                let progress = progress.clone();
                                let sent = sent.clone();
                                async move {
                                    limiter.take(n).await;
                                    meter.moved(batch, n as u64);
                                    progress.fetch_add(n as i64, Ordering::Relaxed);
                                    sent.fetch_add(n as i64, Ordering::Relaxed);
                                }
                            })
                        }
                    };
                    let r = api.put_chunk(&session, index, len, &sha, make).await;
                    (index, r, sent.load(Ordering::Relaxed))
                });
            }
            if in_flight.is_empty() {
                if self.cancel.is_cancelled() {
                    return Ok(false);
                }
                if todo.is_empty() {
                    return Ok(true);
                }
                // Everything left is beyond the window: shouldn't happen, but don't spin.
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            let Some(joined) = in_flight.join_next().await else { continue };
            let (index, outcome, sent) = joined.map_err(|e| Error::Transient(e.to_string()))?;
            match outcome {
                Ok(ChunkOutcome::Stored) => {
                    done.insert(index);
                }
                other => {
                    // Not stored: take back the bytes counted for it.
                    progress.fetch_sub(sent, Ordering::Relaxed);
                    match other {
                        Ok(ChunkOutcome::Corrupt) => {
                            corrupt_tries += 1;
                            if corrupt_tries > 8 {
                                in_flight.abort_all();
                                return Err(Error::Transient("Chunks keep arriving damaged".into()));
                            }
                            todo.push_front(index);
                        }
                        Ok(ChunkOutcome::Busy) | Ok(ChunkOutcome::TooFarAhead) => {
                            todo.push_front(index);
                            tokio::time::sleep(Duration::from_millis(700)).await;
                        }
                        Err(e) => {
                            in_flight.abort_all();
                            return Err(e);
                        }
                        Ok(ChunkOutcome::Stored) => unreachable!(),
                    }
                }
            }
        }
    }
}
