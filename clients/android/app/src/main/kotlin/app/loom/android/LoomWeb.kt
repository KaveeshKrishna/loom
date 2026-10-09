package app.loom.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.View
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import app.loom.engine.await
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Loom's own web page in a WebView: signed in with the device token (the
 * web-login link), links to other sites open in the browser, and when Loom
 * can't be reached the app shows its offline screen and retries by itself.
 */
@SuppressLint("SetJavaScriptEnabled")
class LoomWeb(
    context: Context,
    private val app: LoomApp,
    private val scope: CoroutineScope,
    private val events: Events,
) {
    interface Events {
        fun onDownload(path: String, name: String)
        fun onFileChooser(callback: ValueCallback<Array<Uri>>, multiple: Boolean): Boolean
        fun onFullscreen(view: View?)
    }

    val server = app.config.serverUrl!!.trimEnd('/')
    val view = WebView(context)
    val bridge = Bridge(view, server) { req -> requests.value = req }

    /** The page's last request, for the activity to act on. */
    val requests = MutableStateFlow<PageRequest?>(null)
    val loading = MutableStateFlow(true)
    /** Loom isn't answering: the offline screen is up. */
    val offline = MutableStateFlow(false)
    /** The approval page is open (pairing): the page isn't Loom's app yet. */
    var pairing = false

    private var lastUrl: String = "$server/files"
    private var loggingIn = 0L
    private var retry: Job? = null
    private val health = OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()

    init {
        CookieManager.getInstance().setAcceptCookie(true)
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            builtInZoomControls = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString LoomAndroid/${BuildConfig.VERSION_NAME}"
        }
        view.isVerticalScrollBarEnabled = false
        bridge.install()
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        view.setDownloadListener { url, _, disposition, _, _ ->
            val u = Uri.parse(url)
            if (url.startsWith(server) && u.path == "/api/files/serve") {
                val path = u.getQueryParameter("path") ?: return@setDownloadListener
                val name = Regex("filename\\*?=(?:UTF-8'')?\"?([^\";]+)").find(disposition ?: "")?.groupValues?.get(1)?.let { Uri.decode(it) }
                    ?: path.substringAfterLast('/')
                events.onDownload(path, name)
            } else {
                openOutside(url)
            }
        }
    }

    fun load(url: String = lastUrl) {
        lastUrl = url
        view.loadUrl(url)
    }

    /** Open Loom at a folder (e.g. "Show in Loom"). */
    fun openFolder(path: String) {
        val url = "$server/files" + (if (path.isEmpty()) "" else "/" + path.split('/').joinToString("/") { Uri.encode(it) })
        if (offline.value) lastUrl = url else bridge.navigate(path).also { if (!view.url.orEmpty().startsWith(server)) load(url) }
    }

    fun reload() {
        offline.value = false
        if (view.url.isNullOrEmpty() || view.url == "about:blank") load() else view.reload()
    }

    private fun openOutside(url: String) {
        runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    /** Sign the web view in with the device token, then go on to [next]. */
    private fun webLogin(next: String) {
        val e = app.engine.value ?: return
        if (System.currentTimeMillis() - loggingIn < 30_000) return
        loggingIn = System.currentTimeMillis()
        scope.launch {
            try {
                val path = e.api.webLogin()
                val sep = if (path.contains('?')) '&' else '?'
                val nextPath = Uri.parse(next).let { it.encodedPath + (it.encodedQuery?.let { q -> "?$q" } ?: "") }
                view.loadUrl("$server$path${sep}next=${Uri.encode(nextPath)}")
            } catch (ex: Exception) {
                failed(next)
            }
        }
    }

    /** A page didn't load: is Loom down, or was it just that page? */
    private fun failed(url: String) {
        if (pairing) return
        scope.launch {
            if (healthy()) return@launch
            lastUrl = url.takeIf { it.startsWith(server) && !it.contains("/api/") } ?: lastUrl
            offline.value = true
            retry?.cancel()
            retry = scope.launch {
                while (offline.value) {
                    delay(3000)
                    if (healthy()) {
                        offline.value = false
                        load(lastUrl)
                    }
                }
            }
        }
    }

    suspend fun healthy(): Boolean = try {
        health.newCall(Request.Builder().url("$server/api/health").build()).await().use { it.isSuccessful }
    } catch (e: Exception) {
        false
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (url.startsWith(server)) return false
            if (url.startsWith("loom://")) return true
            openOutside(url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            loading.value = true
            bridge.pageStarted()
            // Loom asks to sign in: the device token does that.
            val path = Uri.parse(url).path.orEmpty()
            if (!pairing && url.startsWith(server) && path == "/login") {
                val next = Uri.parse(url).getQueryParameter("next") ?: "/files"
                webLogin("$server$next")
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            loading.value = false
            if (url.startsWith(server) && !url.contains("/login") && !pairing) lastUrl = url
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) failed(request.url.toString())
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && (response.statusCode >= 500 || response.statusCode == 404)) failed(request.url.toString())
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
            events.onFileChooser(callback, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            fullscreenCallback = callback
            events.onFullscreen(view)
        }

        override fun onHideCustomView() {
            fullscreenCallback = null
            events.onFullscreen(null)
        }
    }

    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    fun exitFullscreen(): Boolean {
        val cb = fullscreenCallback ?: return false
        cb.onCustomViewHidden()
        fullscreenCallback = null
        events.onFullscreen(null)
        return true
    }
}
