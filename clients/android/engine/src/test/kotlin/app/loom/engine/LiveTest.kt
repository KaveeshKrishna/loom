package app.loom.engine

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.random.Random

/*
 * The engine against a real Loom (tests/stack/stack.sh up), the same
 * scenarios as the Windows engine's tests (clients/desktop/engine/tests/live.rs).
 * Skipped when LOOM_TEST_URL isn't set.
 */

private const val MIB = 1 shl 20
private const val OWNER_EMAIL = "owner@loom.test"
private const val OWNER_PASSWORD = "owner-password-123"
private val JSON = "application/json".toMediaType()

class LiveTest {
    @get:Rule val tmp = TemporaryFolder()

    private val base = System.getenv("LOOM_TEST_URL").orEmpty()
    private val http = OkHttpClient()

    @Before
    fun needServer() = assumeTrue("LOOM_TEST_URL not set: skipping", base.isNotEmpty())

    private fun media(): File {
        val dir = System.getenv("LOOM_TEST_DIR")?.takeIf { it.isNotEmpty() } ?: "${System.getProperty("user.home")}/.cache/loomtest"
        return File(dir, "media")
    }

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private fun random(n: Int) = Random.nextBytes(n)
    private fun uniq(p: String) = "$p-%08x".format(Random.nextInt())

    // ─── accounts ────────────────────────────────────────────────────────────

    private fun post(path: String, body: String, headers: Map<String, String> = emptyMap()) =
        http.newCall(Request.Builder().url("$base$path").post(body.toRequestBody(JSON)).apply { headers.forEach { (k, v) -> header(k, v) } }.build()).execute()

    private fun ownerCookie(): String {
        val setup = http.newCall(Request.Builder().url("$base/api/setup").build()).execute().use { json.parseToJsonElement(it.body!!.string()).jsonObject }
        if (setup["needsSetup"].bool() == true) {
            post("/api/setup", """{"name":"Test Owner","email":"$OWNER_EMAIL","password":"$OWNER_PASSWORD"}""").close()
        }
        post(
            "/api/auth/sign-in/email",
            """{"email":"$OWNER_EMAIL","password":"$OWNER_PASSWORD"}""",
            mapOf("origin" to base, "x-forwarded-for" to "10.79.${Random.nextInt(256)}.${Random.nextInt(255) or 1}"),
        ).use { res ->
            assertTrue("sign-in: ${res.code}", res.isSuccessful)
            return res.headers("set-cookie").joinToString("; ") { it.substringBefore(';') }
        }
    }

    /** Pair a device the way the apps do (token made here, only its hash sent). */
    private fun pair(): Pair<String, String> {
        shared?.let { return it }
        val cookie = ownerCookie()
        val code = post("/api/devices/codes", "{}", mapOf("cookie" to cookie)).use { json.parseToJsonElement(it.body!!.string()).jsonObject["code"].str()!! }
        val token = "loomd_" + sha(random(32))
        val body = buildJsonObject {
            put("code", code)
            put("name", uniq("Android engine test"))
            put("platform", "android")
            put("tokenHash", sha(token.toByteArray()))
        }
        post("/api/devices/pair/redeem", body.toString(), mapOf("x-forwarded-for" to "10.80.${Random.nextInt(256)}.${Random.nextInt(255) or 1}")).use {
            assertTrue("redeem: ${it.code}", it.isSuccessful)
        }
        return (token to cookie).also { shared = it }
    }

    private fun mkdir(cookie: String, name: String) = post("/api/fs/mkdir", """{"parentPath":"","name":"$name"}""", mapOf("cookie" to cookie)).close()

    private fun settings() = Settings(parallelFiles = 3, parallelChunks = 3, chunkInternet = MIB.toLong(), chunkLan = MIB.toLong())

    private fun engine(token: String, db: File, s: Settings = settings(), url: String = base) =
        Engine.start(db, ServerConfig(url, token), s, "loom-android-engine-tests")

    private fun waitBatch(e: Engine, id: BatchId, secs: Int): BatchView {
        val until = System.currentTimeMillis() + secs * 1000L
        while (true) {
            val b = b(e, id)
            if (b.finished) return b
            if (System.currentTimeMillis() > until) throw AssertionError("batch $id not done in ${secs}s: $b\n${e.items(id)}")
            Thread.sleep(200)
        }
    }

    private fun b(e: Engine, id: BatchId) = e.batches(true).first { it.id == id }

    private fun waitFor(what: String, secs: Int, f: () -> Boolean) {
        val until = System.currentTimeMillis() + secs * 1000L
        while (!f()) {
            if (System.currentTimeMillis() > until) throw AssertionError("timed out waiting for $what")
            Thread.sleep(100)
        }
    }

    private fun src(f: File) = UploadSource(f.path)

    // ─── a TCP proxy that can drop the network ───────────────────────────────

    private class Proxy(target: String) {
        private val server = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        private val up = AtomicBoolean(true)
        private val open = CopyOnWriteArrayList<Socket>()
        val url = "http://127.0.0.1:${server.localPort}"

        init {
            val (host, port) = target.substringBefore('/').split(':').let { it[0] to it[1].toInt() }
            thread(isDaemon = true) {
                while (true) {
                    val inbound = runCatching { server.accept() }.getOrNull() ?: break
                    if (!up.get()) {
                        inbound.close()
                        continue
                    }
                    thread(isDaemon = true) {
                        val outbound = runCatching { Socket().apply { connect(InetSocketAddress(host, port), 3000) } }.getOrNull() ?: return@thread inbound.close()
                        open += inbound
                        open += outbound
                        thread(isDaemon = true) { runCatching { inbound.getInputStream().copyTo(outbound.getOutputStream()) }; runCatching { outbound.close() } }
                        runCatching { outbound.getInputStream().copyTo(inbound.getOutputStream()) }
                        runCatching { inbound.close() }
                    }
                }
            }
        }

        fun down() {
            up.set(false)
            open.forEach { runCatching { it.close() } }
            open.clear()
        }

        fun restore() = up.set(true)
    }

    private fun hostPort(url: String) = url.removePrefix("http://").removePrefix("https://").trimEnd('/')

    // ─── tests ───────────────────────────────────────────────────────────────

    @Test
    fun uploadsAFolderWithItsStructureAndDates() {
        val (token, cookie) = pair()
        val dest = uniq("and-folder")
        mkdir(cookie, dest)
        val root = File(tmp.root, "Trip")
        File(root, "day 1/raw").mkdirs()
        File(root, "empty").mkdirs()
        val files = listOf("day 1/a.jpg" to random(2 * MIB + 333), "day 1/raw/b.dng" to random(5 * MIB), "notes.txt" to "hello".toByteArray(), "zero.bin" to ByteArray(0))
        for ((p, data) in files) {
            File(root, p).writeBytes(data)
            File(root, p).setLastModified(1_600_000_000_000)
        }
        val e = engine(token, File(tmp.root, "q.db"))
        val id = e.upload(UploadRequest(dest, listOf(src(root)), OnConflict.Ask))
        val b = waitBatch(e, id, 120)
        assertEquals("$b", 4, b.filesDone)
        assertEquals(0, b.filesFailed)
        for ((p, data) in files) {
            val onServer = File(media(), "$dest/Trip/$p")
            assertEquals(p, sha(data), sha(onServer.readBytes()))
            assertEquals("$p keeps its date", 1_600_000_000L, onServer.lastModified() / 1000)
        }
        assertTrue("empty folders are created", File(media(), "$dest/Trip/empty").isDirectory)
        runBlocking { e.shutdown() }
    }

    @Test
    fun nameConflictsAskThenReplaceSkipOrKeepBoth() {
        val (token, cookie) = pair()
        val dest = uniq("and-conflict")
        mkdir(cookie, dest)
        val dir = File(tmp.root, "first").apply { mkdirs() }
        for (n in listOf("a.txt", "b.txt", "c.txt")) File(dir, n).writeText("old $n")
        val e = engine(token, File(tmp.root, "q.db"))
        waitBatch(e, e.upload(UploadRequest(dest, dir.listFiles()!!.map { src(it) }, OnConflict.KeepBoth)), 60)
        for (n in listOf("a.txt", "b.txt", "c.txt")) File(dir, n).writeText("new $n")
        val id = e.upload(UploadRequest(dest, dir.listFiles()!!.sortedBy { it.name }.map { src(it) }, OnConflict.Ask))
        waitFor("the conflicts", 30) { e.conflicts(id).size == 3 }
        val c = e.conflicts(id).associateBy { it.relativePath }
        assertFalse(c["a.txt"]!!.existingIsFolder)
        e.decide(id, c["a.txt"]!!.itemId, OnConflict.Replace)
        e.decide(id, c["b.txt"]!!.itemId, OnConflict.Skip)
        e.decide(id, null, OnConflict.KeepBoth)
        val b = waitBatch(e, id, 60)
        assertEquals("$b", 2, b.filesDone)
        assertEquals(1, b.filesSkipped)
        assertEquals("new a.txt", File(media(), "$dest/a.txt").readText())
        assertEquals("old b.txt", File(media(), "$dest/b.txt").readText())
        assertEquals("old c.txt", File(media(), "$dest/c.txt").readText())
        assertEquals("new c.txt", File(media(), "$dest/c (1).txt").readText())
        runBlocking { e.shutdown() }
    }

    @Test
    fun resumesAfterTheAppRestartsWithoutSendingEverythingAgain() {
        val (token, cookie) = pair()
        val dest = uniq("and-resume")
        mkdir(cookie, dest)
        val data = random(12 * MIB)
        val f = File(tmp.root, "big.bin").apply { writeBytes(data) }
        val db = File(tmp.root, "q.db")
        // Slowly (2 MiB/s), so there's something left when the app "closes".
        var e = engine(token, db, settings().copy(speedLimit = 2L * MIB))
        val id = e.upload(UploadRequest(dest, listOf(src(f)), OnConflict.KeepBoth))
        waitFor("some progress", 30) { e.batches(true)[0].bytesDone > 3L * MIB }
        runBlocking { e.shutdown() }
        // The next start continues from what the server has.
        e = engine(token, db)
        // Chunks that were still on their way when it stopped are sent again; the rest isn't.
        assertTrue("progress was kept", e.items(id)[0].bytesDone >= MIB)
        val b = waitBatch(e, id, 60)
        assertEquals(1, b.filesDone)
        assertEquals(sha(data), sha(File(media(), "$dest/big.bin").readBytes()))
        assertEquals("no duplicate", 1, File(media(), dest).list()!!.size)
        runBlocking { e.shutdown() }
    }

    @Test
    fun survivesTheNetworkGoingAway() {
        val (token, cookie) = pair()
        val dest = uniq("and-net")
        mkdir(cookie, dest)
        val proxy = Proxy(hostPort(base))
        val data = random(8 * MIB)
        val f = File(tmp.root, "v.bin").apply { writeBytes(data) }
        // Only the (cuttable) public address: no LAN shortcut around the proxy.
        val noLan = settings().copy(speedLimit = 2L * MIB, useLan = false)
        val e = engine(token, File(tmp.root, "q.db"), noLan, proxy.url)
        val id = e.upload(UploadRequest(dest, listOf(src(f)), OnConflict.KeepBoth))
        waitFor("some progress", 30) { e.batches(true)[0].bytesDone > 2L * MIB }
        assertEquals(Via.Internet, e.api.via)
        proxy.down()
        waitFor("the engine to notice", 60) { e.snapshot.value.let { it.offline || it.waiting > 0 } }
        Thread.sleep(3000)
        val mid = b(e, id)
        assertNotEquals("done", mid.state)
        assertEquals("network trouble never fails a transfer", 0, mid.filesFailed)
        proxy.restore()
        e.updateSettings(noLan.copy(speedLimit = 0))
        val done = waitBatch(e, id, 180)
        assertEquals(1, done.filesDone)
        assertEquals(sha(data), sha(File(media(), "$dest/v.bin").readBytes()))
        runBlocking { e.shutdown() }
    }

    @Test
    fun usesTheLanAddressAndFallsBackWhenItStopsAnswering() = runBlocking {
        val (token, _) = pair()
        val info = Api(ServerConfig(base, token), "t").clientInfo()
        val lan = info.lan ?: throw AssertionError("the test stack has LAN access")
        // The LAN listener, behind a proxy we can cut (same IP, so the certificate still fits).
        val lanProxy = Proxy(hostPort(lan.url))
        val api = Api(ServerConfig(base, token, info.instanceId, LanConfig(lanProxy.url.replace("http://", "https://"), lan.caPem)), "t")
        assertTrue("LAN reachable through the proxy", api.probeLan(true))
        assertEquals(Via.Lan, api.via)
        api.list("")
        lanProxy.down()
        api.list("") // the next request notices, switches, and still succeeds
        assertEquals(Via.Internet, api.via)
        assertFalse(api.probeLan(true))
        lanProxy.restore()
        assertTrue("and goes back when it answers again", api.probeLan(true))
    }

    @Test
    fun aLanWithTheWrongCertificateIsNeverUsed() = runBlocking {
        val (token, _) = pair()
        val info = Api(ServerConfig(base, token), "t").clientInfo()
        val lan = info.lan!!
        // A real, valid certificate authority, just not the server's.
        val other = okhttp3.tls.HeldCertificate.Builder().certificateAuthority(0).commonName("Some other CA").build().certificatePem()
        val api = Api(ServerConfig(base, token, info.instanceId, LanConfig(lan.url, other)), "t")
        assertFalse("the server's certificate doesn't verify against it", api.probeLan(true))
        assertEquals(Via.Internet, api.via)
        api.list("")
        Unit
    }

    @Test
    fun downloadsAFolderAndResumesAPartialFile() {
        val (token, cookie) = pair()
        val dest = uniq("and-dl")
        mkdir(cookie, dest)
        val up = File(tmp.root, "Album")
        File(up, "inner").mkdirs()
        val big = random(9 * MIB)
        File(up, "inner/big.bin").writeBytes(big)
        File(up, "small: name?.txt").writeText("tiny")
        var e = engine(token, File(tmp.root, "q.db"))
        waitBatch(e, e.upload(UploadRequest(dest, listOf(src(up)), OnConflict.KeepBoth)), 60)
        runBlocking { e.shutdown() }

        // Download it slowly, stop half way, then finish in a new engine.
        val out = File(tmp.root, "Downloads")
        val db = File(tmp.root, "dl.db")
        e = engine(token, db, settings().copy(speedLimit = 3L * MIB))
        val id = e.download(DownloadRequest(listOf(RemoteEntry("$dest/Album", "Album", true)), out.path))
        waitFor("some progress", 30) { e.batches(true).firstOrNull { it.id == id }?.let { it.bytesDone > 3L * MIB } ?: false }
        runBlocking { e.shutdown() }
        val part = File(out, "Album/inner/big.bin$PART_SUFFIX")
        assertTrue("a partial download is kept", part.exists())
        assertTrue(part.length() in 1 until big.size)

        e = engine(token, db)
        val b = waitBatch(e, id, 60)
        assertEquals("$b", 2, b.filesDone)
        assertEquals(sha(big), sha(File(out, "Album/inner/big.bin").readBytes()))
        assertFalse(part.exists())
        assertEquals("tiny", File(out, "Album/small_ name_.txt").readText())

        // And the whole folder as one ZIP.
        val zid = e.download(DownloadRequest(listOf(RemoteEntry("$dest/Album", "Album", true)), out.path, zip = true))
        assertEquals(1, waitBatch(e, zid, 60).filesDone)
        val zip = File(out, "Album.zip")
        java.util.zip.ZipFile(zip).use { z -> assertTrue(z.entries().toList().any { it.name.endsWith("big.bin") }) }
        runBlocking { e.shutdown() }
    }

    @Test
    fun aFileChangedMidUploadIsSentAgainInItsNewVersion() {
        val (token, cookie) = pair()
        val dest = uniq("and-change")
        mkdir(cookie, dest)
        val f = File(tmp.root, "doc.bin").apply { writeBytes(random(8 * MIB)) }
        val e = engine(token, File(tmp.root, "q.db"), settings().copy(speedLimit = 2L * MIB, parallelChunks = 1))
        val id = e.upload(UploadRequest(dest, listOf(src(f)), OnConflict.KeepBoth))
        waitFor("some progress", 30) { e.batches(true)[0].bytesDone > 2L * MIB }
        val newer = random(5 * MIB)
        f.writeBytes(newer)
        f.setLastModified(1_700_000_000_000)
        e.updateSettings(settings())
        assertEquals(1, waitBatch(e, id, 120).filesDone)
        assertEquals(sha(newer), sha(File(media(), "$dest/doc.bin").readBytes()))
        runBlocking { e.shutdown() }
    }

    @Test
    fun cancelDiscardsTheServerSideUpload() {
        val (token, cookie) = pair()
        val dest = uniq("and-cancel")
        mkdir(cookie, dest)
        val f = File(tmp.root, "c.bin").apply { writeBytes(random(10 * MIB)) }
        val e = engine(token, File(tmp.root, "q.db"), settings().copy(speedLimit = MIB.toLong()))
        val id = e.upload(UploadRequest(dest, listOf(src(f)), OnConflict.KeepBoth))
        waitFor("an upload session", 30) { e.batches(true)[0].bytesDone > MIB }
        runBlocking { e.cancel(id) }
        assertEquals("cancelled", waitBatch(e, id, 10).state)
        Thread.sleep(500)
        assertEquals(0, File(media(), dest).list()!!.size)
        runBlocking { e.shutdown() }
    }

    @Test
    fun pauseAllAndResume() {
        val (token, cookie) = pair()
        val dest = uniq("and-pause")
        mkdir(cookie, dest)
        val data = random(6 * MIB)
        val f = File(tmp.root, "p.bin").apply { writeBytes(data) }
        val e = engine(token, File(tmp.root, "q.db"), settings().copy(speedLimit = 2L * MIB))
        val id = e.upload(UploadRequest(dest, listOf(src(f)), OnConflict.KeepBoth))
        waitFor("some progress", 30) { e.batches(true)[0].bytesDone > MIB }
        e.pause(null)
        waitFor("everything to stop", 10) { e.snapshot.value.active == 0L }
        val before = e.batches(true)[0].bytesDone
        Thread.sleep(2000)
        val after = e.batches(true)[0].bytesDone
        assertTrue("nothing moves while paused ($before → $after)", after - before < MIB)
        assertTrue(e.snapshot.value.allPaused)
        e.resume(null)
        e.updateSettings(settings())
        waitBatch(e, id, 60)
        assertEquals(sha(data), sha(File(media(), "$dest/p.bin").readBytes()))
        runBlocking { e.shutdown() }
    }

    @Test
    fun aDeletedFileFailsClearlyAndCanBeRetried() {
        val (token, cookie) = pair()
        val dest = uniq("and-missing")
        mkdir(cookie, dest)
        val f = File(tmp.root, "gone.txt").apply { writeText("x") }
        val e = engine(token, File(tmp.root, "q.db"))
        e.pause(null)
        val id = e.upload(UploadRequest(dest, listOf(src(f)), OnConflict.KeepBoth))
        waitFor("the scan", 10) { e.items(id).size == 1 }
        f.delete()
        e.resume(null)
        val b = waitBatch(e, id, 30)
        assertEquals(1, b.filesFailed)
        val it = e.items(id)[0]
        assertEquals(ItemState.Failed, it.state)
        assertTrue("$it", it.error.orEmpty().contains("moved or deleted"))
        f.writeText("back")
        e.retry(id)
        assertEquals(1, waitBatch(e, id, 30).filesDone)
        assertEquals("back", File(media(), "$dest/gone.txt").readText())
        runBlocking { e.shutdown() }
    }

    companion object {
        /** One paired device shared by the tests (pairing is rate-limited on the server, as it should be). */
        private var shared: Pair<String, String>? = null
    }
}
