package app.loom.android

import android.annotation.SuppressLint
import android.net.Uri
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.loom.engine.Snapshot
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/*
 * The bridge between Loom's web page and the app: the same protocol as Loom
 * for Windows (version 2, see web/lib/client/native.ts). A script that runs
 * before Loom's page defines `window.LoomApp`; the page's requests arrive as
 * JSON strings through a message listener that only Loom's own origin can
 * reach. Each request is answered with a `loomapp:ack` event, so the page
 * knows it was heard (and does the job itself when it wasn't).
 */

/** What the page asked for. */
sealed interface PageRequest {
    data class PickUpload(val destDir: String, val folder: Boolean) : PageRequest
    data class Download(val items: List<Triple<String, String, Boolean>>, val zip: Boolean) : PageRequest
    data object OpenTransfers : PageRequest
    data object OpenSettings : PageRequest
    data class SetLocation(val path: String?, val canWrite: Boolean) : PageRequest
    data object SignedOut : PageRequest
}

class Bridge(private val web: WebView, private val origin: String, private val handle: (PageRequest) -> Unit) {
    private var ready = false
    private val pending = ArrayList<String>()

    companion object {
        val supported get() = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

        fun script(origin: String) = """(() => {
  const port = window.LoomAndroid;
  if (!port || location.origin !== ${JsonPrimitive(origin)} || window.LoomApp) return;
  let seq = 0;
  const pending = new Map();
  window.addEventListener("loomapp:ack", (e) => {
    const d = (e && e.detail) || {};
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.ok) p.resolve(d.detail === undefined ? null : d.detail);
    else p.reject(new Error(d.error || "The Loom app couldn't do that"));
  });
  const send = (msg) => port.postMessage(JSON.stringify(msg));
  const request = (msg) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("The Loom app didn't answer")); }, 60000);
    pending.set(id, { resolve, reject, timer });
    try { send(Object.assign({}, msg, { id })); } catch (err) { pending.delete(id); clearTimeout(timer); reject(err); }
  });
  Object.defineProperty(window, "LoomApp", {
    configurable: false,
    value: Object.freeze({
      apiVersion: 2,
      platform: "android",
      appVersion: ${JsonPrimitive(BuildConfig.VERSION_NAME)},
      capabilities: ["uploads.picker", "downloads", "downloads.zip", "transfers", "settings"],
      pickUpload: (destDir, mode) => request({ type: "pickUpload", destDir, mode }),
      download: (req) => request({ type: "download", items: req.items, zip: !!req.zip }),
      openTransfers: () => request({ type: "openTransfers" }),
      openSettings: () => request({ type: "openSettings" }),
      setLocation: (loc) => send({ type: "setLocation", path: loc.path, canWrite: !!loc.canWrite }),
      signedOut: () => send({ type: "signedOut" }),
      ready: () => send({ type: "ready" }),
      log: (level, message) => send({ type: "log", level: String(level), message: String(message).slice(0, 2000) }),
    }),
  });
})();"""
    }

    @SuppressLint("RequiresFeature")
    fun install() {
        if (!supported) return
        val rules = setOf(origin)
        WebViewCompat.addWebMessageListener(web, "LoomAndroid", rules) { _: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, _: JavaScriptReplyProxy ->
            // Only Loom's own page, in the top frame.
            if (!isMainFrame || sourceOrigin.toString().trimEnd('/') != origin) return@addWebMessageListener
            message.data?.let { onMessage(it) }
        }
        WebViewCompat.addDocumentStartJavaScript(web, script(origin), rules)
    }

    /** A new page is loading: hold events until it says it's listening. */
    fun pageStarted() {
        ready = false
        pending.clear()
    }

    private fun onMessage(text: String) {
        val o = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        val id = o["id"]?.jsonPrimitive?.longOrNull
        val type = o["type"]?.jsonPrimitive?.contentOrNull
        val req: PageRequest? = when (type) {
            "pickUpload" -> PageRequest.PickUpload(o.s("destDir") ?: "", o.s("mode") == "folder")
            "download" -> PageRequest.Download(
                o["items"]?.jsonArray?.mapNotNull { e ->
                    val i = e as? JsonObject ?: return@mapNotNull null
                    Triple(i.s("path") ?: return@mapNotNull null, i.s("name") ?: "", i.s("type") == "DIRECTORY")
                } ?: emptyList(),
                o["zip"]?.jsonPrimitive?.booleanOrNull == true,
            )
            "openTransfers" -> PageRequest.OpenTransfers
            "openSettings" -> PageRequest.OpenSettings
            "setLocation" -> PageRequest.SetLocation(o.s("path"), o["canWrite"]?.jsonPrimitive?.booleanOrNull == true)
            "signedOut" -> PageRequest.SignedOut
            "ready" -> {
                ready = true
                pending.forEach { web.evaluateJavascript(it, null) }
                pending.clear()
                null
            }
            "log" -> {
                Log.i("LoomPage", "${o.s("level")}: ${o.s("message")}")
                null
            }
            else -> null
        }
        // Answer at once: the page only needs to know the app has it.
        if (id != null) ack(id, req != null || type == "ready", if (req == null && type != "ready") "Not supported by the Loom app" else null)
        req?.let(handle)
    }

    private fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull

    private fun ack(id: Long, ok: Boolean, error: String?) {
        val detail = buildJsonObject {
            put("id", id)
            put("ok", ok)
            if (error != null) put("error", error)
        }
        web.evaluateJavascript(eventJs("loomapp:ack", detail), null)
    }

    private fun eventJs(name: String, detail: JsonElement) = "window.dispatchEvent(new CustomEvent(${JsonPrimitive(name)}, { detail: $detail }));"

    /** Send an event to the page (held until it's listening). */
    fun event(name: String, detail: JsonElement) {
        val js = eventJs(name, detail)
        if (ready) web.evaluateJavascript(js, null) else if (pending.size < 20) pending += js
    }

    fun transfers(s: Snapshot) {
        if (!ready) return
        event("loomapp:transfers", buildJsonObject {
            put("active", s.active)
            put("queued", s.queued)
            put("paused", s.paused)
            put("failed", s.failed)
            put("bytesDone", s.bytesDone)
            put("bytesTotal", s.bytesTotal)
            put("bytesPerSecond", s.bytesPerSecond)
            put("via", s.via)
        })
    }

    fun toast(message: String, kind: String = "info", action: String? = null) = event("loomapp:toast", buildJsonObject {
        put("kind", kind)
        put("message", message)
        if (action != null) put("action", action)
    })

    fun navigate(path: String) = event("loomapp:navigate", buildJsonObject { put("path", path) })
}
