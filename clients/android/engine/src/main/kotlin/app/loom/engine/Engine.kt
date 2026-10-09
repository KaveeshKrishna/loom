package app.loom.engine

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/*
 * The transfer manager behind the Loom app, a port of the Windows app's
 * engine (clients/desktop/engine):
 *
 * - Every upload and download is a row in a SQLite queue (Store), so nothing
 *   is lost when the app closes, Android stops it or the phone restarts.
 * - Uploads use Loom's numbered-chunk protocol: several files at once,
 *   several chunks per file, each checked with SHA-256; resuming asks the
 *   server what it's missing. Downloads resume with HTTP ranges.
 * - Network trouble never fails a transfer: it waits and retries, forever,
 *   with backoff. Only real problems (file deleted, no permission) do.
 * - On the home network, transfers go straight to the server's LAN address
 *   over HTTPS with the certificate it handed out (Api).
 */

class Engine private constructor(
    private val store: Store,
    server: ServerConfig,
    settings: Settings,
    userAgent: String,
    private val files: LocalFiles,
    /** True while the phone is on a metered network (mobile data). */
    private val metered: () -> Boolean,
) {
    companion object {
        /** Open the queue at [db] and start working. */
        fun start(db: File, server: ServerConfig, settings: Settings, userAgent: String, files: LocalFiles = JvmFiles(), metered: () -> Boolean = { false }) =
            Engine(Store.open(db), server, settings, userAgent, files, metered).also { it.launch() }

        private fun backoffMs(attempts: Long): Long {
            // 1 s, 2 s, 4 s … up to a minute, with jitter so retries don't line up.
            val base = minOf(1000L shl attempts.coerceIn(0, 6).toInt(), 60_000L)
            return base + Random.nextLong(750)
        }
    }

    val api = Api(server, userAgent)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val meter = Meter()
    @Volatile var settings: Settings = settings
        private set
    private val limiter = Limiter(settings.speedLimit)
    @Volatile private var limits: UploadLimits? = null

    private class Running(val stop: StopFlag, val batch: BatchId, val job: Job)

    private val running = ConcurrentHashMap<ItemId, Running>()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val _events = MutableSharedFlow<EngineEvent>(extraBufferCapacity = 256)
    val events: SharedFlow<EngineEvent> = _events
    private val _snapshot = MutableStateFlow(Snapshot())
    val snapshot: StateFlow<Snapshot> = _snapshot

    private val offline = AtomicBoolean(false)
    private val signedOut = AtomicBoolean(false)
    private val diskFull = AtomicBoolean(false)
    private val allPaused = AtomicBoolean(store.getMeta("all_paused") == "1")

    /** Batches being scanned (stop flag), and whose name check is running. */
    private val scans = ConcurrentHashMap<BatchId, StopFlag>()
    private val checking = ConcurrentHashMap.newKeySet<BatchId>()
    private val shutdown = AtomicBoolean(false)

    private fun poke() {
        wake.trySend(Unit)
    }

    private fun emit(e: EngineEvent) {
        _events.tryEmit(e)
    }

    private fun launch() {
        // Folders whose scan was interrupted continue where they were.
        for (id in store.batchesToScan()) scope.launch { rescan(id) }
        // The scheduler: starts work whenever something changes, and every second.
        scope.launch {
            while (!shutdown.get()) {
                withTimeoutOrNull(1000) { wake.receive() }
                if (shutdown.get()) break
                runCatching { schedule() }
            }
        }
        // Snapshots for the UI, a few times a second.
        scope.launch {
            while (!shutdown.get()) {
                runCatching { publish() }
                delay(400)
            }
        }
        // Server limits, the LAN probe, and "are we back online?".
        scope.launch {
            refreshServer()
            while (!shutdown.get()) {
                delay(20_000)
                if (offline.get() || limits == null) refreshServer() else api.probeLan(false)
            }
        }
    }

    /**
     * Ask the server for its limits and LAN details (this also tells us
     * whether it's reachable at all).
     */
    suspend fun refreshServer() {
        try {
            val info = api.clientInfo()
            offline.set(false)
            limits = info.upload
            if (api.config.instanceId != info.instanceId) api.setInstanceId(info.instanceId)
            val lan = info.lan?.takeIf { settings.useLan }?.let { LanConfig(it.url, it.caPem) }
            if (api.config.lan != lan) runCatching { api.setLan(lan) }
            api.probeLan(true)
            poke()
        } catch (e: LoomException.SignedOut) {
            markSignedOut()
        } catch (e: Exception) {
            offline.set(true)
        }
    }

    /** The network changed (Wi-Fi ↔ mobile data): check where Loom is now, and go. */
    fun networkChanged() {
        api.lanDown()
        scope.launch { refreshServer() }
        poke()
    }

    fun updateSettings(s: Settings) {
        limiter.rate = s.speedLimit
        val lanChanged = settings.useLan != s.useLan
        settings = s
        if (lanChanged) scope.launch { refreshServer() }
        poke()
    }

    /** A new token (after pairing again): transfers continue. */
    fun setToken(token: String) {
        api.setToken(token)
        signedOut.set(false)
        scope.launch { refreshServer() }
    }

    // ── queueing ─────────────────────────────────────────────────────────────

    /**
     * Queue files and folders for upload. Folders are scanned in the
     * background; files start as soon as their name is checked (or right
     * away with Keep both / Replace).
     */
    fun upload(req: UploadRequest): BatchId {
        val title = req.title ?: req.sources.singleOrNull()?.let { it.relativePath ?: files.name(it.path) } ?: "${req.sources.size} items"
        val id = store.createBatch(Direction.Upload, title, req.destDir, null, req.onConflict)
        val sources = buildJsonArray {
            for (s in req.sources) add(buildJsonObject {
                put("path", s.path)
                s.conflict?.let { put("conflict", it.wire) }
                s.relativePath?.let { put("relativePath", it) }
            })
        }
        store.setMeta("sources:$id", sources.toString())
        scope.launch { scanUpload(id) }
        return id
    }

    /** Queue files and folders from Loom for download into [DownloadRequest.localDir]. */
    fun download(req: DownloadRequest): BatchId {
        val title = req.title ?: req.entries.singleOrNull()?.name ?: "${req.entries.size} items"
        val remoteDir = req.entries.firstOrNull()?.path?.substringBeforeLast('/', "") ?: ""
        val id = store.createBatch(Direction.Download, title, remoteDir, req.localDir, OnConflict.KeepBoth)
        if (req.zip) {
            // One file, made by the server.
            val name = if (req.entries.size == 1) "${req.entries[0].name}.zip" else "Loom ${java.time.LocalDate.now()}.zip"
            val paths = buildJsonArray { req.entries.forEach { add(JsonPrimitive(it.path)) } }
            store.insertItems(id, OnConflict.KeepBoth, listOf(NewItem("zip", files.join(req.localDir, name), paths.toString(), 0, 0, OnConflict.KeepBoth)))
            store.setBatchState(id, "active")
            poke()
            return id
        }
        val entries = buildJsonArray {
            for (e in req.entries) add(buildJsonObject { put("path", e.path); put("name", e.name); put("isDir", e.isDir) })
        }
        store.setMeta("entries:$id", entries.toString())
        scope.launch { scanDownload(id) }
        return id
    }

    private suspend fun rescan(id: BatchId) {
        when (store.batchInfo(id)?.direction) {
            Direction.Upload -> scanUpload(id)
            Direction.Download -> scanDownload(id)
            null -> {}
        }
    }

    private fun sourcesOf(id: BatchId): List<UploadSource> = runCatching {
        json.parseToJsonElement(store.getMeta("sources:$id") ?: "[]").jsonArray.mapNotNull { e ->
            val o = e.obj() ?: return@mapNotNull null
            UploadSource(o["path"].str() ?: return@mapNotNull null, OnConflict.parse(o["conflict"].str()), o["relativePath"].str())
        }
    }.getOrDefault(emptyList())

    private suspend fun scanUpload(id: BatchId) {
        val info = store.batchInfo(id) ?: return
        val sources = sourcesOf(id)
        val flag = StopFlag()
        scans[id] = flag
        store.setBatchState(id, "scanning")
        // A resumed scan skips what an earlier, interrupted one already queued.
        val known = store.batchPaths(id)
        startChecking(id, info.remoteDir, info.policy)
        var count = 0L
        val error = withContext(Dispatchers.IO) {
            try {
                val buf = ArrayList<NewItem>()
                fun flush() {
                    store.insertItems(id, info.policy, buf.filter { it.remotePath !in known })
                    buf.clear()
                    poke()
                }
                for (s in sources) {
                    if (flag.stopped) break
                    val root = s.relativePath ?: files.name(s.path)
                    files.walk(s, root) { item ->
                        if (flag.stopped) throw Stopped()
                        if (item.kind == "file") count++
                        buf += item
                        if (buf.size >= 1000) flush()
                    }
                }
                flush()
                null
            } catch (e: Stopped) {
                null
            } catch (e: Exception) {
                e.message ?: e.javaClass.simpleName
            }
        }
        scans.remove(id)
        if (flag.stopped) return
        error?.let { store.setBatchError(id, it) }
        store.setBatchState(id, "active")
        emit(EngineEvent.ScanFinished(id, count))
        poke()
    }

    /**
     * Check names against Loom while the scan runs: files whose name is free
     * go ahead; taken ones wait for the user (Ask) or are skipped (Skip).
     */
    private fun startChecking(id: BatchId, dest: String, policy: OnConflict) {
        if ((policy != OnConflict.Ask && policy != OnConflict.Skip) || !checking.add(id)) return
        scope.launch {
            var asked = 0L
            while (true) {
                val scanning = scans.containsKey(id)
                val todo = store.checking(id, 2000)
                if (todo.isEmpty()) {
                    if (!scanning) break
                    delay(300)
                    continue
                }
                val conflicts = try {
                    api.conflicts(dest, todo.map { Triple(it.remotePath, it.size, it.mtimeMs) })
                } catch (e: LoomException.SignedOut) {
                    markSignedOut()
                    break
                } catch (e: LoomException.Transient) {
                    delay(5000)
                    continue
                } catch (e: Exception) {
                    // Can't check: upload anyway, the server never overwrites (numbered names).
                    emptyList()
                }
                val byPath = todo.associate { it.remotePath to it.id }
                val taken = HashSet<ItemId>()
                for (c in conflicts) {
                    val item = byPath[c.key] ?: continue
                    taken += item
                    if (policy == OnConflict.Skip) {
                        store.skipItem(item)
                    } else {
                        val existing = buildJsonObject {
                            put("type", c.existing.kind)
                            c.existing.size?.let { put("size", it) }
                            c.existing.modifiedAt?.let { put("modifiedAt", it) }
                            put("same", c.same)
                        }
                        store.askConflict(item, existing.toString())
                        asked++
                    }
                }
                store.checked(todo.map { it.id }.filter { it !in taken })
                poke()
            }
            checking.remove(id)
            if (asked > 0) emit(EngineEvent.ConflictsFound(id, asked))
            poke()
        }
    }

    private suspend fun scanDownload(id: BatchId) {
        val info = store.batchInfo(id) ?: return
        val localDir = info.localDir ?: return
        val entries = runCatching {
            json.parseToJsonElement(store.getMeta("entries:$id") ?: "[]").jsonArray.mapNotNull { e ->
                val o = e.obj() ?: return@mapNotNull null
                RemoteEntry(o["path"].str() ?: return@mapNotNull null, o["name"].str() ?: "", o["isDir"].bool() ?: false)
            }
        }.getOrDefault(emptyList())
        store.setBatchState(id, "scanning")
        while (true) {
            val known = store.batchPaths(id)
            try {
                val n = walkRemote(entries, localDir) { items -> store.insertItems(id, OnConflict.KeepBoth, items.filter { it.remotePath !in known }) }
                emit(EngineEvent.ScanFinished(id, n))
                break
            } catch (e: LoomException.SignedOut) {
                markSignedOut()
                return
            } catch (e: LoomException.Transient) {
                delay(5000)
            } catch (e: Exception) {
                store.setBatchError(id, e.message)
                break
            }
        }
        store.setBatchState(id, "active")
        poke()
    }

    /** List Loom folders recursively for a download. */
    private suspend fun walkRemote(entries: List<RemoteEntry>, localDir: String, emit: (List<NewItem>) -> Unit): Long {
        var count = 0L
        val buf = ArrayList<NewItem>()
        val stack = ArrayDeque<Pair<String, String>>()
        for (e in entries) {
            val local = files.join(localDir, e.name)
            if (e.isDir) {
                stack.addLast(e.path to local)
            } else {
                // A single file: size and date come from its folder listing.
                val n = api.list(e.path.substringBeforeLast('/', "")).children.firstOrNull { it.relativePath == e.path } ?: continue
                count++
                buf += NewItem("file", local, n.relativePath, n.size, parseIsoMs(n.modifiedAt), OnConflict.KeepBoth)
            }
        }
        while (stack.isNotEmpty()) {
            val (remote, local) = stack.removeLast()
            for (n in api.list(remote).children) {
                val childLocal = files.join(local, n.name)
                if (n.isDir) {
                    stack.addLast(n.relativePath to childLocal)
                } else {
                    count++
                    buf += NewItem("file", childLocal, n.relativePath, n.size, parseIsoMs(n.modifiedAt), OnConflict.KeepBoth)
                    if (buf.size >= 1000) {
                        emit(buf.toList())
                        buf.clear()
                    }
                }
            }
        }
        if (buf.isNotEmpty()) emit(buf)
        return count
    }

    // ── controls ─────────────────────────────────────────────────────────────

    /**
     * Pause one batch, or everything (null). Running transfers stop at the
     * next chunk and continue from there on resume.
     */
    fun pause(batch: BatchId?) {
        store.setPaused(batch, true)
        if (batch == null) {
            allPaused.set(true)
            store.setMeta("all_paused", "1")
        }
        for (r in running.values) if (batch == null || batch == r.batch) r.stop.stop()
        publish()
    }

    fun resume(batch: BatchId?) {
        store.setPaused(batch, false)
        if (batch == null) {
            allPaused.set(false)
            store.setMeta("all_paused", "0")
            diskFull.set(false)
        }
        poke()
        publish()
    }

    /** Cancel a batch (or one of its files). Unfinished uploads are discarded on the server, partial downloads on disk. */
    suspend fun cancel(batch: BatchId, item: ItemId? = null) {
        if (item == null) scans[batch]?.stop()
        for ((id, r) in running) if (r.batch == batch && (item == null || item == id)) r.stop.stop()
        val sessions = store.cancel(batch, item)
        for (s in sessions) runCatching { api.deleteSession(s) }
        if (store.batchInfo(batch)?.direction == Direction.Download) {
            for (it in store.items(batch, 0, Long.MAX_VALUE)) if (it.state == ItemState.Cancelled) files.partFile(it.localPath).delete()
        }
        publish()
    }

    /** Try failed (and waiting) transfers again now. */
    fun retry(batch: BatchId? = null, item: ItemId? = null): Int = store.retry(batch, item).also { poke() }

    /** Answer a name conflict (null item = all remaining in the batch). */
    fun decide(batch: BatchId, item: ItemId?, decision: OnConflict): Int = store.decide(batch, item, decision).also { poke() }

    fun conflicts(batch: BatchId) = store.conflicts(batch)

    fun removeBatch(batch: BatchId) = store.removeBatch(batch)

    fun clearFinished() = store.clearFinished()

    /** Local paths still needed by unfinished uploads. */
    fun openLocalPaths() = store.openLocalPaths()

    /** Bytes moved since each running item's progress was last saved, per batch. */
    private fun liveDeltas(): Map<BatchId, Long> {
        val live = meter.live()
        val saved = store.savedBytes(live.keys)
        val out = HashMap<BatchId, Long>()
        for ((id, v) in live) out[v.first] = (out[v.first] ?: 0) + v.second - (saved[id] ?: v.second)
        return out
    }

    /** The Transfers list, with live progress and speeds. */
    fun batches(includeFinished: Boolean): List<BatchView> {
        val deltas = liveDeltas()
        val speeds = meter.batchBps
        return store.batches(includeFinished).map { b ->
            b.copy(bytesDone = (b.bytesDone + (deltas[b.id] ?: 0)).coerceIn(0, maxOf(b.bytesTotal, 0)), bytesPerSecond = speeds[b.id] ?: 0.0)
        }
    }

    fun items(batch: BatchId, offset: Long = 0, limit: Long = 200): List<ItemView> {
        val live = meter.live()
        return store.items(batch, offset, limit).map { live[it.id]?.let { l -> it.copy(bytesDone = l.second) } ?: it }
    }

    /** Stop everything, saving progress (transfers continue on the next start). */
    suspend fun shutdown() {
        shutdown.set(true)
        for (r in running.values) r.stop.stop()
        for ((id, v) in meter.live()) store.setProgress(id, v.second)
        repeat(50) {
            if (running.isEmpty()) return@repeat
            delay(100)
        }
        scope.cancel()
        store.close()
    }

    private fun markSignedOut() {
        if (!signedOut.getAndSet(true)) emit(EngineEvent.SignedOut)
        for (r in running.values) r.stop.stop()
    }

    // ── the scheduler ────────────────────────────────────────────────────────

    private fun waitingForWifi() = settings.wifiOnly && metered()

    private fun schedule() {
        // Batches with nothing left: tell the app.
        for (b in store.finishBatches()) emit(EngineEvent.BatchFinished(b.id, b.title, b.direction, b.done, b.failed, b.skipped))
        if (signedOut.get() || allPaused.get() || offline.get() || waitingForWifi()) {
            // Mobile data with "Wi-Fi only": what's running stops at the next chunk.
            if (waitingForWifi()) for (r in running.values) r.stop.stop()
            return
        }
        val free = settings.parallelFiles.coerceAtLeast(1) - running.size
        if (free <= 0) return
        for (item in store.pick(free, running.keys, uploadsAllowed = !diskFull.get())) {
            val stop = StopFlag()
            store.setState(item.id, ItemState.Running)
            val job = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) { work(item, stop) }
            running[item.id] = Running(stop, item.batchId, job)
            job.start()
        }
    }

    private suspend fun work(item: Item, stop: StopFlag) {
        val progress = meter.track(item.id, item.batchId, item.bytesDone)
        // Save progress every few seconds, so the list shows it after a restart.
        val saver = scope.launch {
            while (true) {
                delay(3000)
                store.setProgress(item.id, progress.get())
            }
        }
        val result = runCatching { transfer(item, stop, progress) }
        saver.cancel()
        store.setProgress(item.id, progress.get())
        meter.untrack(item.id)
        running.remove(item.id)
        val e = result.exceptionOrNull()?.let { if (it is Stopped || stop.stopped) Stopped() else it.asLoom() }
        when {
            e == null -> store.finish(item.id, result.getOrNull())
            // Paused (back to the queue) or cancelled (cancel() set that already).
            e is Stopped -> if (store.getItem(item.id)?.state == ItemState.Running) store.setState(item.id, ItemState.Queued)
            e is LoomException.SignedOut -> {
                store.setState(item.id, ItemState.Queued)
                markSignedOut()
            }
            e is LoomException.DiskFull -> {
                store.setWaiting(item.id, "Loom's drive is full", nowMs() + 60_000)
                if (!diskFull.getAndSet(true)) emit(EngineEvent.DiskFull)
            }
            e is LoomException.Transient || e is LoomException.SessionGone || e is LoomException.SourceChanged -> {
                store.setWaiting(item.id, e.message ?: "Network error", nowMs() + backoffMs(item.attempts))
                if (e is LoomException.Transient) {
                    // Is the server reachable at all? Stops hammering it while it isn't.
                    api.lanDown()
                    scope.launch { refreshServer() }
                }
            }
            else -> store.setState(item.id, ItemState.Failed, e.message)
        }
        poke()
    }

    private suspend fun transfer(item: Item, stop: StopFlag, progress: AtomicLong): String {
        if (item.kind == "dir") {
            // An empty folder: create each level (existing ones are fine).
            val full = joinRemote(item.remoteDir, item.remotePath)
            var parent = ""
            for (part in full.split('/')) {
                api.mkdir(parent, part)
                parent = joinRemote(parent, part)
            }
            return full
        }
        val ctx = Ctx(api, store, files, meter, limiter, stop)
        return when (item.direction) {
            Direction.Upload -> {
                val s = settings
                val l = limits
                Uploader(ctx, s.parallelChunks.coerceIn(1, (l?.parallelChunksPerUpload ?: 4).coerceAtLeast(1)), s.chunkLan, s.chunkInternet, l).run(item, progress)
            }
            Direction.Download -> Downloader(ctx).run(item, progress)
        }
    }

    private fun publish() {
        val t = store.totals()
        meter.tick()
        val deltas = liveDeltas().values.sum()
        _snapshot.value = Snapshot(
            active = running.size.toLong(),
            queued = t.queued,
            paused = t.paused,
            waiting = t.waiting,
            failed = t.failed,
            conflicts = t.conflicts,
            bytesDone = (t.bytesDone + deltas).coerceIn(0, maxOf(t.bytesTotal, 0)),
            bytesTotal = t.bytesTotal,
            bytesPerSecond = meter.totalBps,
            via = if (api.via == Via.Lan) "lan" else "internet",
            offline = offline.get(),
            signedOut = signedOut.get(),
            diskFull = diskFull.get(),
            allPaused = allPaused.get(),
            waitingForWifi = waitingForWifi() && (t.queued > 0 || t.waiting > 0),
        )
    }
}

/** Parse the ISO dates Loom sends (`2026-10-09T05:07:00.000Z`) to milliseconds; 0 when there's none. */
fun parseIsoMs(s: String?): Long = s?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L
