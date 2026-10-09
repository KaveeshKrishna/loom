package app.loom.android

import android.content.Context
import androidx.webkit.WebViewCompat

/** Loom's pages need a WebView from the last few years (Chrome 100+). */
object WebViewCheck {
    const val MIN_MAJOR = 100

    /** The installed WebView's version when it's too old, else null. */
    fun tooOld(context: Context): String? {
        val version = WebViewCompat.getCurrentWebViewPackage(context)?.versionName ?: return null
        val major = version.substringBefore('.').toIntOrNull() ?: return null
        return if (major < MIN_MAJOR) version else null
    }
}
