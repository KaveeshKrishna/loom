package app.loom.engine

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.decodeCertificatePem
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/*
 * Talking to Loom: the device-token API, over the LAN when possible.
 *
 * Two HTTP clients: one for the public address (the system's certificates),
 * one for the LAN address that trusts *only* the certificate authority the
 * server handed out over the public address. The LAN is used while a probe
 * of `<lan>/api/client/info` answers with this server's instance id; any
 * failure on it switches back to the public address at once.
 */

data class LanConfig(val url: String, val caPem: String)

data class ServerConfig(
    /** e.g. https://loom.example.com */
    val publicUrl: String,
    val token: String,
    /** From /api/client/info; the LAN must answer with the same one. */
    val instanceId: String? = null,
    val lan: LanConfig? = null,
)

enum class Via { Lan, Internet }

data class UploadLimits(
    val chunkSize: Long,
    val minChunkSize: Long = 1L shl 20,
    val maxChunkSize: Long = 95L shl 20,
    val maxChunks: Long = 100_000,
    val parallelChunksPerUpload: Int = 4,
)

data class LanInfo(val url: String, val caPem: String)

data class ClientInfo(
    val product: String,
    val version: String,
    val instanceId: String,
    val upload: UploadLimits,
    val lan: LanInfo?,
    val raw: JsonObject,
)

data class Finished(val path: String, val name: String, val renamed: Boolean, val replaced: Boolean)

data class Session(
    val id: String,
    val size: Long,
    val received: Long,
    val chunkSize: Long,
    val missing: List<Long>,
    val windowEnd: Long?,
    val result: Finished?,
)

data class ExistingInfo(val kind: String, val size: Double?, val modifiedAt: String?)

data class ConflictInfo(val key: String, val same: Boolean, val existing: ExistingInfo)

data class Node(val relativePath: String, val name: String, val kind: String, val size: Long, val modifiedAt: String?) {
    val isDir get() = kind == "DIRECTORY"
}

data class Listing(val children: List<Node>, val canWrite: Boolean)

/** Outcome of sending one numbered chunk. */
enum class ChunkOutcome {
    Stored,

    /** Outside the server's write window; send earlier chunks first. */
    TooFarAhead,

    /** The server is busy (429, a chunk already in flight): try again shortly. */
    Busy,

    /** Checksum mismatch: send it again. */
    Corrupt,
}

internal val json = Json { ignoreUnknownKeys = true }
private val JSON_TYPE = "application/json".toMediaType()

/** Percent-encode a query value. */
fun q(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

internal fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
internal fun JsonElement?.long(): Long? = (this as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() ?: it.contentOrNull?.toLongOrNull() }
internal fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.booleanOrNull
internal fun JsonElement?.obj(): JsonObject? = this as? JsonObject

/** Run an OkHttp call without blocking a coroutine thread; cancelling the coroutine cancels the call. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response)
        }
    })
}

class Api(config: ServerConfig, private val userAgent: String) {
    @Volatile private var cfg = config
    private val public: OkHttpClient
    @Volatile private var lan: Pair<HttpUrl, OkHttpClient>? = null
    private val lanOk = AtomicBoolean(false)
    private val lanProbedAt = AtomicLong(0)

    init {
        cfg.publicUrl.toHttpUrlOrNull() ?: throw LoomException.Permanent("Bad server address")
        public = baseClient().build()
        setLan(cfg.lan)
    }

    private fun baseClient() = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // A chunk must finish within the proxy's limits; the read timeout
        // catches a stalled connection without capping a slow but moving one.
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(90, TimeUnit.SECONDS)
        .followRedirects(false)
        .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("User-Agent", userAgent).build()) }

    private fun lanClient(caPem: String): OkHttpClient {
        val ca = try {
            caPem.decodeCertificatePem()
        } catch (e: Exception) {
            throw LoomException.Permanent("Bad LAN certificate: ${e.message}")
        }
        val certs = HandshakeCertificates.Builder().addTrustedCertificate(ca).build()
        return baseClient()
            .sslSocketFactory(certs.sslSocketFactory(), certs.trustManager)
            .connectTimeout(4, TimeUnit.SECONDS)
            .build()
    }

    val config get() = cfg

    fun setToken(token: String) {
        cfg = cfg.copy(token = token)
    }

    /** The server's instance id: the LAN address must answer with the same one. */
    fun setInstanceId(id: String?) {
        cfg = cfg.copy(instanceId = id)
    }

    /** Use (or stop using) a LAN address. Takes effect after the next probe. */
    fun setLan(l: LanConfig?) {
        lan = l?.let { (it.url.toHttpUrlOrNull() ?: throw LoomException.Permanent("Bad LAN address")) to lanClient(it.caPem) }
        cfg = cfg.copy(lan = l)
        lanOk.set(false)
        lanProbedAt.set(0)
    }

    val via get() = if (lanOk.get()) Via.Lan else Via.Internet

    /** Forget the LAN until the next successful probe (e.g. the network changed). */
    fun lanDown() {
        lanOk.set(false)
        lanProbedAt.set(System.currentTimeMillis())
    }

    /** Probe the LAN address if it's time (or [force]). Returns whether it's in use. */
    suspend fun probeLan(force: Boolean): Boolean {
        val (url, client) = lan ?: run {
            lanOk.set(false)
            return false
        }
        val now = System.currentTimeMillis()
        val last = lanProbedAt.get()
        if (!force && last != 0L && now - last < 60_000) return lanOk.get()
        lanProbedAt.set(now)
        val expected = cfg.instanceId
        val ok = try {
            val probe = client.newBuilder().callTimeout(2, TimeUnit.SECONDS).build()
            probe.newCall(Request.Builder().url(url.resolve("/api/client/info")!!).build()).await().use { res ->
                res.isSuccessful && json.parseToJsonElement(res.body!!.string()).obj()?.get("instanceId").str().let { it != null && it == expected }
            }
        } catch (e: Exception) {
            false
        }
        lanOk.set(ok)
        return ok
    }

    private fun pick(): Triple<HttpUrl, OkHttpClient, Via> {
        if (lanOk.get()) lan?.let { return Triple(it.first, it.second, Via.Lan) }
        return Triple(cfg.publicUrl.toHttpUrlOrNull()!!, public, Via.Internet)
    }

    /**
     * Send a request (built fresh for each attempt), over the LAN when it's
     * up; a LAN failure retries once over the internet. Any failure to get a
     * response counts: leaving the home network also kills connections that
     * are already open.
     */
    private suspend fun send(path: String, tweak: (OkHttpClient) -> OkHttpClient = { it }, make: (Request.Builder) -> Request.Builder): Response {
        val (base, client, via) = pick()
        fun build(b: HttpUrl) = make(Request.Builder().url(b.newBuilder().encodedPath("/").build().toString().trimEnd('/') + path))
            .header("Authorization", "Bearer ${cfg.token}")
            .build()
        return try {
            tweak(client).newCall(build(base)).await()
        } catch (e: IOException) {
            if (via != Via.Lan) throw e.asLoom()
            lanDown()
            val (b2, c2, _) = pick()
            try {
                tweak(c2).newCall(build(b2)).await()
            } catch (e2: IOException) {
                throw e2.asLoom()
            }
        }
    }

    private suspend fun jsonCall(method: String, path: String, body: JsonElement? = null): JsonElement {
        val res = send(path) { b -> b.method(method, body?.toString()?.toRequestBody(JSON_TYPE) ?: if (method == "GET" || method == "DELETE") null else "{}".toRequestBody(JSON_TYPE)) }
        res.use {
            val text = it.body?.string() ?: ""
            val parsed = runCatching { json.parseToJsonElement(text) }.getOrNull()
            if (!it.isSuccessful) throw classify(it.code, parsed)
            return parsed ?: throw LoomException.Permanent("Unexpected answer from Loom")
        }
    }

    // ── server ───────────────────────────────────────────────────────────────

    suspend fun clientInfo(): ClientInfo = parseClientInfo(jsonCall("GET", "/api/client/info").jsonObject)

    /** Checks the token still works (401 → SignedOut). */
    suspend fun me(): JsonObject = jsonCall("GET", "/api/devices/me").jsonObject

    /** A one-time path that signs the app's web view in. */
    suspend fun webLogin(): String =
        jsonCall("POST", "/api/devices/web-login", buildJsonObject { }).obj()?.get("path").str() ?: throw LoomException.Permanent("Unexpected answer")

    suspend fun signOut() {
        jsonCall("DELETE", "/api/devices/me")
    }

    // ── folders ──────────────────────────────────────────────────────────────

    suspend fun list(path: String): Listing {
        val o = jsonCall("GET", "/api/files?path=${q(path)}").jsonObject
        val children = o["children"]?.jsonArray?.mapNotNull { e ->
            val n = e.obj() ?: return@mapNotNull null
            Node(
                relativePath = n["relativePath"].str() ?: return@mapNotNull null,
                name = n["name"].str() ?: "",
                kind = n["type"].str() ?: "FILE",
                size = n["size"].long() ?: 0,
                modifiedAt = n["modifiedAt"].str(),
            )
        } ?: emptyList()
        return Listing(children, o["canWrite"].bool() ?: false)
    }

    suspend fun mkdir(parent: String, name: String) {
        val res = send("/api/fs/mkdir") { it.post(buildJsonObject { put("parentPath", parent); put("name", name) }.toString().toRequestBody(JSON_TYPE)) }
        res.use {
            if (it.code == 409) return // already there
            if (!it.isSuccessful) throw classify(it.code, runCatching { json.parseToJsonElement(it.body!!.string()) }.getOrNull())
        }
    }

    /** Which of these files (paths relative to destDir: path, size, mtime) already exist. */
    suspend fun conflicts(destDir: String, files: List<Triple<String, Long, Long>>): List<ConflictInfo> {
        val out = mutableListOf<ConflictInfo>()
        for (batch in files.chunked(5000)) {
            val body = buildJsonObject {
                put("op", "upload")
                put("destDir", destDir)
                put("files", buildJsonArray {
                    for ((p, s, m) in batch) add(buildJsonObject { put("path", p); put("size", s); put("lastModified", m) })
                })
            }
            val r = jsonCall("POST", "/api/fs/conflicts", body).jsonObject
            r["conflicts"]?.jsonArray?.forEach { c ->
                val o = c.obj() ?: return@forEach
                val ex = o["existing"].obj()
                out += ConflictInfo(
                    key = o["key"].str() ?: return@forEach,
                    same = o["same"].bool() ?: false,
                    existing = ExistingInfo(ex?.get("type").str() ?: "FILE", (ex?.get("size") as? JsonPrimitive)?.doubleOrNull, ex?.get("modifiedAt").str()),
                )
            }
        }
        return out
    }

    // ── uploads ──────────────────────────────────────────────────────────────

    suspend fun createSession(destDir: String, relativePath: String, size: Long, lastModified: Long, clientRef: String, chunkSize: Long): Session =
        parseSession(
            jsonCall("POST", "/api/upload/sessions", buildJsonObject {
                put("destDir", destDir)
                put("relativePath", relativePath)
                put("size", size)
                put("lastModified", lastModified)
                put("mode", "chunks")
                put("clientRef", clientRef)
                put("chunkSize", chunkSize)
            }).jsonObject,
        )

    suspend fun getSession(id: String): Session {
        send("/api/upload/sessions/$id") { it.get() }.use { res ->
            if (res.code == 404) throw LoomException.SessionGone()
            val parsed = runCatching { json.parseToJsonElement(res.body!!.string()) }.getOrNull()
            if (!res.isSuccessful) throw classify(res.code, parsed)
            return parseSession(parsed?.jsonObject ?: throw LoomException.Permanent("Unexpected answer"))
        }
    }

    suspend fun deleteSession(id: String) {
        send("/api/upload/sessions/$id") { it.delete() }.use { res ->
            if (res.code == 404 || res.isSuccessful) return
            throw classify(res.code, runCatching { json.parseToJsonElement(res.body!!.string()) }.getOrNull())
        }
    }

    /** Send chunk [index]; [body] streams it (counting progress and keeping the speed limit). */
    suspend fun putChunk(id: String, index: Long, sha256Hex: String, body: () -> RequestBody): ChunkOutcome {
        val res = send("/api/upload/sessions/$id?chunk=$index", tweak = { it.newBuilder().writeTimeout(600, TimeUnit.SECONDS).readTimeout(600, TimeUnit.SECONDS).build() }) {
            it.put(body()).header("x-chunk-sha256", sha256Hex)
        }
        res.use {
            if (it.isSuccessful) return ChunkOutcome.Stored
            val o = runCatching { json.parseToJsonElement(it.body!!.string()) }.getOrNull().obj()
            return when {
                it.code == 409 && o?.containsKey("windowEnd") == true -> ChunkOutcome.TooFarAhead
                it.code == 409 && o?.containsKey("retry") == true -> ChunkOutcome.Busy
                it.code == 409 && o?.containsKey("result") == true -> ChunkOutcome.Stored // already finished
                it.code == 422 -> ChunkOutcome.Corrupt
                it.code == 429 -> ChunkOutcome.Busy
                it.code == 404 -> throw LoomException.SessionGone()
                else -> throw classify(it.code, o)
            }
        }
    }

    /** Finish an upload whose chunks have all arrived. Repeating it is safe. Null = chunks are missing. */
    suspend fun complete(id: String, conflict: String): Finished? {
        send("/api/upload/sessions/$id/complete?conflict=${q(conflict)}") { it.post("{}".toRequestBody(JSON_TYPE)) }.use { res ->
            val o = runCatching { json.parseToJsonElement(res.body!!.string()) }.getOrNull().obj()
            if (res.isSuccessful) return parseFinished(o ?: throw LoomException.Permanent("Unexpected answer"))
            return when {
                res.code == 404 -> throw LoomException.SessionGone()
                res.code == 409 && o?.containsKey("missing") == true -> null
                res.code == 409 -> throw LoomException.Transient("The upload is being finished")
                else -> throw classify(res.code, o)
            }
        }
    }

    // ── downloads ────────────────────────────────────────────────────────────

    /** GET a file from [offset] on (Range + If-Range when resuming). The caller closes the response. */
    suspend fun download(path: String, offset: Long, etag: String?): Response {
        val res = send("/api/files/serve?path=${q(path)}&download=1", tweak = { it.newBuilder().readTimeout(120, TimeUnit.SECONDS).build() }) { b ->
            var r = b.get()
            if (offset > 0) {
                r = r.header("Range", "bytes=$offset-")
                if (etag != null) r = r.header("If-Range", etag)
            }
            r
        }
        if (res.isSuccessful || res.code == 416) return res
        res.use {
            if (it.code == 404) throw LoomException.Permanent("The file is no longer in Loom")
            throw classify(it.code, runCatching { json.parseToJsonElement(it.body!!.string()) }.getOrNull())
        }
    }

    /** One ZIP of these Loom paths. The caller closes the response. */
    suspend fun downloadZip(paths: List<String>): Response {
        val body = buildJsonObject { put("paths", buildJsonArray { paths.forEach { add(JsonPrimitive(it)) } }) }
        val res = send("/api/download/zip", tweak = { it.newBuilder().readTimeout(300, TimeUnit.SECONDS).build() }) { it.post(body.toString().toRequestBody(JSON_TYPE)) }
        if (res.isSuccessful) return res
        res.use { throw classify(it.code, runCatching { json.parseToJsonElement(it.body!!.string()) }.getOrNull()) }
    }

    companion object {
        fun parseClientInfo(o: JsonObject): ClientInfo {
            val up = o["upload"].obj()
            val lan = o["lan"].obj()
            return ClientInfo(
                product = o["product"].str() ?: "",
                version = o["version"].str() ?: "",
                instanceId = o["instanceId"].str() ?: "",
                upload = UploadLimits(
                    chunkSize = up?.get("chunkSize").long() ?: (8L shl 20),
                    minChunkSize = up?.get("minChunkSize").long() ?: (1L shl 20),
                    maxChunkSize = up?.get("maxChunkSize").long() ?: (95L shl 20),
                    maxChunks = up?.get("maxChunks").long() ?: 100_000,
                    parallelChunksPerUpload = up?.get("parallelChunksPerUpload").long()?.toInt() ?: 4,
                ),
                lan = lan?.let { l -> l["url"].str()?.let { u -> l["caPem"].str()?.let { LanInfo(u, it) } } },
                raw = o,
            )
        }

        private fun parseFinished(o: JsonObject) = Finished(o["path"].str() ?: "", o["name"].str() ?: "", o["renamed"].bool() ?: false, o["replaced"].bool() ?: false)

        private fun parseSession(o: JsonObject) = Session(
            id = o["id"].str() ?: throw LoomException.Permanent("Unexpected answer"),
            size = o["size"].long() ?: 0,
            received = o["received"].long() ?: 0,
            chunkSize = o["chunkSize"].long() ?: (8L shl 20),
            missing = (o["missing"] as? JsonArray)?.mapNotNull { it.long() } ?: emptyList(),
            windowEnd = o["windowEnd"].long(),
            result = o["result"].obj()?.let { parseFinished(it) },
        )

        /** Turn a non-success answer into an error the engine knows how to handle. */
        fun classify(status: Int, body: JsonElement?): LoomException {
            val msg = body.obj()?.get("error").str()
            return when (status) {
                401 -> LoomException.SignedOut()
                507 -> LoomException.DiskFull()
                408, 425, 429 -> LoomException.Transient(msg ?: "Loom is busy")
                in 500..599 -> LoomException.Transient(msg ?: "Loom isn't answering properly ($status)")
                else -> LoomException.Permanent("$status ${msg ?: "error"}")
            }
        }
    }
}

/** SHA-256 of some bytes, hex. */
fun sha256Hex(data: ByteArray, len: Int = data.size): String {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    md.update(data, 0, len)
    return md.digest().joinToString("") { "%02x".format(it) }
}
