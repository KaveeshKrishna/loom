package app.loom.android

import app.loom.engine.await
import app.loom.engine.sha256Hex
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/*
 * Signing this phone in to a Loom. The token is made here and only its hash
 * is sent, so it never crosses the network; Loom only ever stores the hash.
 * Two ways: approve the phone in Loom (signed in on this phone's own web
 * view), or redeem a one-time code from Loom's Devices page (its QR code).
 */
object Pairing {
    private val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private val JSON = "application/json".toMediaType()

    sealed interface Check {
        data class Ok(val url: String, val version: String) : Check
        data class Problem(val message: String) : Check
    }

    /** "loom.example.com" → "https://loom.example.com" (origin only). */
    fun normalize(input: String): String? {
        val t = input.trim().trimEnd('/')
        if (t.isEmpty()) return null
        val withScheme = if (t.startsWith("http://") || t.startsWith("https://")) t else "https://$t"
        val u = withScheme.toHttpUrlOrNull() ?: return null
        val port = if ((u.scheme == "https" && u.port == 443) || (u.scheme == "http" && u.port == 80)) "" else ":${u.port}"
        return "${u.scheme}://${u.host}$port"
    }

    suspend fun check(input: String): Check {
        val url = normalize(input) ?: return Check.Problem("That isn't a web address.")
        var last: Check = Check.Problem("There's no Loom at that address.")
        // One more try after a moment: a Loom that's just restarting answers with an error briefly.
        repeat(2) { attempt ->
            if (attempt > 0) delay(1500)
            last = try {
                http.newCall(Request.Builder().url("$url/api/client/info").build()).await().use { res ->
                    val o = runCatching { Json.parseToJsonElement(res.body!!.string()).jsonObject }.getOrNull()
                    when {
                        res.code == 404 && o == null -> Check.Problem("There's no Loom at that address, or it's older than 2.2 (the app needs 2.2 or later).")
                        !res.isSuccessful -> Check.Problem("Loom at that address answered with an error (HTTP ${res.code}). Try again in a moment.")
                        o?.get("product")?.jsonPrimitive?.contentOrNull != "loom" -> Check.Problem("There's no Loom at that address.")
                        else -> return Check.Ok(url, o["version"]?.jsonPrimitive?.contentOrNull ?: "")
                    }
                }
            } catch (e: IOException) {
                Check.Problem("Can't reach that address. Check it, and that this device is online.")
            }
        }
        return last
    }

    fun newToken(): Pair<String, String> {
        val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val token = "loomd_" + android.util.Base64.encodeToString(raw, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
        return token to sha256Hex(token.toByteArray())
    }

    data class Started(val pairId: String, val secret: String, val checkCode: String, val approveUrl: String, val token: String)

    sealed interface Result {
        data class Approved(val token: String, val userName: String?, val userEmail: String?) : Result
        data class Failed(val message: String) : Result
    }

    private suspend fun post(url: String, body: JsonObject): Pair<Int, JsonObject?> =
        http.newCall(Request.Builder().url(url).post(body.toString().toRequestBody(JSON)).build()).await().use { res ->
            res.code to runCatching { Json.parseToJsonElement(res.body!!.string()).jsonObject }.getOrNull()
        }

    private fun JsonObject?.s(vararg path: String): String? {
        var o: JsonObject? = this
        for (k in path.dropLast(1)) o = o?.get(k) as? JsonObject
        return o?.get(path.last())?.jsonPrimitive?.contentOrNull
    }

    /** Ask Loom to pair this phone; the user then allows it on the approval page. */
    suspend fun start(server: String, deviceName: String): Started {
        val (token, hash) = newToken()
        val (code, o) = try {
            post("$server/api/devices/pair/start", buildJsonObject {
                put("name", deviceName)
                put("platform", "android")
                put("appVersion", BuildConfig.VERSION_NAME)
                put("tokenHash", hash)
            })
        } catch (e: IOException) {
            throw IllegalStateException("Can't reach Loom")
        }
        if (code !in 200..299 || o == null) throw IllegalStateException(o.s("error") ?: "Loom refused the request")
        return Started(o.s("pairId")!!, o.s("secret")!!, o.s("checkCode") ?: "", server + (o.s("approvePath") ?: "/"), token)
    }

    /** Wait for the approval page's answer. */
    suspend fun await(server: String, p: Started): Result {
        while (true) {
            delay(2000)
            val (code, o) = try {
                post("$server/api/devices/pair/poll", buildJsonObject { put("pairId", p.pairId); put("secret", p.secret) })
            } catch (e: IOException) {
                continue
            }
            when {
                code == 200 && o.s("status") == "approved" -> return Result.Approved(p.token, o.s("user", "name"), o.s("user", "email"))
                code == 403 -> return Result.Failed("The request was declined in Loom.")
                code == 404 || code == 410 -> return Result.Failed("The request expired. Try again.")
            }
        }
    }

    /** Redeem a code from Loom's Devices page (typed, or from its QR code). */
    suspend fun redeem(server: String, codeText: String, deviceName: String): Result {
        val (token, hash) = newToken()
        return try {
            val (code, o) = post("$server/api/devices/pair/redeem", buildJsonObject {
                put("code", codeText.trim().uppercase())
                put("name", deviceName)
                put("platform", "android")
                put("appVersion", BuildConfig.VERSION_NAME)
                put("tokenHash", hash)
            })
            if (code in 200..299) Result.Approved(token, o.s("user", "name"), o.s("user", "email"))
            else Result.Failed(o.s("error") ?: "That code didn't work.")
        } catch (e: IOException) {
            Result.Failed("Can't reach Loom. Check that this phone is online.")
        }
    }

    /** "loom://pair?server=…&code=…" from the Devices page's QR code. */
    fun parseQr(text: String): Pair<String, String>? {
        if (!text.startsWith("loom://pair")) return null
        val q = text.substringAfter('?', "").split('&').associate { it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('=', ""), "UTF-8") }
        val server = q["server"]?.let { normalize(it) } ?: return null
        val code = q["code"]?.takeIf { it.isNotBlank() } ?: return null
        return server to code
    }
}
