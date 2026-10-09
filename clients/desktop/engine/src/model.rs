//! Types shared by the engine and the app.

use serde::{Deserialize, Serialize};

pub type BatchId = i64;
pub type ItemId = i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Upload,
    Download,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Upload => "upload",
            Direction::Download => "download",
        }
    }
    pub fn parse(s: &str) -> Direction {
        if s == "download" {
            Direction::Download
        } else {
            Direction::Upload
        }
    }
}

/// What to do when an uploaded file's name is already taken in Loom.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnConflict {
    /// Check first and let the user decide per file (Replace / Skip / Keep both).
    Ask,
    /// The new file gets a numbered name, e.g. `photo (1).jpg`.
    KeepBoth,
    /// The existing file goes to Loom's Trash.
    Replace,
    /// Existing files are left alone; the new one isn't sent.
    Skip,
}

impl OnConflict {
    pub fn as_str(self) -> &'static str {
        match self {
            OnConflict::Ask => "ask",
            OnConflict::KeepBoth => "keep_both",
            OnConflict::Replace => "replace",
            OnConflict::Skip => "skip",
        }
    }
    pub fn parse(s: &str) -> Option<OnConflict> {
        Some(match s {
            "ask" => OnConflict::Ask,
            "keep_both" => OnConflict::KeepBoth,
            "replace" => OnConflict::Replace,
            "skip" => OnConflict::Skip,
            _ => return None,
        })
    }
}

/// Where an item is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    /// Waiting for the check whether its name is taken in Loom.
    Checking,
    Queued,
    Running,
    /// Waiting to retry after a network or server problem.
    Waiting,
    /// The name is taken; waiting for the user's decision.
    Conflict,
    Done,
    Skipped,
    Failed,
    Cancelled,
}

impl ItemState {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemState::Checking => "checking",
            ItemState::Queued => "queued",
            ItemState::Running => "running",
            ItemState::Waiting => "waiting",
            ItemState::Conflict => "conflict",
            ItemState::Done => "done",
            ItemState::Skipped => "skipped",
            ItemState::Failed => "failed",
            ItemState::Cancelled => "cancelled",
        }
    }
    pub fn parse(s: &str) -> ItemState {
        match s {
            "checking" => ItemState::Checking,
            "running" => ItemState::Running,
            "waiting" => ItemState::Waiting,
            "conflict" => ItemState::Conflict,
            "done" => ItemState::Done,
            "skipped" => ItemState::Skipped,
            "failed" => ItemState::Failed,
            "cancelled" => ItemState::Cancelled,
            _ => ItemState::Queued,
        }
    }
    /// Still has work to do.
    pub fn is_open(self) -> bool {
        matches!(self, ItemState::Checking | ItemState::Queued | ItemState::Running | ItemState::Waiting | ItemState::Conflict)
    }
}

/// A file or folder the user handed over for upload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadSource {
    pub path: std::path::PathBuf,
    /// Decided beforehand (e.g. in the web page's conflict dialog); None = the batch's policy.
    #[serde(default)]
    pub conflict: Option<OnConflict>,
    /// Path inside the destination folder; None = the file's or folder's own name.
    #[serde(default)]
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadRequest {
    /// Destination folder in Loom ("" = top level).
    pub dest_dir: String,
    pub sources: Vec<UploadSource>,
    pub on_conflict: OnConflict,
    /// Shown in the Transfers list; None = made from the sources.
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEntry {
    /// Path in Loom.
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRequest {
    pub entries: Vec<RemoteEntry>,
    /// Local folder the files go into.
    pub local_dir: std::path::PathBuf,
    #[serde(default)]
    pub title: Option<String>,
}

/// One row in the Transfers list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchView {
    pub id: BatchId,
    pub direction: Direction,
    pub title: String,
    pub remote_dir: String,
    pub local_dir: Option<String>,
    pub state: String,
    pub paused: bool,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub files_total: i64,
    pub files_done: i64,
    pub files_failed: i64,
    pub files_conflict: i64,
    pub files_skipped: i64,
    pub bytes_total: i64,
    pub bytes_done: i64,
    pub bytes_per_second: f64,
    pub scanning: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    pub id: ItemId,
    pub batch_id: BatchId,
    pub local_path: String,
    pub remote_path: String,
    pub size: i64,
    pub bytes_done: i64,
    pub state: ItemState,
    pub error: Option<String>,
    pub attempts: i64,
    pub result_path: Option<String>,
    pub next_try_at: i64,
}

/// A file whose name is taken in Loom, waiting for a decision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub item_id: ItemId,
    pub relative_path: String,
    pub incoming_size: i64,
    pub incoming_modified_ms: i64,
    pub existing_size: Option<i64>,
    pub existing_modified: Option<String>,
    /// The existing one is a folder: only Keep both or Skip.
    pub existing_is_folder: bool,
    /// Same size and date: probably the same file.
    pub same: bool,
}

/// Totals for the tray icon and the web page's pill.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub active: i64,
    pub queued: i64,
    pub paused: i64,
    pub waiting: i64,
    pub failed: i64,
    pub conflicts: i64,
    pub bytes_done: i64,
    pub bytes_total: i64,
    pub bytes_per_second: f64,
    /// "lan" when transfers go straight over the local network.
    pub via: Option<String>,
    /// The server can't be reached; transfers resume when it can.
    pub offline: bool,
    /// The device was removed or its token is no longer valid.
    pub signed_out: bool,
    /// Loom's drive is full; uploads are paused.
    pub disk_full: bool,
    pub all_paused: bool,
}

/// Things the app should tell the user about.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    BatchFinished { batch_id: BatchId, title: String, direction: Direction, done: i64, failed: i64, skipped: i64 },
    #[serde(rename_all = "camelCase")]
    ConflictsFound { batch_id: BatchId, count: i64 },
    SignedOut,
    DiskFull,
    #[serde(rename_all = "camelCase")]
    ScanFinished { batch_id: BatchId, files: i64 },
}
