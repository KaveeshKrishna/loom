package app.loom.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.loom.engine.Direction
import app.loom.engine.EngineEvent
import app.loom.engine.Snapshot

/** Everything the app shows in the notification shade. */
object Notifications {
    const val CHANNEL_TRANSFERS = "transfers"
    const val CHANNEL_EVENTS = "events"
    const val ID_PROGRESS = 1
    private const val ID_FINISHED = 2
    private const val ID_CONFLICTS = 3
    private const val ID_PROBLEM = 4
    const val ID_UPDATE = 5

    private fun nm(c: Context) = c.getSystemService(NotificationManager::class.java)

    fun allowed(c: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Opens the app on a screen: "transfers", "settings" or the page. */
    fun open(c: Context, screen: String? = null, request: Int = 0): PendingIntent {
        val i = Intent(c, MainActivity::class.java).apply {
            action = when (screen) {
                "transfers" -> MainActivity.ACTION_TRANSFERS
                "settings" -> MainActivity.ACTION_SETTINGS
                else -> Intent.ACTION_MAIN
            }
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(c, request, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun action(c: Context, what: String): PendingIntent =
        PendingIntent.getBroadcast(c, what.hashCode(), Intent(c, ActionReceiver::class.java).setAction(what), PendingIntent.FLAG_IMMUTABLE)

    /** The ongoing notification while transfers run (also the foreground service's / job's). */
    fun progressNotification(c: Context, s: Snapshot): Notification {
        val pct = if (s.bytesTotal > 0) (s.bytesDone * 100 / s.bytesTotal).toInt() else 0
        val files = s.active + s.queued + s.waiting
        val title = when {
            s.allPaused -> "Transfers paused"
            s.offline -> "Waiting for Loom"
            s.waitingForWifi -> "Waiting for Wi-Fi"
            s.conflicts > 0 && s.active == 0L -> "${s.conflicts} ${plural(s.conflicts, "file")} need a decision"
            else -> "Transferring ${files} ${plural(files, "file")}"
        }
        val text = buildList {
            if (s.bytesTotal > 0) add("${Format.bytes(s.bytesDone)} of ${Format.bytes(s.bytesTotal)}")
            if (s.bytesPerSecond > 0 && !s.allPaused) add("${Format.bytes(s.bytesPerSecond.toLong())}/s")
            if (s.via == "lan" && s.active > 0) add("home network")
        }.joinToString(" · ")
        return NotificationCompat.Builder(c, CHANNEL_TRANSFERS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(c.getColor(R.color.loom_blue))
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setProgress(100, pct, s.bytesTotal == 0L && !s.allPaused)
            .setContentIntent(open(c, "transfers", 1))
            .addAction(
                0,
                if (s.allPaused) "Resume" else "Pause",
                action(c, if (s.allPaused) ActionReceiver.RESUME else ActionReceiver.PAUSE),
            )
            .build()
    }

    fun progress(c: Context, s: Snapshot) {
        if (!KeepAlive.holding) return
        if (allowed(c)) nm(c).notify(ID_PROGRESS, progressNotification(c, s))
    }

    fun cancelProgress(c: Context) = nm(c).cancel(ID_PROGRESS)

    private fun event(c: Context, id: Int, title: String, text: String?, screen: String? = "transfers") {
        if (!allowed(c)) return
        nm(c).notify(
            id,
            NotificationCompat.Builder(c, CHANNEL_EVENTS)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(c.getColor(R.color.loom_blue))
                .setContentTitle(title)
                .apply { if (text != null) setContentText(text) }
                .setAutoCancel(true)
                .setContentIntent(open(c, screen, id + 10))
                .build(),
        )
    }

    fun finished(c: Context, e: EngineEvent.BatchFinished) {
        // Only worth a buzz when the app isn't on screen.
        if (LoomApp.of(c).visible) return
        val verb = if (e.direction == Direction.Upload) "Uploaded" else "Downloaded"
        val title = if (e.failed > 0) "${e.title}: ${e.failed} ${plural(e.failed, "file")} couldn't be transferred" else "$verb ${e.title}"
        val parts = buildList {
            add("${e.done} ${plural(e.done, "file")}")
            if (e.skipped > 0) add("${e.skipped} skipped")
        }
        event(c, ID_FINISHED, title, parts.joinToString(" · "))
    }

    fun conflicts(c: Context, count: Long) =
        event(c, ID_CONFLICTS, "$count ${plural(count, "file")} already in Loom", "Choose to replace, skip or keep both")

    fun signedOut(c: Context) = event(c, ID_PROBLEM, "This device was signed out of Loom", "Sign in again to continue your transfers", null)

    fun diskFull(c: Context) = event(c, ID_PROBLEM, "Loom's drive is full", "Uploads are paused until there's space")

    fun waitingAfterRestart(c: Context, count: Long) =
        event(c, ID_PROBLEM, "$count ${plural(count, "transfer")} waiting", "Tap to continue")

    fun updated(c: Context, version: String) = event(c, ID_UPDATE, "Loom was updated to $version", null, "settings")

    fun update(c: Context, title: String, text: String?, intent: PendingIntent) {
        if (!allowed(c)) return
        nm(c).notify(
            ID_UPDATE,
            NotificationCompat.Builder(c, CHANNEL_EVENTS)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(c.getColor(R.color.loom_blue))
                .setContentTitle(title)
                .apply { if (text != null) setContentText(text) }
                .setAutoCancel(true)
                .setContentIntent(intent)
                .build(),
        )
    }

    fun plural(n: Long, word: String) = if (n == 1L) word else "${word}s"
}

/** Sizes and counts for people. */
object Format {
    fun items(n: Int) = if (n == 1) "1 item" else "$n items"

    fun bytes(n: Long): String {
        if (n < 1000) return "$n B"
        val units = listOf("KB", "MB", "GB", "TB")
        var v = n / 1000.0
        var i = 0
        while (v >= 1000 && i < units.size - 1) {
            v /= 1000
            i++
        }
        return if (v >= 100) "%.0f %s".format(v, units[i]) else "%.1f %s".format(v, units[i])
    }
}
