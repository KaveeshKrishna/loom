package app.loom.engine

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.coroutineContext

/** Set when the user pauses or cancels; workers stop at the next chunk. */
class StopFlag {
    @Volatile var stopped = false
        private set

    fun stop() {
        stopped = true
    }
}

/** A transfer stopped early on purpose (paused or cancelled). */
class Stopped : Exception("Stopped")

private val OCTETS = "application/octet-stream".toMediaType()

internal class Ctx(
    val api: Api,
    val store: Store,
    val files: LocalFiles,
    val meter: Meter,
    val limiter: Limiter,
    val stop: StopFlag,
)

/*
 * Uploading one file: Loom's numbered-chunk protocol, resumable from
 * whatever the server already has (it's the source of truth: the engine
 * never needs to remember which chunks it sent).
 */
internal class Uploader(
    private val c: Ctx,
    private val parallelChunks: Int,
    private val chunkLan: Long,
    private val chunkInternet: Long,
    private val limits: UploadLimits?,
) {
    private fun chunkSizeFor(size: Long): Long {
        val want = if (c.api.via == Via.Lan) chunkLan else chunkInternet
        val maxChunks = limits?.maxChunks ?: 100_000
        // Huge files need bigger chunks to stay under the server's chunk count.
        val minForCount = (size + maxChunks - 1) / maxChunks.coerceAtLeast(1)
        return maxOf(want, minForCount).coerceIn(limits?.minChunkSize ?: (1L shl 20), limits?.maxChunkSize ?: (95L shl 20))
    }

    /** Upload [item] to completion. Returns the path it got in Loom. */
    suspend fun run(start: Item, progress: AtomicLong): String {
        // The file's own decision, else the batch's policy; anything but
        // Replace means "keep both" (the server adds a number to the name).
        val conflict = when {
            start.conflict == "replace" -> "replace"
            start.conflict != null -> "keep_both"
            start.policy == OnConflict.Replace -> "replace"
            else -> "keep_both"
        }
        var item = start
        var sessionId = item.sessionId
        var restarts = 0
        while (true) {
            if (c.stop.stopped) throw Stopped()
            // The file must still be the one that was queued; if it changed,
            // the new version is uploaded from the start.
            val now = withContext(Dispatchers.IO) { c.files.stat(item.localPath) }
            if (now.size != item.size || now.mtimeMs != item.mtimeMs) {
                sessionId?.let { runCatching { c.api.deleteSession(it) } }
                sessionId = null
                c.store.setSession(item.id, null)
                c.store.setSource(item.id, now.size, now.mtimeMs)
                item = item.copy(size = now.size, mtimeMs = now.mtimeMs)
                progress.set(0)
                continue
            }
            val size = item.size
            val session = if (sessionId != null) {
                try {
                    c.api.getSession(sessionId)
                } catch (e: LoomException.SessionGone) {
                    sessionId = null
                    c.store.setSession(item.id, null)
                    continue
                }
            } else {
                val s = c.api.createSession(item.remoteDir, item.remotePath, size, item.mtimeMs, item.clientRef, chunkSizeFor(size))
                c.store.setSession(item.id, s.id)
                sessionId = s.id
                s
            }
            session.result?.let { return it.path }
            progress.set(session.received)
            // How far past the first missing chunk the server accepts chunks.
            val firstMissing = session.missing.firstOrNull() ?: 0
            val window = session.windowEnd?.let { (it - firstMissing).coerceAtLeast(1) } ?: 4

            try {
                sendMissing(item, session.id, size, session.chunkSize, session.missing, window, progress)
            } catch (e: LoomException.SessionGone) {
                if (++restarts > 3) throw LoomException.Transient("The server keeps losing this upload")
                sessionId = null
                c.store.setSession(item.id, null)
                continue
            } catch (e: LoomException.SourceChanged) {
                continue // caught by the check above
            }

            try {
                val done = c.api.complete(session.id, conflict) ?: continue // something got lost; ask again
                return done.path
            } catch (e: LoomException.SessionGone) {
                // The answer to an earlier "complete" may have been lost and
                // the session cleaned up since: check the file is there.
                findUploaded(item, size)?.let { return it }
                sessionId = null
                c.store.setSession(item.id, null)
            }
        }
    }

    /** Is a file of this size at the destination already? */
    private suspend fun findUploaded(item: Item, size: Long): String? {
        val full = joinRemote(item.remoteDir, item.remotePath)
        val parent = full.substringBeforeLast('/', "")
        return try {
            c.api.list(parent).children.firstOrNull { it.relativePath == full && it.size == size }?.relativePath
        } catch (e: LoomException.Permanent) {
            null
        }
    }

    private class Sent(val index: Long, val outcome: ChunkOutcome?, val error: Throwable?, val sent: Long)

    /** Send the missing chunks, several at a time, staying inside the server's write window. */
    private suspend fun sendMissing(item: Item, session: String, size: Long, chunkSize: Long, missing: List<Long>, windowChunks: Long, progress: AtomicLong) = coroutineScope {
        val totalChunks = if (size == 0L) 0 else (size + chunkSize - 1) / chunkSize
        val todo = ArrayDeque(missing)
        val missingSet = missing.toHashSet()
        val done = java.util.TreeSet((0 until totalChunks).filter { it !in missingSet })
        val inFlight = mutableListOf<Deferred<Sent>>()
        var corruptTries = 0
        // Chunks beyond this wait (the server refuses far-ahead ones on drives without sparse files).
        fun windowLimit(): Long {
            var first = 0L
            while (done.contains(first)) first++
            return first + windowChunks
        }
        try {
            while (true) {
                while (inFlight.size < parallelChunks.coerceAtLeast(1) && !c.stop.stopped) {
                    val limit = windowLimit()
                    val pos = todo.indexOfFirst { it <= limit }
                    if (pos < 0) break
                    val index = todo.removeAt(pos)
                    val offset = index * chunkSize
                    val len = minOf(chunkSize, size - offset).toInt()
                    val data = ByteArray(len)
                    withContext(Dispatchers.IO) { c.files.read(item.localPath, offset, data, len) }
                    val sha = sha256Hex(data)
                    inFlight += async(Dispatchers.IO) { sendChunk(item.batchId, session, index, data, sha, progress) }
                }
                if (inFlight.isEmpty()) {
                    if (c.stop.stopped) throw Stopped()
                    if (todo.isEmpty()) return@coroutineScope
                    delay(200) // everything left is beyond the window: shouldn't happen, but don't spin
                    continue
                }
                select<Unit> { inFlight.forEach { d -> d.onAwait { } } }
                val ready = inFlight.filter { it.isCompleted }
                inFlight.removeAll(ready)
                val finished = ready.map { it.await() }
                for (f in finished) {
                    if (f.outcome == ChunkOutcome.Stored) {
                        done.add(f.index)
                        continue
                    }
                    // Not stored: take back the bytes counted for it.
                    progress.addAndGet(-f.sent)
                    when {
                        f.error != null -> throw f.error
                        f.outcome == ChunkOutcome.Corrupt -> {
                            if (++corruptTries > 8) throw LoomException.Transient("Chunks keep arriving damaged")
                            todo.addFirst(f.index)
                        }
                        else -> {
                            todo.addFirst(f.index)
                            delay(700)
                        }
                    }
                }
            }
        } finally {
            inFlight.forEach { it.cancel() }
        }
    }

    private suspend fun sendChunk(batch: BatchId, session: String, index: Long, data: ByteArray, sha: String, progress: AtomicLong): Sent {
        val sent = AtomicLong()
        val body = object : RequestBody() {
            override fun contentType() = OCTETS
            override fun contentLength() = data.size.toLong()
            override fun writeTo(sink: BufferedSink) {
                // OkHttp may write the body again on a retry: count from zero each time.
                progress.addAndGet(-sent.getAndSet(0))
                var o = 0
                while (o < data.size) {
                    if (c.stop.stopped) throw java.io.IOException("stopped")
                    val n = minOf(64 * 1024, data.size - o)
                    c.limiter.take(n)
                    sink.write(data, o, n)
                    c.meter.moved(batch, n.toLong())
                    progress.addAndGet(n.toLong())
                    sent.addAndGet(n.toLong())
                    o += n
                }
            }
        }
        return try {
            Sent(index, c.api.putChunk(session, index, sha) { body }, null, sent.get())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            Sent(index, null, if (c.stop.stopped) Stopped() else e.asLoom(), sent.get())
        }
    }
}

/*
 * Downloading one file, resumable: bytes collect in a part file and continue
 * from its size (HTTP Range + If-Range, so a file that changed in Loom starts
 * over). When complete it's put in place, never over an existing file.
 */
internal class Downloader(private val c: Ctx) {
    suspend fun run(item: Item, progress: AtomicLong): String {
        val part = c.files.partFile(item.localPath)
        part.parentFile?.mkdirs()
        if (item.kind == "zip") return zip(item, part, progress)
        var etag = item.etag
        while (true) {
            var offset = if (part.exists()) part.length() else 0L
            if (offset > 0 && etag == null) offset = 0 // can't tell if it's the same file: start over
            progress.set(offset)
            val res = c.api.download(item.remotePath, offset, etag)
            res.use {
                if (res.code == 416) {
                    // Already have everything (or the file shrank).
                    if (offset == item.size) return finish(item, part)
                    part.delete()
                    etag = null
                    return@use
                }
                val newEtag = res.header("ETag")
                val append = res.code == 206 && offset > 0
                if (!append) progress.set(0) // a full answer: the file changed in Loom, or this is the start
                if (newEtag != etag) {
                    etag = newEtag
                    c.store.setEtag(item.id, etag)
                }
                copyBody(res.body!!.byteStream(), part, append, item.batchId, progress)
                if (part.length() < item.size) throw LoomException.Transient("The download was cut short")
                return finish(item, part)
            }
        }
    }

    private suspend fun zip(item: Item, part: File, progress: AtomicLong): String {
        // A ZIP is made on the fly: it can't resume, so each try starts over.
        val paths = json.parseToJsonElement(item.remotePath).let { el -> (el as kotlinx.serialization.json.JsonArray).mapNotNull { it.str() } }
        progress.set(0)
        c.api.downloadZip(paths).use { res ->
            copyBody(res.body!!.byteStream(), part, false, item.batchId, progress)
        }
        c.store.setSize(item.id, part.length())
        return finish(item, part)
    }

    private suspend fun copyBody(input: java.io.InputStream, part: File, append: Boolean, batch: BatchId, progress: AtomicLong) = withContext(Dispatchers.IO) {
        FileOutputStream(part, append).use { out ->
            val buf = ByteArray(64 * 1024)
            var sinceSync = 0L
            try {
                while (true) {
                    coroutineContext.ensureActive()
                    if (c.stop.stopped) {
                        out.flush()
                        throw Stopped()
                    }
                    val n = input.read(buf)
                    if (n < 0) break
                    c.limiter.take(n)
                    out.write(buf, 0, n)
                    c.meter.moved(batch, n.toLong())
                    progress.addAndGet(n.toLong())
                    sinceSync += n
                    if (sinceSync > 8L shl 20) {
                        out.flush()
                        sinceSync = 0
                    }
                }
            } catch (e: java.io.IOException) {
                throw e.asLoom()
            }
            out.flush()
            out.fd.sync()
        }
    }

    private fun finish(item: Item, part: File): String = c.files.place(part, item.localPath, item.mtimeMs)
}

fun joinRemote(a: String, b: String) = when {
    a.isEmpty() -> b
    b.isEmpty() -> a
    else -> "$a/$b"
}
