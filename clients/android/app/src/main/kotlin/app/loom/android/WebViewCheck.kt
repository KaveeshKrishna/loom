package app.loom.android

import android.content.Context
import androidx.webkit.WebViewCompat

/** Loom's pages need a WebView from 2023 or later (Chrome 111+, for its CSS). */
object WebViewCheck {
    const val MIN_MAJOR = 111

    /** The installed WebView's version when it's too old, else null. */
    fun tooOld(context: Context): String? {
        val version = WebViewCompat.getCurrentWebViewPackage(context)?.versionName ?: return null
        val major = version.substringBefore('.').toIntOrNull() ?: return null
        return if (major < MIN_MAJOR) version else null
    }
}
