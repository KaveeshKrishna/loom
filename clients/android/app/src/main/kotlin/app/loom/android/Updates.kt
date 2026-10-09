package app.loom.android

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.loom.engine.await
import app.loom.engine.sha256Hex
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/*
 * Updates from the project's GitHub releases: android.json in the rolling
 * "updates" release names the newest APK and its SHA-256. The APK must also
 * be signed with the same key as this app (Android refuses anything else
 * anyway). Installing goes through Android's PackageInstaller: the first
 * time Android asks; from then on Loom is the app's installer and updates
 * can go in by themselves (Android 12+).
 */

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data class UpToDate(val checkedAt: Long) : UpdateState
    data class Available(val info: UpdateInfo) : UpdateState
    data class Downloading(val info: UpdateInfo, val percent: Int) : UpdateState
    data class Ready(val info: UpdateInfo, val file: File) : UpdateState
    data class Installing(val info: UpdateInfo) : UpdateState
    data class Failed(val message: String) : UpdateState
}

data class UpdateInfo(val versionCode: Int, val versionName: String, val url: String, val sha256: String, val notes: String)

class Updates(private val app: LoomApp) {
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
    private val lock = Mutex()
    private val dir get() = File(app.cacheDir, "updates").apply { mkdirs() }

    /** Check every 6 hours in the background, and soon after the app starts. */
    fun schedule() {
        WorkManager.getInstance(app).enqueueUniquePeriodicWork(
            "loom-updates",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<UpdateWorker>(6, TimeUnit.HOURS).build(),
        )
        if (System.currentTimeMillis() - app.config.lastUpdateCheck > 60 * 60_000) {
            app.scope.launch { kotlinx.coroutines.delay(20_000); check(manual = false) }
        }
    }

    /** Look for a newer version; with the default setting, download it too. */
    suspend fun check(manual: Boolean) = lock.withLock {
        val current = _state.value
        if (current is UpdateState.Downloading || current is UpdateState.Installing) return@withLock
        if (current is UpdateState.Ready && current.file.exists() && !manual) return@withLock maybeInstall()
        _state.value = UpdateState.Checking
        val info = try {
            fetchManifest()
        } catch (e: Exception) {
            _state.value = if (manual) UpdateState.Failed("Couldn't check for updates. Try again later.") else UpdateState.Idle
            return@withLock
        }
        app.config.lastUpdateCheck = System.currentTimeMillis()
        if (info == null || info.versionCode <= BuildConfig.VERSION_CODE) {
            _state.value = UpdateState.UpToDate(System.currentTimeMillis())
            dir.listFiles()?.forEach { it.delete() }
            return@withLock
        }
        _state.value = UpdateState.Available(info)
        when (app.config.updateMode) {
            UpdateMode.Notify -> Notifications.update(app, "Loom ${info.versionName} is available", "Open Loom's settings to install it", Notifications.open(app, "settings", 30))
            else -> download(info)
        }
    }

    private suspend fun fetchManifest(): UpdateInfo? = withContext(Dispatchers.IO) {
        http.newCall(Request.Builder().url(BuildConfig.UPDATE_URL).build()).await().use { res ->
            if (res.code == 404) return@withContext null // nothing published yet
            if (!res.isSuccessful) throw IllegalStateException("HTTP ${res.code}")
            val o = Json.parseToJsonElement(res.body!!.string()).jsonObject
            UpdateInfo(
                versionCode = o["versionCode"]!!.jsonPrimitive.intOrNull!!,
                versionName = o["versionName"]!!.jsonPrimitive.contentOrNull!!,
                url = o["url"]!!.jsonPrimitive.contentOrNull!!,
                sha256 = o["sha256"]!!.jsonPrimitive.contentOrNull!!.lowercase(),
                notes = o["notes"]?.jsonPrimitive?.contentOrNull ?: "",
            )
        }
    }

    private suspend fun download(info: UpdateInfo) {
        val file = File(dir, "loom-${info.versionCode}.apk")
        try {
            if (!(file.exists() && fileSha(file) == info.sha256)) {
                _state.value = UpdateState.Downloading(info, 0)
                withContext(Dispatchers.IO) {
                    http.newCall(Request.Builder().url(info.url).build()).await().use { res ->
                        if (!res.isSuccessful) throw IllegalStateException("HTTP ${res.code}")
                        val body = res.body!!
                        val total = body.contentLength()
                        val md = MessageDigest.getInstance("SHA-256")
                        var done = 0L
                        file.outputStream().use { out ->
                            body.byteStream().use { input ->
                                val buf = ByteArray(64 * 1024)
                                while (true) {
                                    val n = input.read(buf)
                                    if (n < 0) break
                                    out.write(buf, 0, n)
                                    md.update(buf, 0, n)
                                    done += n
                                    if (total > 0) _state.value = UpdateState.Downloading(info, (done * 100 / total).toInt())
                                }
                            }
                        }
                        val sha = md.digest().joinToString("") { "%02x".format(it) }
                        if (sha != info.sha256) {
                            file.delete()
                            throw IllegalStateException("The download was damaged")
                        }
                    }
                }
            }
            if (!sameSigner(file)) {
                file.delete()
                _state.value = UpdateState.Failed("The update isn't signed by Loom's publisher, so it wasn't installed.")
                return
            }
            _state.value = UpdateState.Ready(info, file)
            if (app.config.updateMode == UpdateMode.Ask) {
                Notifications.update(app, "Loom ${info.versionName} is ready to install", "Tap to install it", Notifications.open(app, "settings", 31))
            }
            maybeInstall()
        } catch (e: Exception) {
            _state.value = UpdateState.Failed("Couldn't download the update: ${e.message}")
        }
    }

    private fun fileSha(f: File): String = f.inputStream().use { input ->
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        md.digest().joinToString("") { "%02x".format(it) }
    }

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo?): Set<String>? {
        if (info == null) return null
        val certs = if (Build.VERSION.SDK_INT >= 28) {
            info.signingInfo?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory }
        } else {
            info.signatures
        } ?: return null
        return certs.map { sha256Hex(it.toByteArray()) }.toSet()
    }

    @Suppress("DEPRECATION")
    private fun sameSigner(apk: File): Boolean {
        val pm = app.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val mine = signers(pm.getPackageInfo(app.packageName, flags)) ?: return true
        val archive = pm.getPackageArchiveInfo(apk.path, flags) ?: return false
        if (archive.packageName != app.packageName) return false
        // Some Android versions can't read an archive's signers; Android itself
        // still refuses to install an update signed with another key.
        val theirs = signers(archive) ?: return true
        return mine.intersect(theirs).isNotEmpty()
    }

    /** "Install when idle": go ahead once nothing is being transferred. */
    fun maybeInstall() {
        val s = _state.value as? UpdateState.Ready ?: return
        if (app.config.updateMode != UpdateMode.Auto) return
        val busy = app.engine.value?.snapshot?.value?.busy == true
        if (!busy) install(s)
    }

    /** Can Loom install apps? (Android asks once, in its settings.) */
    fun canInstall() = app.packageManager.canRequestPackageInstalls()

    fun install(ready: UpdateState.Ready = _state.value as UpdateState.Ready) {
        _state.value = UpdateState.Installing(ready.info)
        app.scope.launch(Dispatchers.IO) {
            try {
                val pi = app.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(app.packageName)
                    if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                    if (Build.VERSION.SDK_INT >= 34) setRequestUpdateOwnership(true)
                }
                val id = pi.createSession(params)
                pi.openSession(id).use { session ->
                    session.openWrite("loom.apk", 0, ready.file.length()).use { out ->
                        ready.file.inputStream().use { it.copyTo(out) }
                        session.fsync(out)
                    }
                    val status = PendingIntent.getBroadcast(
                        app, id, Intent(app, InstallReceiver::class.java),
                        PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0),
                    )
                    session.commit(status.intentSender)
                }
            } catch (e: Exception) {
                _state.value = UpdateState.Failed("Couldn't install the update: ${e.message}")
            }
        }
    }

    /** The install didn't happen (declined, or Android refused it): it can be tried again. */
    internal fun installFinished(status: Int, message: String?) {
        val apk = dir.listFiles()?.maxByOrNull { it.lastModified() }
        val info = (_state.value as? UpdateState.Installing)?.info
        _state.value = if (status == PackageInstaller.STATUS_FAILURE_ABORTED && apk != null && info != null) {
            UpdateState.Ready(info, apk)
        } else {
            UpdateState.Failed(message?.let { "The update wasn't installed: $it" } ?: "The update wasn't installed")
        }
    }

    /** The app was just replaced by a newer version. */
    fun afterUpdate() {
        if (app.config.lastVersion != BuildConfig.VERSION_CODE) {
            if (app.config.lastVersion != 0) Notifications.updated(app, BuildConfig.VERSION_NAME)
            app.config.lastVersion = BuildConfig.VERSION_CODE
        }
        dir.listFiles()?.forEach { it.delete() }
    }
}

class UpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        LoomApp.of(applicationContext).updates.check(manual = false)
        return Result.success()
    }
}

/** Android's answer to an install. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = LoomApp.of(context)
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT))
                    ?: return
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (app.visible) {
                    runCatching { context.startActivity(confirm) }
                } else {
                    Notifications.update(
                        context, "Tap to finish updating Loom", null,
                        PendingIntent.getActivity(context, 32, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
                    )
                }
            }
            PackageInstaller.STATUS_SUCCESS -> {}
            else -> app.updates.installFinished(intent.getIntExtra(PackageInstaller.EXTRA_STATUS, 0), intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
        }
    }
}
