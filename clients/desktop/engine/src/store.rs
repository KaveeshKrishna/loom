//! The transfer queue on disk (SQLite). Everything the engine knows lives
//! here, so closing the app, a crash or a reboot loses nothing: on start,
//! items that were running go back to the queue and continue from what the
//! server says it has.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::Result;
use crate::model::*;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  title TEXT NOT NULL,
  remote_dir TEXT NOT NULL,
  local_dir TEXT,
  on_conflict TEXT NOT NULL,
  state TEXT NOT NULL,             -- scanning | active | done | cancelled
  paused INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- file | dir
  local_path TEXT NOT NULL,
  remote_path TEXT NOT NULL,       -- upload: relative to the batch's remote_dir; download: path in Loom
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  conflict TEXT,                   -- decided: keep_both | replace | skip; "ask" while waiting
  existing TEXT,                   -- JSON about the existing file, while asking
  state TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  client_ref TEXT NOT NULL,
  etag TEXT,
  result_path TEXT,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_pick ON items (state, next_try_at, id);
CREATE INDEX IF NOT EXISTS items_batch ON items (batch_id, id);
"#;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// An item as the workers see it.
#[derive(Debug, Clone)]
pub struct Item {
    pub id: ItemId,
    pub batch_id: BatchId,
    pub direction: Direction,
    pub kind: String,
    pub local_path: String,
    pub remote_path: String,
    pub remote_dir: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub conflict: Option<String>,
    /// The batch's "if the name is taken" policy (for items without their own decision).
    pub policy: OnConflict,
    pub state: ItemState,
    pub attempts: i64,
    pub bytes_done: i64,
    pub session_id: Option<String>,
    pub client_ref: String,
    pub etag: Option<String>,
}

/// (direction, title, remote_dir, local_dir, policy, state)
pub type BatchInfo = (Direction, String, String, Option<String>, OnConflict, String);
/// (id, title, direction, done, failed, skipped)
pub type FinishedBatch = (BatchId, String, Direction, i64, i64, i64);
/// (queued, waiting, failed, conflicts, paused, bytes_total, bytes_done)
pub type Totals = (i64, i64, i64, i64, i64, i64, i64);

/// One file for insert_items.
pub struct NewItem {
    pub kind: &'static str,
    pub local_path: String,
    pub remote_path: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub conflict: Option<OnConflict>,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

fn new_ref() -> String {
    use rand::Rng;
    let mut b = [0u8; 16];
    rand::thread_rng().fill(&mut b);
    format!("loom-{}", hex::encode(b))
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let store = Store { conn: Arc::new(Mutex::new(conn)) };
        store.recover()?;
        Ok(store)
    }

    pub fn in_memory() -> Result<Store> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn: Arc::new(Mutex::new(conn)) })
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T> {
        let mut c = self.conn.lock().unwrap();
        Ok(f(&mut c)?)
    }

    /// After a crash or restart: whatever was running starts again (it resumes).
    fn recover(&self) -> Result<()> {
        self.with(|c| {
            c.execute("UPDATE items SET state = 'queued', next_try_at = 0 WHERE state = 'running'", [])?;
            // A folder that was being scanned is scanned again from the start.
            c.execute("UPDATE batches SET state = 'rescan' WHERE state = 'scanning'", [])?;
            Ok(())
        })
    }

    // ── meta ─────────────────────────────────────────────────────────────────

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        self.with(|c| c.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0)).optional())
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.with(|c| c.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]).map(|_| ()))
    }

    // ── batches ──────────────────────────────────────────────────────────────

    pub fn create_batch(&self, dir: Direction, title: &str, remote_dir: &str, local_dir: Option<&str>, on_conflict: OnConflict) -> Result<BatchId> {
        self.with(|c| {
            c.execute(
                "INSERT INTO batches (direction, title, remote_dir, local_dir, on_conflict, state, created_at) VALUES (?, ?, ?, ?, ?, 'scanning', ?)",
                params![dir.as_str(), title, remote_dir, local_dir, on_conflict.as_str(), now_ms()],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    pub fn batch_info(&self, id: BatchId) -> Result<Option<BatchInfo>> {
        self.with(|c| {
            c.query_row("SELECT direction, title, remote_dir, local_dir, on_conflict, state FROM batches WHERE id = ?", [id], |r| {
                Ok((
                    Direction::parse(&r.get::<_, String>(0)?),
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    OnConflict::parse(&r.get::<_, String>(4)?).unwrap_or(OnConflict::KeepBoth),
                    r.get(5)?,
                ))
            })
            .optional()
        })
    }

    pub fn set_batch_state(&self, id: BatchId, state: &str) -> Result<()> {
        let finished = matches!(state, "done" | "cancelled").then(now_ms);
        self.with(|c| c.execute("UPDATE batches SET state = ?, finished_at = ? WHERE id = ?", params![state, finished, id]).map(|_| ()))
    }

    pub fn set_batch_error(&self, id: BatchId, err: Option<&str>) -> Result<()> {
        self.with(|c| c.execute("UPDATE batches SET last_error = ? WHERE id = ?", params![err, id]).map(|_| ()))
    }

    /// Batches whose folders must be (re)scanned.
    pub fn batches_to_scan(&self) -> Result<Vec<BatchId>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id FROM batches WHERE state = 'rescan'")?;
            let ids = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
    }

    pub fn set_paused(&self, batch: Option<BatchId>, paused: bool) -> Result<()> {
        self.with(|c| {
            match batch {
                Some(id) => c.execute("UPDATE batches SET paused = ? WHERE id = ?", params![paused, id])?,
                None => c.execute("UPDATE batches SET paused = ? WHERE state IN ('scanning', 'rescan', 'active')", params![paused])?,
            };
            Ok(())
        })
    }

    pub fn remove_batch(&self, id: BatchId) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM batches WHERE id = ?", [id]).map(|_| ()))
    }

    /// Forget finished batches (the "Clear finished" button).
    pub fn clear_finished(&self) -> Result<usize> {
        self.with(|c| c.execute("DELETE FROM batches WHERE state IN ('done', 'cancelled')", []))
    }

    /// Mark batches with nothing left to do as done; returns them with their counts.
    pub fn finish_batches(&self) -> Result<Vec<FinishedBatch>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT b.id, b.title, b.direction,
                   SUM(i.state = 'done'), SUM(i.state = 'failed'), SUM(i.state = 'skipped')
                 FROM batches b LEFT JOIN items i ON i.batch_id = b.id
                 WHERE b.state = 'active'
                 GROUP BY b.id
                 HAVING SUM(i.state IN ('checking', 'queued', 'running', 'waiting', 'conflict')) = 0 OR COUNT(i.id) = 0",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        Direction::parse(&r.get::<_, String>(2)?),
                        r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                        r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for row in &rows {
                c.execute("UPDATE batches SET state = 'done', finished_at = ? WHERE id = ?", params![now_ms(), row.0])?;
            }
            Ok(rows)
        })
    }

    // ── items ────────────────────────────────────────────────────────────────

    /// Add items. Files without their own decision start in "checking" when
    /// the batch's policy needs to know about existing names (Ask, Skip).
    pub fn insert_items(&self, batch: BatchId, policy: OnConflict, items: Vec<NewItem>) -> Result<()> {
        self.with(|c| {
            let tx = c.transaction()?;
            {
                let mut st = tx.prepare(
                    "INSERT INTO items (batch_id, kind, local_path, remote_path, size, mtime_ms, conflict, state, client_ref, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )?;
                let now = now_ms();
                for it in items {
                    let check = it.kind == "file" && it.conflict.is_none() && matches!(policy, OnConflict::Ask | OnConflict::Skip);
                    let decided = it.conflict.map(|c| c.as_str());
                    st.execute(params![
                        batch,
                        it.kind,
                        it.local_path,
                        it.remote_path,
                        it.size,
                        it.mtime_ms,
                        decided,
                        if check { "checking" } else if decided == Some("skip") { "skipped" } else { "queued" },
                        new_ref(),
                        now
                    ])?;
                }
            }
            tx.commit()
        })
    }

    /// Remote paths already in a batch (so a resumed scan doesn't add them twice).
    pub fn batch_paths(&self, batch: BatchId) -> Result<std::collections::HashSet<String>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT remote_path FROM items WHERE batch_id = ?")?;
            let rows = st.query_map([batch], |r| r.get(0))?.collect::<rusqlite::Result<std::collections::HashSet<String>>>()?;
            Ok(rows)
        })
    }

    /// Up to `limit` files waiting for the name check: (id, remote_path, size, mtime).
    pub fn checking(&self, batch: BatchId, limit: i64) -> Result<Vec<(ItemId, String, i64, i64)>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id, remote_path, size, mtime_ms FROM items WHERE batch_id = ? AND state = 'checking' ORDER BY id LIMIT ?")?;
            let rows = st.query_map(params![batch, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// After the name check: these go ahead (queued), the rest were handled by ask/skip.
    pub fn checked(&self, ids: &[ItemId]) -> Result<()> {
        self.with(|c| {
            let tx = c.transaction()?;
            {
                let mut st = tx.prepare("UPDATE items SET state = 'queued' WHERE id = ? AND state = 'checking'")?;
                for id in ids {
                    st.execute([id])?;
                }
            }
            tx.commit()
        })
    }

    pub fn skip_item(&self, id: ItemId) -> Result<()> {
        self.with(|c| c.execute("UPDATE items SET state = 'skipped', conflict = 'skip', updated_at = ? WHERE id = ?", params![now_ms(), id]).map(|_| ()))
    }

    pub fn ask_conflict(&self, item: ItemId, existing_json: &str) -> Result<()> {
        self.with(|c| c.execute("UPDATE items SET state = 'conflict', conflict = 'ask', existing = ?, updated_at = ? WHERE id = ?", params![existing_json, now_ms(), item]).map(|_| ()))
    }

    pub fn set_conflict(&self, item: ItemId, conflict: OnConflict) -> Result<()> {
        self.with(|c| c.execute("UPDATE items SET conflict = ?, updated_at = ? WHERE id = ?", params![conflict.as_str(), now_ms(), item]).map(|_| ()))
    }

    /// Answer conflicts: `None` item = every waiting one in the batch.
    pub fn decide(&self, batch: BatchId, item: Option<ItemId>, decision: OnConflict) -> Result<usize> {
        let (state, conflict) = match decision {
            OnConflict::Skip => ("skipped", "skip"),
            OnConflict::Replace => ("queued", "replace"),
            _ => ("queued", "keep_both"),
        };
        self.with(|c| {
            let n = match item {
                Some(id) => c.execute(
                    "UPDATE items SET state = ?, conflict = ?, existing = NULL, updated_at = ? WHERE id = ? AND batch_id = ? AND state = 'conflict'",
                    params![state, conflict, now_ms(), id, batch],
                )?,
                None => c.execute(
                    "UPDATE items SET state = ?, conflict = ?, existing = NULL, updated_at = ? WHERE batch_id = ? AND state = 'conflict'",
                    params![state, conflict, now_ms(), batch],
                )?,
            };
            Ok(n)
        })
    }

    pub fn conflicts(&self, batch: BatchId) -> Result<Vec<ConflictView>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id, remote_path, size, mtime_ms, existing FROM items WHERE batch_id = ? AND state = 'conflict' ORDER BY id")?;
            let rows = st
                .query_map([batch], |r| {
                    let existing: serde_json::Value = r.get::<_, Option<String>>(4)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
                    Ok(ConflictView {
                        item_id: r.get(0)?,
                        relative_path: r.get(1)?,
                        incoming_size: r.get(2)?,
                        incoming_modified_ms: r.get(3)?,
                        existing_size: existing.get("size").and_then(|v| v.as_f64()).map(|v| v as i64),
                        existing_modified: existing.get("modifiedAt").and_then(|v| v.as_str()).map(String::from),
                        existing_is_folder: existing.get("type").and_then(|v| v.as_str()) == Some("DIRECTORY"),
                        same: existing.get("same").and_then(|v| v.as_bool()).unwrap_or(false),
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Next items to start: queued (or waiting whose time has come), oldest
    /// batch first, in paused-aware order.
    pub fn pick(&self, limit: usize, exclude: &[ItemId]) -> Result<Vec<Item>> {
        let now = now_ms();
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT i.id, i.batch_id, b.direction, i.kind, i.local_path, i.remote_path, b.remote_dir, i.size, i.mtime_ms,
                        i.conflict, b.on_conflict, i.state, i.attempts, i.bytes_done, i.session_id, i.client_ref, i.etag
                 FROM items i JOIN batches b ON b.id = i.batch_id
                 WHERE i.state IN ('queued', 'waiting') AND i.next_try_at <= ? AND b.paused = 0 AND b.state IN ('active', 'scanning', 'rescan')
                 ORDER BY b.id, i.id LIMIT ?",
            )?;
            let rows = st.query_map(params![now, (limit + exclude.len()) as i64], item_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().filter(|i| !exclude.contains(&i.id)).take(limit).collect())
        })
    }

    pub fn get_item(&self, id: ItemId) -> Result<Option<Item>> {
        self.with(|c| {
            c.query_row(
                "SELECT i.id, i.batch_id, b.direction, i.kind, i.local_path, i.remote_path, b.remote_dir, i.size, i.mtime_ms,
                        i.conflict, b.on_conflict, i.state, i.attempts, i.bytes_done, i.session_id, i.client_ref, i.etag
                 FROM items i JOIN batches b ON b.id = i.batch_id WHERE i.id = ?",
                [id],
                item_from_row,
            )
            .optional()
        })
    }

    pub fn set_state(&self, id: ItemId, state: ItemState, error: Option<&str>) -> Result<()> {
        self.with(|c| c.execute("UPDATE items SET state = ?, error = ?, updated_at = ? WHERE id = ?", params![state.as_str(), error, now_ms(), id]).map(|_| ()))
    }

    pub fn set_waiting(&self, id: ItemId, error: &str, next_try_at: i64) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE items SET state = 'waiting', error = ?, attempts = attempts + 1, next_try_at = ?, updated_at = ? WHERE id = ?",
                params![error, next_try_at, now_ms(), id],
            )
            .map(|_| ())
        })
    }

    pub fn set_session(&self, id: ItemId, session: Option<&str>) -> Result<()> {
        self.with(|c| c.execute("UPDATE items SET session_id = ?, updated_at = ? WHERE id = ?", params![session, now_ms(), id]).map(|_| ()))
    }

    pub fn set_source(&self, id: ItemId, size: i64, mtime_ms: i64) -> Result<()> {
        self.with(|c| {
            c.execute("UPDATE items SET size = ?, mtime_ms = ?, bytes_done = 0, updated_at = ? WHERE id = ?", params![size, mtime_ms, now_ms(), id])
                .map(|_| ())
        })
    }

    /// Saved byte counts of these items (to add live progress on top).
    pub fn saved_bytes(&self, ids: &[ItemId]) -> Result<std::collections::HashMap<ItemId, i64>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT bytes_done FROM items WHERE id = ?")?;
            let mut out = std::collections::HashMap::new();
            for id in ids {
                if let Some(b) = st.query_row([id], |r| r.get::<_, i64>(0)).optional()? {
                    out.insert(*id, b);
                }
            }
            Ok(out)
        })
    }

    pub fn set_progress(&self, id: ItemId, bytes: i64) -> Result<()> {
        self.with(|c| c.execute("UPDATE items SET bytes_done = ? WHERE id = ?", params![bytes, id]).map(|_| ()))
    }

    pub fn set_etag(&self, id: ItemId, etag: Option<&str>) -> Result<()> {
        self.with(|c| c.execute("UPDATE items SET etag = ? WHERE id = ?", params![etag, id]).map(|_| ()))
    }

    pub fn finish(&self, id: ItemId, result_path: Option<&str>) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE items SET state = 'done', error = NULL, bytes_done = size, result_path = ?, session_id = NULL, updated_at = ? WHERE id = ?",
                params![result_path, now_ms(), id],
            )
            .map(|_| ())
        })
    }

    /// Retry failed (or waiting) items now. None batch = all.
    pub fn retry(&self, batch: Option<BatchId>, item: Option<ItemId>) -> Result<usize> {
        self.with(|c| {
            let n = match (batch, item) {
                (_, Some(id)) => c.execute("UPDATE items SET state = 'queued', error = NULL, next_try_at = 0 WHERE id = ? AND state IN ('failed', 'waiting', 'cancelled')", [id])?,
                (Some(b), None) => c.execute("UPDATE items SET state = 'queued', error = NULL, next_try_at = 0 WHERE batch_id = ? AND state IN ('failed', 'waiting')", [b])?,
                (None, None) => c.execute("UPDATE items SET state = 'queued', error = NULL, next_try_at = 0 WHERE state IN ('failed', 'waiting')", [])?,
            };
            c.execute("UPDATE batches SET state = 'active', finished_at = NULL WHERE state = 'done' AND id IN (SELECT batch_id FROM items WHERE state = 'queued')", [])?;
            Ok(n)
        })
    }

    /// Cancel a batch's (or one item's) remaining work. Returns their upload session ids.
    pub fn cancel(&self, batch: BatchId, item: Option<ItemId>) -> Result<Vec<String>> {
        self.with(|c| {
            let tx = c.transaction()?;
            let sessions: Vec<String> = {
                let (sql, p): (&str, Vec<i64>) = match item {
                    Some(id) => ("SELECT session_id FROM items WHERE id = ? AND session_id IS NOT NULL", vec![id]),
                    None => ("SELECT session_id FROM items WHERE batch_id = ? AND session_id IS NOT NULL AND state != 'done'", vec![batch]),
                };
                let mut st = tx.prepare(sql)?;
                let rows = st.query_map(rusqlite::params_from_iter(p), |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            match item {
                Some(id) => tx.execute("UPDATE items SET state = 'cancelled', session_id = NULL WHERE id = ? AND state != 'done'", [id])?,
                None => {
                    tx.execute("UPDATE items SET state = 'cancelled', session_id = NULL WHERE batch_id = ? AND state IN ('checking', 'queued', 'running', 'waiting', 'conflict')", [batch])?;
                    tx.execute("UPDATE batches SET state = 'cancelled', finished_at = ? WHERE id = ?", params![now_ms(), batch])?
                }
            };
            tx.commit()?;
            Ok(sessions)
        })
    }

    // ── views ────────────────────────────────────────────────────────────────

    pub fn batches(&self, include_finished: bool) -> Result<Vec<BatchView>> {
        self.with(|c| {
            let mut st = c.prepare(&format!(
                "SELECT b.id, b.direction, b.title, b.remote_dir, b.local_dir, b.state, b.paused, b.created_at, b.finished_at, b.last_error,
                   COUNT(i.id), SUM(i.state = 'done'), SUM(i.state = 'failed'), SUM(i.state = 'conflict'), SUM(i.state = 'skipped'),
                   COALESCE(SUM(CASE WHEN i.state IN ('skipped', 'cancelled') THEN 0 ELSE i.size END), 0),
                   COALESCE(SUM(CASE WHEN i.state = 'done' THEN i.size WHEN i.state IN ('skipped', 'cancelled') THEN 0 ELSE i.bytes_done END), 0),
                   (SELECT error FROM items e WHERE e.batch_id = b.id AND e.state IN ('failed', 'waiting') AND e.error IS NOT NULL ORDER BY e.updated_at DESC LIMIT 1)
                 FROM batches b LEFT JOIN items i ON i.batch_id = b.id AND i.kind = 'file'
                 {}
                 GROUP BY b.id ORDER BY b.id DESC LIMIT 500",
                if include_finished { "" } else { "WHERE b.state NOT IN ('done', 'cancelled')" }
            ))?;
            let rows = st
                .query_map([], |r| {
                    let state: String = r.get(5)?;
                    let last_error: Option<String> = r.get(9)?;
                    let item_error: Option<String> = r.get(17)?;
                    Ok(BatchView {
                        id: r.get(0)?,
                        direction: Direction::parse(&r.get::<_, String>(1)?),
                        title: r.get(2)?,
                        remote_dir: r.get(3)?,
                        local_dir: r.get(4)?,
                        scanning: state == "scanning" || state == "rescan",
                        state,
                        paused: r.get(6)?,
                        created_at: r.get(7)?,
                        finished_at: r.get(8)?,
                        files_total: r.get(10)?,
                        files_done: r.get::<_, Option<i64>>(11)?.unwrap_or(0),
                        files_failed: r.get::<_, Option<i64>>(12)?.unwrap_or(0),
                        files_conflict: r.get::<_, Option<i64>>(13)?.unwrap_or(0),
                        files_skipped: r.get::<_, Option<i64>>(14)?.unwrap_or(0),
                        bytes_total: r.get(15)?,
                        bytes_done: r.get(16)?,
                        bytes_per_second: 0.0,
                        last_error: last_error.or(item_error),
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn items(&self, batch: BatchId, offset: i64, limit: i64) -> Result<Vec<ItemView>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT id, batch_id, local_path, remote_path, size, bytes_done, state, error, attempts, result_path, next_try_at
                 FROM items WHERE batch_id = ? AND kind = 'file'
                 ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'conflict' THEN 1 WHEN 'failed' THEN 2 WHEN 'waiting' THEN 3 WHEN 'queued' THEN 4 ELSE 5 END, id
                 LIMIT ? OFFSET ?",
            )?;
            let rows = st
                .query_map(params![batch, limit, offset], |r| {
                    Ok(ItemView {
                        id: r.get(0)?,
                        batch_id: r.get(1)?,
                        local_path: r.get(2)?,
                        remote_path: r.get(3)?,
                        size: r.get(4)?,
                        bytes_done: r.get(5)?,
                        state: ItemState::parse(&r.get::<_, String>(6)?),
                        error: r.get(7)?,
                        attempts: r.get(8)?,
                        result_path: r.get(9)?,
                        next_try_at: r.get(10)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Counts for the snapshot: (queued, waiting, failed, conflicts, paused_open, bytes_total, bytes_done) over unfinished batches.
    pub fn totals(&self) -> Result<Totals> {
        self.with(|c| {
            c.query_row(
                "SELECT
                   COALESCE(SUM(i.state IN ('queued', 'checking') AND b.paused = 0), 0),
                   COALESCE(SUM(i.state = 'waiting' AND b.paused = 0), 0),
                   COALESCE(SUM(i.state = 'failed'), 0),
                   COALESCE(SUM(i.state = 'conflict'), 0),
                   COALESCE(SUM(i.state IN ('queued', 'waiting', 'running') AND b.paused = 1), 0),
                   COALESCE(SUM(CASE WHEN i.state IN ('skipped', 'cancelled', 'failed') THEN 0 ELSE i.size END), 0),
                   COALESCE(SUM(CASE WHEN i.state = 'done' THEN i.size WHEN i.state IN ('checking', 'queued', 'waiting', 'running', 'conflict') THEN i.bytes_done ELSE 0 END), 0)
                 FROM items i JOIN batches b ON b.id = i.batch_id
                 WHERE b.state NOT IN ('done', 'cancelled') AND i.kind = 'file'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
        })
    }
}

fn item_from_row(r: &Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: r.get(0)?,
        batch_id: r.get(1)?,
        direction: Direction::parse(&r.get::<_, String>(2)?),
        kind: r.get(3)?,
        local_path: r.get(4)?,
        remote_path: r.get(5)?,
        remote_dir: r.get(6)?,
        size: r.get(7)?,
        mtime_ms: r.get(8)?,
        conflict: r.get(9)?,
        policy: OnConflict::parse(&r.get::<_, String>(10)?).unwrap_or(OnConflict::KeepBoth),
        state: ItemState::parse(&r.get::<_, String>(11)?),
        attempts: r.get(12)?,
        bytes_done: r.get(13)?,
        session_id: r.get(14)?,
        client_ref: r.get(15)?,
        etag: r.get(16)?,
    })
}
