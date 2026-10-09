package app.loom.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/** Once, at the first upload: big transfers need Loom to run in the background without Android's battery limits. */
object BatteryPrompt {
    @SuppressLint("BatteryLife")
    fun maybeAsk(c: Context) {
        val pm = c.getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(c.packageName)) return
        AlertDialog.Builder(c)
            .setTitle("Keep transfers going in the background?")
            .setMessage("Android may pause long uploads to save battery. Allowing Loom to run in the background lets them finish with the screen off.")
            .setPositiveButton("Allow") { _, _ ->
                runCatching { c.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${c.packageName}"))) }
            }
            .setNegativeButton("Not now", null)
            .show()
    }
}
