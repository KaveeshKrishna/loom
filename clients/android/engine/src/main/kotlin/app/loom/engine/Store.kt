package app.loom.engine

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import java.io.File
import java.security.SecureRandom

/*
 * The transfer queue on disk (SQLite). Everything the engine knows lives
 * here, so closing the app, Android stopping it or a reboot loses nothing:
 * on start, items that were running go back to the queue and continue from
 * what the server says it has. Same schema as the Windows app.
 */

private val SCHEMA = listOf(
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      title TEXT NOT NULL,
      remote_dir TEXT NOT NULL,
      local_dir TEXT,
      on_conflict TEXT NOT NULL,
      state TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    )""",
    """CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      local_path TEXT NOT NULL,
      remote_path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      conflict TEXT,
      existing TEXT,
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
    )""",
    "CREATE INDEX IF NOT EXISTS items_pick ON items (state, next_try_at, id)",
    "CREATE INDEX IF NOT EXISTS items_batch ON items (batch_id, id)",
)

fun nowMs() = System.currentTimeMillis()

/** An item as the workers see it. */
data class Item(
    val id: ItemId,
    val batchId: BatchId,
    val direction: Direction,
    /** file | dir | zip */
    val kind: String,
    val localPath: String,
    val remotePath: String,
    val remoteDir: String,
    val size: Long,
    val mtimeMs: Long,
    val conflict: String?,
    /** The batch's "if the name is taken" policy (for items without their own decision). */
    val policy: OnConflict,
    val state: ItemState,
    val attempts: Long,
    val bytesDone: Long,
    val sessionId: String?,
    val clientRef: String,
    val etag: String?,
)

data class BatchInfo(val direction: Direction, val title: String, val remoteDir: String, val localDir: String?, val policy: OnConflict, val state: String)

data class FinishedBatch(val id: BatchId, val title: String, val direction: Direction, val done: Long, val failed: Long, val skipped: Long)

data class Totals(val queued: Long, val waiting: Long, val failed: Long, val conflicts: Long, val paused: Long, val bytesTotal: Long, val bytesDone: Long)

/** One file for insertItems. */
data class NewItem(
    val kind: String,
    val localPath: String,
    val remotePath: String,
    val size: Long,
    val mtimeMs: Long,
    val conflict: OnConflict?,
)

private val random = SecureRandom()

private fun newRef(): String {
    val b = ByteArray(16)
    random.nextBytes(b)
    return "loom-" + b.joinToString("") { "%02x".format(it) }
}

class Store private constructor(private val conn: SQLiteConnection) {
    companion object {
        fun open(file: File): Store {
            file.parentFile?.mkdirs()
            val s = Store(BundledSQLiteDriver().open(file.path))
            s.init()
            s.recover()
            return s
        }

        fun inMemory(): Store = Store(BundledSQLiteDriver().open(":memory:")).also { it.init() }
    }

    private val lock = Any()

    private fun init() = synchronized(lock) {
        conn.execSQL("PRAGMA busy_timeout = 5000")
        for (s in SCHEMA) conn.prepare(s).use { st -> while (st.step()) Unit }
    }

    private fun SQLiteStatement.bindAll(args: Array<out Any?>) {
        args.forEachIndexed { i, a ->
            val n = i + 1
            when (a) {
                null -> bindNull(n)
                is String -> bindText(n, a)
                is Long -> bindLong(n, a)
                is Int -> bindLong(n, a.toLong())
                is Boolean -> bindLong(n, if (a) 1 else 0)
                is Double -> bindDouble(n, a)
                else -> bindText(n, a.toString())
            }
        }
    }

    /** Run a statement; returns the number of rows it changed. */
    private fun exec(sql: String, vararg args: Any?): Int {
        conn.prepare(sql).use { st ->
            st.bindAll(args)
            while (st.step()) Unit
        }
        return conn.prepare("SELECT changes()").use { it.step(); it.getLong(0).toInt() }
    }

    private fun <T> rows(sql: String, vararg args: Any?, map: (SQLiteStatement) -> T): List<T> =
        conn.prepare(sql).use { st ->
            st.bindAll(args)
            val out = ArrayList<T>()
            while (st.step()) out += map(st)
            out
        }

    private fun SQLiteStatement.text(i: Int): String? = if (isNull(i)) null else getText(i)
    private fun SQLiteStatement.lng(i: Int): Long = if (isNull(i)) 0 else getLong(i)
    private fun SQLiteStatement.lngOrNull(i: Int): Long? = if (isNull(i)) null else getLong(i)

    private fun <T> tx(block: () -> T): T {
        conn.execSQL("BEGIN IMMEDIATE")
        try {
            val r = block()
            conn.execSQL("COMMIT")
            return r
        } catch (e: Throwable) {
            runCatching { conn.execSQL("ROLLBACK") }
            throw e
        }
    }

    private inline fun <T> locked(block: () -> T): T = synchronized(lock) { block() }

    /** After a crash or restart: whatever was running starts again (it resumes). */
    private fun recover() = locked {
        exec("UPDATE items SET state = 'queued', next_try_at = 0 WHERE state = 'running'")
        // A folder that was being scanned is scanned again from the start.
        exec("UPDATE batches SET state = 'rescan' WHERE state = 'scanning'")
    }

    fun close() = locked { conn.close() }

    // ── meta ─────────────────────────────────────────────────────────────────

    fun getMeta(key: String): String? = locked { rows("SELECT value FROM meta WHERE key = ?", key) { it.getText(0) }.firstOrNull() }

    fun setMeta(key: String, value: String) = locked {
        exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
        Unit
    }

    // ── batches ──────────────────────────────────────────────────────────────

    fun createBatch(dir: Direction, title: String, remoteDir: String, localDir: String?, onConflict: OnConflict): BatchId = locked {
        exec(
            "INSERT INTO batches (direction, title, remote_dir, local_dir, on_conflict, state, created_at) VALUES (?, ?, ?, ?, ?, 'scanning', ?)",
            dir.wire, title, remoteDir, localDir, onConflict.wire, nowMs(),
        )
        rows("SELECT last_insert_rowid()") { it.getLong(0) }.first()
    }

    fun batchInfo(id: BatchId): BatchInfo? = locked {
        rows("SELECT direction, title, remote_dir, local_dir, on_conflict, state FROM batches WHERE id = ?", id) {
            BatchInfo(Direction.parse(it.getText(0)), it.getText(1), it.getText(2), it.text(3), OnConflict.parse(it.getText(4)) ?: OnConflict.KeepBoth, it.getText(5))
        }.firstOrNull()
    }

    fun setBatchState(id: BatchId, state: String) = locked {
        val finished = if (state == "done" || state == "cancelled") nowMs() else null
        exec("UPDATE batches SET state = ?, finished_at = ? WHERE id = ?", state, finished, id)
        Unit
    }

    fun setBatchError(id: BatchId, err: String?) = locked {
        exec("UPDATE batches SET last_error = ? WHERE id = ?", err, id)
        Unit
    }

    /** Batches whose folders must be (re)scanned. */
    fun batchesToScan(): List<BatchId> = locked { rows("SELECT id FROM batches WHERE state = 'rescan'") { it.getLong(0) } }

    fun setPaused(batch: BatchId?, paused: Boolean) = locked {
        if (batch != null) exec("UPDATE batches SET paused = ? WHERE id = ?", paused, batch)
        else exec("UPDATE batches SET paused = ? WHERE state IN ('scanning', 'rescan', 'active')", paused)
        Unit
    }

    fun removeBatch(id: BatchId) = locked {
        exec("DELETE FROM batches WHERE id = ?", id)
        Unit
    }

    /** Forget finished batches (the "Clear finished" button). */
    fun clearFinished(): Int = locked { exec("DELETE FROM batches WHERE state IN ('done', 'cancelled')") }

    /** Mark batches with nothing left to do as done; returns them with their counts. */
    fun finishBatches(): List<FinishedBatch> = locked {
        val done = rows(
            """SELECT b.id, b.title, b.direction,
                 SUM(i.state = 'done'), SUM(i.state = 'failed'), SUM(i.state = 'skipped')
               FROM batches b LEFT JOIN items i ON i.batch_id = b.id
               WHERE b.state = 'active'
               GROUP BY b.id
               HAVING SUM(i.state IN ('checking', 'queued', 'running', 'waiting', 'conflict')) = 0 OR COUNT(i.id) = 0""",
        ) { FinishedBatch(it.getLong(0), it.getText(1), Direction.parse(it.getText(2)), it.lng(3), it.lng(4), it.lng(5)) }
        for (b in done) exec("UPDATE batches SET state = 'done', finished_at = ? WHERE id = ?", nowMs(), b.id)
        done
    }

    // ── items ────────────────────────────────────────────────────────────────

    /**
     * Add items. Files without their own decision start in "checking" when
     * the batch's policy needs to know about existing names (Ask, Skip).
     */
    fun insertItems(batch: BatchId, policy: OnConflict, items: List<NewItem>) = locked {
        if (items.isEmpty()) return@locked
        tx {
            val now = nowMs()
            conn.prepare(
                """INSERT INTO items (batch_id, kind, local_path, remote_path, size, mtime_ms, conflict, state, client_ref, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ).use { st ->
                for (it in items) {
                    val check = it.kind == "file" && it.conflict == null && (policy == OnConflict.Ask || policy == OnConflict.Skip)
                    val decided = it.conflict?.wire
                    val state = when {
                        check -> "checking"
                        decided == "skip" -> "skipped"
                        else -> "queued"
                    }
                    st.reset()
                    st.clearBindings()
                    st.bindAll(arrayOf(batch, it.kind, it.localPath, it.remotePath, it.size, it.mtimeMs, decided, state, newRef(), now))
                    while (st.step()) Unit
                }
            }
        }
    }

    /** Remote paths already in a batch (so a resumed scan doesn't add them twice). */
    fun batchPaths(batch: BatchId): Set<String> = locked { rows("SELECT remote_path FROM items WHERE batch_id = ?", batch) { it.getText(0) }.toHashSet() }

    /** Up to [limit] files waiting for the name check: (id, remotePath, size, mtime). */
    fun checking(batch: BatchId, limit: Int): List<Item4> = locked {
        rows("SELECT id, remote_path, size, mtime_ms FROM items WHERE batch_id = ? AND state = 'checking' ORDER BY id LIMIT ?", batch, limit) {
            Item4(it.getLong(0), it.getText(1), it.getLong(2), it.getLong(3))
        }
    }

    data class Item4(val id: ItemId, val remotePath: String, val size: Long, val mtimeMs: Long)

    /** After the name check: these go ahead (queued), the rest were handled by ask/skip. */
    fun checked(ids: List<ItemId>) = locked {
        if (ids.isEmpty()) return@locked
        tx { for (id in ids) exec("UPDATE items SET state = 'queued' WHERE id = ? AND state = 'checking'", id) }
    }

    fun skipItem(id: ItemId) = locked {
        exec("UPDATE items SET state = 'skipped', conflict = 'skip', updated_at = ? WHERE id = ?", nowMs(), id)
        Unit
    }

    fun askConflict(item: ItemId, existingJson: String) = locked {
        exec("UPDATE items SET state = 'conflict', conflict = 'ask', existing = ?, updated_at = ? WHERE id = ?", existingJson, nowMs(), item)
        Unit
    }

    /** Answer conflicts: null item = every waiting one in the batch. */
    fun decide(batch: BatchId, item: ItemId?, decision: OnConflict): Int = locked {
        val (state, conflict) = when (decision) {
            OnConflict.Skip -> "skipped" to "skip"
            OnConflict.Replace -> "queued" to "replace"
            else -> "queued" to "keep_both"
        }
        if (item != null) {
            exec(
                "UPDATE items SET state = ?, conflict = ?, existing = NULL, updated_at = ? WHERE id = ? AND batch_id = ? AND state = 'conflict'",
                state, conflict, nowMs(), item, batch,
            )
        } else {
            exec("UPDATE items SET state = ?, conflict = ?, existing = NULL, updated_at = ? WHERE batch_id = ? AND state = 'conflict'", state, conflict, nowMs(), batch)
        }
    }

    fun conflicts(batch: BatchId): List<ConflictView> = locked {
        rows("SELECT id, remote_path, size, mtime_ms, existing FROM items WHERE batch_id = ? AND state = 'conflict' ORDER BY id", batch) {
            val ex = it.text(4)?.let { s -> runCatching { json.parseToJsonElement(s).obj() }.getOrNull() }
            ConflictView(
                itemId = it.getLong(0),
                relativePath = it.getText(1),
                incomingSize = it.getLong(2),
                incomingModifiedMs = it.getLong(3),
                existingSize = ex?.get("size").long(),
                existingModified = ex?.get("modifiedAt").str(),
                existingIsFolder = ex?.get("type").str() == "DIRECTORY",
                same = ex?.get("same").bool() ?: false,
            )
        }
    }

    private val itemCols =
        """i.id, i.batch_id, b.direction, i.kind, i.local_path, i.remote_path, b.remote_dir, i.size, i.mtime_ms,
           i.conflict, b.on_conflict, i.state, i.attempts, i.bytes_done, i.session_id, i.client_ref, i.etag"""

    private fun itemFrom(r: SQLiteStatement) = Item(
        id = r.getLong(0),
        batchId = r.getLong(1),
        direction = Direction.parse(r.getText(2)),
        kind = r.getText(3),
        localPath = r.getText(4),
        remotePath = r.getText(5),
        remoteDir = r.getText(6),
        size = r.getLong(7),
        mtimeMs = r.getLong(8),
        conflict = r.text(9),
        policy = OnConflict.parse(r.getText(10)) ?: OnConflict.KeepBoth,
        state = ItemState.parse(r.getText(11)),
        attempts = r.getLong(12),
        bytesDone = r.getLong(13),
        sessionId = r.text(14),
        clientRef = r.getText(15),
        etag = r.text(16),
    )

    /** Next items to start: queued (or waiting whose time has come), oldest batch first. */
    fun pick(limit: Int, exclude: Collection<ItemId>, uploadsAllowed: Boolean = true): List<Item> = locked {
        rows(
            """SELECT $itemCols FROM items i JOIN batches b ON b.id = i.batch_id
               WHERE i.state IN ('queued', 'waiting') AND i.next_try_at <= ? AND b.paused = 0 AND b.state IN ('active', 'scanning', 'rescan')
               ${if (uploadsAllowed) "" else "AND b.direction = 'download'"}
               ORDER BY b.id, i.id LIMIT ?""",
            nowMs(), limit + exclude.size,
        ) { itemFrom(it) }.filter { it.id !in exclude }.take(limit)
    }

    fun getItem(id: ItemId): Item? = locked {
        rows("SELECT $itemCols FROM items i JOIN batches b ON b.id = i.batch_id WHERE i.id = ?", id) { itemFrom(it) }.firstOrNull()
    }

    fun setState(id: ItemId, state: ItemState, error: String? = null) = locked {
        exec("UPDATE items SET state = ?, error = ?, updated_at = ? WHERE id = ?", state.wire, error, nowMs(), id)
        Unit
    }

    fun setWaiting(id: ItemId, error: String, nextTryAt: Long) = locked {
        exec("UPDATE items SET state = 'waiting', error = ?, attempts = attempts + 1, next_try_at = ?, updated_at = ? WHERE id = ?", error, nextTryAt, nowMs(), id)
        Unit
    }

    fun setSession(id: ItemId, session: String?) = locked {
        exec("UPDATE items SET session_id = ?, updated_at = ? WHERE id = ?", session, nowMs(), id)
        Unit
    }

    fun setSource(id: ItemId, size: Long, mtimeMs: Long) = locked {
        exec("UPDATE items SET size = ?, mtime_ms = ?, bytes_done = 0, updated_at = ? WHERE id = ?", size, mtimeMs, nowMs(), id)
        Unit
    }

    /** Saved byte counts of these items (to add live progress on top). */
    fun savedBytes(ids: Collection<ItemId>): Map<ItemId, Long> = locked {
        ids.associateWith { id -> rows("SELECT bytes_done FROM items WHERE id = ?", id) { it.getLong(0) }.firstOrNull() ?: 0L }
    }

    fun setProgress(id: ItemId, bytes: Long) = locked {
        exec("UPDATE items SET bytes_done = ? WHERE id = ?", bytes, id)
        Unit
    }

    fun setSize(id: ItemId, size: Long) = locked {
        exec("UPDATE items SET size = ? WHERE id = ?", size, id)
        Unit
    }

    fun setEtag(id: ItemId, etag: String?) = locked {
        exec("UPDATE items SET etag = ? WHERE id = ?", etag, id)
        Unit
    }

    fun finish(id: ItemId, resultPath: String?) = locked {
        exec(
            "UPDATE items SET state = 'done', error = NULL, bytes_done = size, result_path = ?, session_id = NULL, updated_at = ? WHERE id = ?",
            resultPath, nowMs(), id,
        )
        Unit
    }

    /** Retry failed (or waiting) items now. Null batch = all. */
    fun retry(batch: BatchId?, item: ItemId?): Int = locked {
        val n = when {
            item != null -> exec("UPDATE items SET state = 'queued', error = NULL, next_try_at = 0 WHERE id = ? AND state IN ('failed', 'waiting', 'cancelled')", item)
            batch != null -> exec("UPDATE items SET state = 'queued', error = NULL, next_try_at = 0 WHERE batch_id = ? AND state IN ('failed', 'waiting')", batch)
            else -> exec("UPDATE items SET state = 'queued', error = NULL, next_try_at = 0 WHERE state IN ('failed', 'waiting')")
        }
        exec("UPDATE batches SET state = 'active', finished_at = NULL WHERE state IN ('done', 'cancelled') AND id IN (SELECT batch_id FROM items WHERE state = 'queued')")
        n
    }

    /** Cancel a batch's (or one item's) remaining work. Returns their upload session ids. */
    fun cancel(batch: BatchId, item: ItemId?): List<String> = locked {
        tx {
            val sessions = if (item != null) {
                rows("SELECT session_id FROM items WHERE id = ? AND session_id IS NOT NULL", item) { it.getText(0) }
            } else {
                rows("SELECT session_id FROM items WHERE batch_id = ? AND session_id IS NOT NULL AND state != 'done'", batch) { it.getText(0) }
            }
            if (item != null) {
                exec("UPDATE items SET state = 'cancelled', session_id = NULL WHERE id = ? AND state != 'done'", item)
            } else {
                exec("UPDATE items SET state = 'cancelled', session_id = NULL WHERE batch_id = ? AND state IN ('checking', 'queued', 'running', 'waiting', 'conflict')", batch)
                exec("UPDATE batches SET state = 'cancelled', finished_at = ? WHERE id = ?", nowMs(), batch)
            }
            sessions
        }
    }

    // ── views ────────────────────────────────────────────────────────────────

    fun batches(includeFinished: Boolean): List<BatchView> = locked {
        rows(
            """SELECT b.id, b.direction, b.title, b.remote_dir, b.local_dir, b.state, b.paused, b.created_at, b.finished_at, b.last_error,
                 COUNT(i.id), SUM(i.state = 'done'), SUM(i.state = 'failed'), SUM(i.state = 'conflict'), SUM(i.state = 'skipped'),
                 COALESCE(SUM(CASE WHEN i.state IN ('skipped', 'cancelled') THEN 0 ELSE i.size END), 0),
                 COALESCE(SUM(CASE WHEN i.state = 'done' THEN i.size WHEN i.state IN ('skipped', 'cancelled') THEN 0 ELSE i.bytes_done END), 0),
                 (SELECT error FROM items e WHERE e.batch_id = b.id AND e.state IN ('failed', 'waiting') AND e.error IS NOT NULL ORDER BY e.updated_at DESC LIMIT 1)
               FROM batches b LEFT JOIN items i ON i.batch_id = b.id AND i.kind != 'dir'
               ${if (includeFinished) "" else "WHERE b.state NOT IN ('done', 'cancelled')"}
               GROUP BY b.id ORDER BY b.id DESC LIMIT 500""",
        ) {
            val state = it.getText(5)
            BatchView(
                id = it.getLong(0),
                direction = Direction.parse(it.getText(1)),
                title = it.getText(2),
                remoteDir = it.getText(3),
                localDir = it.text(4),
                state = state,
                paused = it.lng(6) != 0L,
                createdAt = it.getLong(7),
                finishedAt = it.lngOrNull(8),
                filesTotal = it.lng(10),
                filesDone = it.lng(11),
                filesFailed = it.lng(12),
                filesConflict = it.lng(13),
                filesSkipped = it.lng(14),
                bytesTotal = it.lng(15),
                bytesDone = it.lng(16),
                bytesPerSecond = 0.0,
                scanning = state == "scanning" || state == "rescan",
                lastError = it.text(9) ?: it.text(17),
            )
        }
    }

    fun items(batch: BatchId, offset: Long, limit: Long): List<ItemView> = locked {
        rows(
            """SELECT id, batch_id, local_path, remote_path, size, bytes_done, state, error, attempts, result_path, next_try_at
               FROM items WHERE batch_id = ? AND kind != 'dir'
               ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'conflict' THEN 1 WHEN 'failed' THEN 2 WHEN 'waiting' THEN 3 WHEN 'queued' THEN 4 ELSE 5 END, id
               LIMIT ? OFFSET ?""",
            batch, limit, offset,
        ) {
            ItemView(it.getLong(0), it.getLong(1), it.getText(2), it.getText(3), it.getLong(4), it.getLong(5), ItemState.parse(it.getText(6)), it.text(7), it.getLong(8), it.text(9), it.getLong(10))
        }
    }

    /** Counts for the snapshot over unfinished batches. */
    fun totals(): Totals = locked {
        rows(
            """SELECT
                 COALESCE(SUM(i.state IN ('queued', 'checking') AND b.paused = 0), 0),
                 COALESCE(SUM(i.state = 'waiting' AND b.paused = 0), 0),
                 COALESCE(SUM(i.state = 'failed'), 0),
                 COALESCE(SUM(i.state = 'conflict'), 0),
                 COALESCE(SUM(i.state IN ('queued', 'waiting', 'running') AND b.paused = 1), 0),
                 COALESCE(SUM(CASE WHEN i.state IN ('skipped', 'cancelled', 'failed') THEN 0 ELSE i.size END), 0),
                 COALESCE(SUM(CASE WHEN i.state = 'done' THEN i.size WHEN i.state IN ('checking', 'queued', 'waiting', 'running', 'conflict') THEN i.bytes_done ELSE 0 END), 0)
               FROM items i JOIN batches b ON b.id = i.batch_id
               WHERE b.state NOT IN ('done', 'cancelled') AND i.kind != 'dir'""",
        ) { Totals(it.lng(0), it.lng(1), it.lng(2), it.lng(3), it.lng(4), it.lng(5), it.lng(6)) }.first()
    }

    /** Local paths of unfinished items (so the app knows which shared copies it still needs). */
    fun openLocalPaths(): List<String> = locked {
        rows("SELECT local_path FROM items WHERE state IN ('checking', 'queued', 'running', 'waiting', 'conflict')") { it.getText(0) }
    }
}
