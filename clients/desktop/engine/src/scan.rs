//! Turning what the user picked into queue items: walking local folders for
//! uploads, and Loom folders for downloads.

use std::path::{Path, PathBuf};

use crate::api::Api;
use crate::error::Result;
use crate::model::{OnConflict, RemoteEntry, UploadSource};
use crate::store::NewItem;

/// Files never worth uploading, and names Loom keeps for itself.
fn skip_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(lower.as_str(), "desktop.ini" | "thumbs.db" | ".ds_store" | ".loomtrash" | ".tmp-upload")
        || lower.starts_with(".loom-tmp-")
        || lower.starts_with("~$") // Office lock files
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into())
}

/// Walk the sources; calls `emit` with items in groups (so a 100 000-file
/// folder never sits in memory at once). Symlinks and junctions are skipped.
pub fn walk_upload_sources(sources: &[UploadSource], mut emit: impl FnMut(Vec<NewItem>) -> Result<()>) -> Result<usize> {
    let mut buf: Vec<NewItem> = Vec::new();
    let mut count = 0usize;
    let push = |buf: &mut Vec<NewItem>, it: NewItem, emit: &mut dyn FnMut(Vec<NewItem>) -> Result<()>| -> Result<()> {
        buf.push(it);
        if buf.len() >= 1000 {
            emit(std::mem::take(buf))?;
        }
        Ok(())
    };
    for src in sources {
        let meta = match std::fs::symlink_metadata(&src.path) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(path = %src.path.display(), "can't read: {e}");
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let root = src.relative_path.clone().unwrap_or_else(|| file_name(&src.path));
        if meta.is_file() {
            count += 1;
            push(
                &mut buf,
                NewItem {
                    kind: "file",
                    local_path: src.path.to_string_lossy().into_owned(),
                    remote_path: root,
                    size: meta.len() as i64,
                    mtime_ms: mtime_ms(&meta),
                    conflict: src.conflict,
                },
                &mut emit,
            )?;
            continue;
        }
        // A folder: depth-first, keeping its structure under `root`.
        let mut stack: Vec<(PathBuf, String)> = vec![(src.path.clone(), root)];
        while let Some((dir, rel)) = stack.pop() {
            let mut entries: Vec<_> = match std::fs::read_dir(&dir) {
                Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
                Err(e) => {
                    tracing::warn!(path = %dir.display(), "can't list: {e}");
                    continue;
                }
            };
            entries.sort_by_key(|e| e.file_name());
            let mut any = false;
            for e in entries {
                let name = e.file_name().to_string_lossy().into_owned();
                if skip_name(&name) {
                    continue;
                }
                let Ok(m) = std::fs::symlink_metadata(e.path()) else { continue };
                if m.file_type().is_symlink() || is_hidden_system(&m) {
                    continue;
                }
                any = true;
                let child_rel = format!("{rel}/{name}");
                if m.is_dir() {
                    stack.push((e.path(), child_rel));
                } else if m.is_file() {
                    count += 1;
                    push(
                        &mut buf,
                        NewItem {
                            kind: "file",
                            local_path: e.path().to_string_lossy().into_owned(),
                            remote_path: child_rel,
                            size: m.len() as i64,
                            mtime_ms: mtime_ms(&m),
                            conflict: src.conflict,
                        },
                        &mut emit,
                    )?;
                }
            }
            if !any {
                // An empty folder is created as-is.
                push(&mut buf, NewItem { kind: "dir", local_path: dir.to_string_lossy().into_owned(), remote_path: rel, size: 0, mtime_ms: 0, conflict: None }, &mut emit)?;
            }
        }
    }
    if !buf.is_empty() {
        emit(buf)?;
    }
    Ok(count)
}

#[cfg(windows)]
fn is_hidden_system(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    let a = m.file_attributes();
    a & HIDDEN != 0 && a & SYSTEM != 0
}

#[cfg(not(windows))]
fn is_hidden_system(_m: &std::fs::Metadata) -> bool {
    false
}

/// A name that's valid on Windows (Loom runs on Linux, where `a:b?.txt` is fine).
pub fn safe_local_name(name: &str) -> String {
    let mut s: String = name.chars().map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 32 { '_' } else { c }).collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() {
        s = "_".into();
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        s.insert(0, '_');
    }
    s
}

/// Parse the ISO dates Loom sends (`2026-10-09T05:07:00.000Z`) to milliseconds.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let ms = if b.get(19) == Some(&b'.') { num(20, 23).unwrap_or(0) } else { 0 };
    // Days from civil (Howard Hinnant's algorithm).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms)
}

/// List Loom folders recursively for a download. `emit` gets (remote path,
/// local path, size, mtime) groups; folders that are empty are created right away.
pub async fn walk_remote(
    api: &Api,
    entries: &[RemoteEntry],
    local_dir: &Path,
    mut emit: impl FnMut(Vec<NewItem>) -> Result<()>,
) -> Result<usize> {
    let mut count = 0;
    let mut buf = Vec::new();
    let mut stack: Vec<(String, PathBuf)> = Vec::new();
    for e in entries {
        let local = local_dir.join(safe_local_name(&e.name));
        if e.is_dir {
            stack.push((e.path.clone(), local));
        } else {
            // A single file: size and date come from its folder listing.
            let parent = e.path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            let listing = api.list(parent).await?;
            if let Some(n) = listing.children.iter().find(|n| n.relative_path == e.path) {
                count += 1;
                buf.push(NewItem {
                    kind: "file",
                    local_path: local.to_string_lossy().into_owned(),
                    remote_path: n.relative_path.clone(),
                    size: n.size() as i64,
                    mtime_ms: n.modified_at.as_deref().and_then(parse_iso_ms).unwrap_or(0),
                    conflict: Some(OnConflict::KeepBoth),
                });
            }
        }
    }
    while let Some((remote, local)) = stack.pop() {
        let listing = api.list(&remote).await?;
        tokio::fs::create_dir_all(&local).await?;
        for n in listing.children {
            let child_local = local.join(safe_local_name(&n.name));
            if n.is_dir() {
                stack.push((n.relative_path.clone(), child_local));
            } else {
                count += 1;
                buf.push(NewItem {
                    kind: "file",
                    local_path: child_local.to_string_lossy().into_owned(),
                    remote_path: n.relative_path.clone(),
                    size: n.size() as i64,
                    mtime_ms: n.modified_at.as_deref().and_then(parse_iso_ms).unwrap_or(0),
                    conflict: Some(OnConflict::KeepBoth),
                });
                if buf.len() >= 1000 {
                    emit(std::mem::take(&mut buf))?;
                }
            }
        }
    }
    if !buf.is_empty() {
        emit(buf)?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_names() {
        assert_eq!(safe_local_name("a:b?.txt"), "a_b_.txt");
        assert_eq!(safe_local_name("con.txt"), "_con.txt");
        assert_eq!(safe_local_name("COM1"), "_COM1");
        assert_eq!(safe_local_name("trail. "), "trail");
        assert_eq!(safe_local_name("ok name.jpg"), "ok name.jpg");
    }

    #[test]
    fn iso_dates() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("2020-09-13T12:26:40.000Z"), Some(1_600_000_000_000));
        assert_eq!(parse_iso_ms("2026-10-09T05:07:00.123Z"), Some(1_791_522_420_123));
    }

    #[test]
    fn walks_folders_with_structure() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Trip");
        std::fs::create_dir_all(root.join("day 1")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::write(root.join("day 1/a.jpg"), b"aaa").unwrap();
        std::fs::write(root.join("b.jpg"), b"bb").unwrap();
        std::fs::write(root.join("Thumbs.db"), b"x").unwrap();
        let mut items = Vec::new();
        let n = walk_upload_sources(&[UploadSource { path: root, conflict: None, relative_path: None }], |v| {
            items.extend(v);
            Ok(())
        })
        .unwrap();
        assert_eq!(n, 2);
        let mut paths: Vec<_> = items.iter().map(|i| (i.kind, i.remote_path.clone(), i.size)).collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![("dir", "Trip/empty".to_string(), 0), ("file", "Trip/b.jpg".to_string(), 2), ("file", "Trip/day 1/a.jpg".to_string(), 3)]
        );
    }
}
