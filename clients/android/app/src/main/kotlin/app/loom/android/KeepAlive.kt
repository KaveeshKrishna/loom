package app.loom.android

import android.app.Service
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.ServiceCompat
import app.loom.engine.Snapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/*
 * Keeps the app alive while transfers run, so they continue with the app
 * closed and the screen off:
 * - Android 14+: a user-initiated data transfer job (no time limit), started
 *   while the app is on screen;
 * - otherwise a foreground service (Android 15 limits these to 6 hours a
 *   day; after that a notification asks to tap and continue).
 * Both hold a Wi-Fi and a CPU wake lock and show the progress notification.
 */
object KeepAlive {
    @Volatile var holding = false
        private set
    private const val JOB_ID = 1001

    fun ensure(c: Context) {
        if (holding) return
        val app = LoomApp.of(c)
        if (Build.VERSION.SDK_INT >= 34 && app.visible) {
            val js = c.getSystemService(JobScheduler::class.java)
            if (js.canRunUserInitiatedJobs() && js.getPendingJob(JOB_ID) == null) {
                val info = JobInfo.Builder(JOB_ID, ComponentName(c, TransferJob::class.java))
                    .setUserInitiated(true)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setEstimatedNetworkBytes(JobInfo.NETWORK_BYTES_UNKNOWN, JobInfo.NETWORK_BYTES_UNKNOWN)
                    .build()
                if (runCatching { js.schedule(info) }.getOrDefault(JobScheduler.RESULT_FAILURE) == JobScheduler.RESULT_SUCCESS) {
                    holding = true
                    return
                }
            } else if (js.getPendingJob(JOB_ID) != null) {
                return
            }
        }
        try {
            c.startForegroundService(Intent(c, TransferService::class.java))
            holding = true
        } catch (e: Exception) {
            // Android doesn't allow starting from the background right now
            // (after a reboot, or the daily limit): ask to tap and continue.
            val s = app.engine.value?.snapshot?.value ?: return
            Notifications.waitingAfterRestart(c, s.active + s.queued + s.waiting)
        }
    }

    internal fun released() {
        holding = false
    }

    /** Wake locks while working, so transfers continue with the screen off. */
    internal class Locks(c: Context) {
        private val wake = c.getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "loom:transfers")
        @Suppress("DEPRECATION")
        private val wifi = c.applicationContext.getSystemService(WifiManager::class.java)
            .createWifiLock(if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF, "loom:transfers")

        fun acquire() {
            runCatching { wake.acquire(6 * 60 * 60 * 1000L) }
            runCatching { wifi.acquire() }
        }

        fun release() {
            runCatching { if (wake.isHeld) wake.release() }
            runCatching { if (wifi.isHeld) wifi.release() }
        }
    }

    /** Wait until the engine has nothing left to do (it stays a few seconds idle first). */
    internal suspend fun untilIdle(app: LoomApp, onSnapshot: (Snapshot) -> Unit) {
        var idleSince = 0L
        while (true) {
            val e = app.engine.value ?: return
            val s = e.snapshot.value
            onSnapshot(s)
            val idle = !s.busy || s.signedOut || s.allPaused || (s.conflicts > 0 && s.active == 0L && s.queued == 0L && s.waiting == 0L)
            if (idle) {
                if (idleSince == 0L) idleSince = System.currentTimeMillis()
                if (System.currentTimeMillis() - idleSince > 5000) return
            } else {
                idleSince = 0
            }
            delay(1000)
        }
    }
}

class TransferService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var locks: KeepAlive.Locks? = null
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = LoomApp.of(this)
        val snap = app.engine.value?.snapshot?.value ?: Snapshot()
        ServiceCompat.startForeground(
            this,
            Notifications.ID_PROGRESS,
            Notifications.progressNotification(this, snap),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
        )
        if (job == null) {
            locks = KeepAlive.Locks(this).also { it.acquire() }
            job = scope.launch {
                app.startEngine()
                KeepAlive.untilIdle(app) {}
                stop()
            }
        }
        return START_NOT_STICKY
    }

    /** Android 15: the daily time for this kind of service is used up. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        val s = LoomApp.of(this).engine.value?.snapshot?.value
        stop()
        if (s != null && s.busy) Notifications.waitingAfterRestart(this, s.active + s.queued + s.waiting)
    }

    private fun stop() {
        locks?.release()
        locks = null
        KeepAlive.released()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        locks?.release()
        KeepAlive.released()
        scope.cancel()
        super.onDestroy()
    }
}

class TransferJob : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var locks: KeepAlive.Locks? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val app = LoomApp.of(this)
        if (Build.VERSION.SDK_INT >= 34) {
            setNotification(params, Notifications.ID_PROGRESS, Notifications.progressNotification(this, app.engine.value?.snapshot?.value ?: Snapshot()), JOB_END_NOTIFICATION_POLICY_REMOVE)
        }
        locks = KeepAlive.Locks(this).also { it.acquire() }
        scope.launch {
            app.startEngine()
            KeepAlive.untilIdle(app) {}
            locks?.release()
            KeepAlive.released()
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        locks?.release()
        KeepAlive.released()
        scope.cancel()
        // Stopped by Android (e.g. the network constraint): continue when it allows.
        return LoomApp.of(this).engine.value?.snapshot?.value?.busy == true
    }
}

/** Pause / Resume from the notification. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val e = LoomApp.of(context).startEngine() ?: return
        when (intent.action) {
            PAUSE -> e.pause(null)
            RESUME -> {
                e.resume(null)
                KeepAlive.ensure(context)
            }
        }
        Notifications.progress(context, e.snapshot.value)
    }

    companion object {
        const val PAUSE = "app.loom.android.PAUSE"
        const val RESUME = "app.loom.android.RESUME"
    }
}

/** After a restart or an update: carry on with unfinished transfers. */
class SystemReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = LoomApp.of(context)
        val pending = goAsync()
        app.scope.launch {
            try {
                if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) app.updates.afterUpdate()
                val e = app.startEngine() ?: return@launch
                // Give the engine a moment to read the queue.
                delay(1500)
                val s = e.snapshot.first { true }
                if (s.busy) KeepAlive.ensure(context)
            } finally {
                pending.finish()
            }
        }
    }
}
