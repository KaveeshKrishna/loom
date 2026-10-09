package app.loom.engine

/*
 * Types shared by the engine and the app. A port of the Windows app's
 * engine (clients/desktop/engine, Rust): same protocol, same queue, same
 * behaviour, so the two apps act the same.
 */

typealias BatchId = Long
typealias ItemId = Long

enum class Direction(val wire: String) {
    Upload("upload"),
    Download("download");

    companion object {
        fun parse(s: String) = if (s == "download") Download else Upload
    }
}

/** What to do when an uploaded file's name is already taken in Loom. */
enum class OnConflict(val wire: String) {
    /** Check first and let the user decide per file (Replace / Skip / Keep both). */
    Ask("ask"),

    /** The new file gets a numbered name, e.g. `photo (1).jpg`. */
    KeepBoth("keep_both"),

    /** The existing file goes to Loom's Trash. */
    Replace("replace"),

    /** Existing files are left alone; the new one isn't sent. */
    Skip("skip");

    companion object {
        fun parse(s: String?) = entries.firstOrNull { it.wire == s }
    }
}

/** Where an item is in its life. */
enum class ItemState(val wire: String) {
    /** Waiting for the check whether its name is taken in Loom. */
    Checking("checking"),
    Queued("queued"),
    Running("running"),

    /** Waiting to retry after a network or server problem. */
    Waiting("waiting"),

    /** The name is taken; waiting for the user's decision. */
    Conflict("conflict"),
    Done("done"),
    Skipped("skipped"),
    Failed("failed"),
    Cancelled("cancelled");

    /** Still has work to do. */
    val isOpen get() = this == Checking || this == Queued || this == Running || this == Waiting || this == Conflict

    companion object {
        fun parse(s: String) = entries.firstOrNull { it.wire == s } ?: Queued
    }
}

/**
 * A file or folder the user handed over for upload. [path] is whatever the
 * platform's [LocalFiles] understands: a file path, or a content:// URI.
 */
data class UploadSource(
    val path: String,
    /** Decided beforehand; null = the batch's policy. */
    val conflict: OnConflict? = null,
    /** Path inside the destination folder; null = the file's or folder's own name. */
    val relativePath: String? = null,
)

data class UploadRequest(
    /** Destination folder in Loom ("" = top level). */
    val destDir: String,
    val sources: List<UploadSource>,
    val onConflict: OnConflict,
    val title: String? = null,
)

data class RemoteEntry(
    /** Path in Loom. */
    val path: String,
    val name: String,
    val isDir: Boolean,
)

data class DownloadRequest(
    val entries: List<RemoteEntry>,
    /** Where the files go, as the platform's [LocalFiles] understands it. */
    val localDir: String,
    val title: String? = null,
    /** One ZIP of all the entries instead of separate files (can't resume). */
    val zip: Boolean = false,
)

/** One row in the Transfers list. */
data class BatchView(
    val id: BatchId,
    val direction: Direction,
    val title: String,
    val remoteDir: String,
    val localDir: String?,
    val state: String,
    val paused: Boolean,
    val createdAt: Long,
    val finishedAt: Long?,
    val filesTotal: Long,
    val filesDone: Long,
    val filesFailed: Long,
    val filesConflict: Long,
    val filesSkipped: Long,
    val bytesTotal: Long,
    val bytesDone: Long,
    val bytesPerSecond: Double,
    val scanning: Boolean,
    val lastError: String?,
) {
    val finished get() = state == "done" || state == "cancelled"
}

data class ItemView(
    val id: ItemId,
    val batchId: BatchId,
    val localPath: String,
    val remotePath: String,
    val size: Long,
    val bytesDone: Long,
    val state: ItemState,
    val error: String?,
    val attempts: Long,
    val resultPath: String?,
    val nextTryAt: Long,
)

/** A file whose name is taken in Loom, waiting for a decision. */
data class ConflictView(
    val itemId: ItemId,
    val relativePath: String,
    val incomingSize: Long,
    val incomingModifiedMs: Long,
    val existingSize: Long?,
    val existingModified: String?,
    /** The existing one is a folder: only Keep both or Skip. */
    val existingIsFolder: Boolean,
    /** Same size and date: probably the same file. */
    val same: Boolean,
)

/** Totals for the notification, the progress strip and the web page's pill. */
data class Snapshot(
    val active: Long = 0,
    val queued: Long = 0,
    val paused: Long = 0,
    val waiting: Long = 0,
    val failed: Long = 0,
    val conflicts: Long = 0,
    val bytesDone: Long = 0,
    val bytesTotal: Long = 0,
    val bytesPerSecond: Double = 0.0,
    /** "lan" when transfers go straight over the local network. */
    val via: String? = null,
    /** The server can't be reached; transfers resume when it can. */
    val offline: Boolean = false,
    /** The device was removed or its token is no longer valid. */
    val signedOut: Boolean = false,
    /** Loom's drive is full; uploads are paused. */
    val diskFull: Boolean = false,
    val allPaused: Boolean = false,
    /** "Wi-Fi only" is on and the phone is on mobile data. */
    val waitingForWifi: Boolean = false,
) {
    /** Anything left to do (running, queued, waiting or asking). */
    val busy get() = active > 0 || queued > 0 || waiting > 0 || conflicts > 0
}

/** Things the app should tell the user about. */
sealed interface EngineEvent {
    data class BatchFinished(val batchId: BatchId, val title: String, val direction: Direction, val done: Long, val failed: Long, val skipped: Long) : EngineEvent
    data class ConflictsFound(val batchId: BatchId, val count: Long) : EngineEvent
    data object SignedOut : EngineEvent
    data object DiskFull : EngineEvent
    data class ScanFinished(val batchId: BatchId, val files: Long) : EngineEvent
}

/** User-adjustable settings. */
data class Settings(
    /** Files transferred at the same time. */
    val parallelFiles: Int = 3,
    /** Chunks of one file sent at the same time. */
    val parallelChunks: Int = 2,
    /** Bytes per second, 0 = no limit. */
    val speedLimit: Long = 0,
    /** Chunk size over the internet (smaller copes better with slow links). */
    val chunkInternet: Long = 4L shl 20,
    /** Chunk size on the home network. */
    val chunkLan: Long = 8L shl 20,
    /** Go straight to the server's LAN address when it answers. */
    val useLan: Boolean = true,
    /** Wait for Wi-Fi (or Ethernet) instead of using mobile data. */
    val wifiOnly: Boolean = false,
)
