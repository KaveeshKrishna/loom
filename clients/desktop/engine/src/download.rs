//! Downloading one file, resumable: bytes go to `<name>.loomdownload` next to
//! the target and continue from its size (HTTP Range + If-Range, so a file
//! that changed in Loom starts over). When complete it's renamed into place,
//! never over an existing file (`name (1).ext`), with Loom's date.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use reqwest::StatusCode;
use tokio::io::AsyncWriteExt;

use crate::api::Api;
use crate::error::{Error, Result};
use crate::meter::{Limiter, Meter};
use crate::store::{Item, Store};
use crate::upload::tokio_util_lite::CancelFlag;
use crate::upload::Stop;

pub struct DownloadCtx {
    pub api: Api,
    pub store: Store,
    pub meter: Arc<Meter>,
    pub limiter: Arc<Limiter>,
    pub cancel: CancelFlag,
}

pub const PART_SUFFIX: &str = ".loomdownload";

fn part_path(target: &Path) -> PathBuf {
    let mut s = target.as_os_str().to_owned();
    s.push(PART_SUFFIX);
    PathBuf::from(s)
}

/// `name.ext`, or `name (1).ext`, … — the first that doesn't exist.
pub fn free_name(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = target.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = target.parent().map(Path::to_path_buf).unwrap_or_default();
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("some name is free")
}

impl DownloadCtx {
    pub async fn run(&self, item: &Item, progress: Arc<AtomicI64>) -> Result<std::result::Result<String, Stop>> {
        let target = PathBuf::from(&item.local_path);
        if let Some(dir) = target.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let part = part_path(&target);
        let mut etag = item.etag.clone();
        loop {
            let mut offset = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
            if offset > 0 && etag.is_none() {
                offset = 0; // can't tell if it's the same file: start over
            }
            progress.store(offset as i64, Ordering::Relaxed);
            let res = self.api.download(&item.remote_path, offset, etag.as_deref()).await?;
            let status = res.status();
            if status == StatusCode::RANGE_NOT_SATISFIABLE {
                // Already have everything (or the file shrank): check below.
                if offset as i64 == item.size {
                    break;
                }
                tokio::fs::remove_file(&part).await.ok();
                etag = None;
                continue;
            }
            let new_etag = res.headers().get("etag").and_then(|v| v.to_str().ok()).map(String::from);
            let mut file = if status == StatusCode::PARTIAL_CONTENT && offset > 0 {
                tokio::fs::OpenOptions::new().append(true).open(&part).await?
            } else {
                // A full answer: the file changed in Loom, or this is the start.
                progress.store(0, Ordering::Relaxed);
                tokio::fs::File::create(&part).await?
            };
            if new_etag != etag {
                etag = new_etag;
                self.store.set_etag(item.id, etag.as_deref())?;
            }
            let mut stream = res.bytes_stream();
            let mut since_flush = 0usize;
            while let Some(chunk) = stream.next().await {
                if self.cancel.is_cancelled() {
                    file.flush().await?;
                    return Ok(Err(Stop::Cancelled));
                }
                let chunk = chunk?;
                self.limiter.take(chunk.len()).await;
                file.write_all(&chunk).await?;
                self.meter.moved(item.batch_id, chunk.len() as u64);
                progress.fetch_add(chunk.len() as i64, Ordering::Relaxed);
                since_flush += chunk.len();
                if since_flush > 8 << 20 {
                    file.flush().await?;
                    since_flush = 0;
                }
            }
            file.flush().await?;
            file.sync_data().await?;
            drop(file);
            let len = tokio::fs::metadata(&part).await?.len();
            if (len as i64) < item.size {
                return Err(Error::Transient("The download was cut short".into()));
            }
            break;
        }
        // Into place, never over something that's already there.
        let final_path = free_name(&target);
        tokio::fs::rename(&part, &final_path).await?;
        if item.mtime_ms > 0 {
            let t = filetime::FileTime::from_unix_time(item.mtime_ms / 1000, ((item.mtime_ms % 1000) * 1_000_000) as u32);
            let _ = filetime::set_file_mtime(&final_path, t);
        }
        Ok(Ok(final_path.to_string_lossy().into_owned()))
    }
}

/// Throw away a cancelled download's partial file.
pub fn discard_part(local_path: &str) {
    let _ = std::fs::remove_file(part_path(Path::new(local_path)));
}
