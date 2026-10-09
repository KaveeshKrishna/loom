package app.loom.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Configuration
import androidx.work.WorkManager
import app.loom.engine.Engine
import app.loom.engine.EngineEvent
import app.loom.engine.ServerConfig
import app.loom.engine.Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.launch
import java.io.File

class LoomApp : Application(), Configuration.Provider {
    lateinit var config: Config
        private set
    val files by lazy { AndroidFiles(this) }
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _engine = MutableStateFlow<Engine?>(null)
    /** The transfer engine while signed in. */
    val engine: StateFlow<Engine?> = _engine
    private var engineJobs: List<Job> = emptyList()

    lateinit var updates: Updates
        private set

    override val workManagerConfiguration get() = Configuration.Builder().setMinimumLoggingLevel(Log.WARN).build()

    val userAgent get() = "Loom-Android/${BuildConfig.VERSION_NAME} (Android ${android.os.Build.VERSION.RELEASE})"

    /** The app is on screen (UIDT jobs can only be started then). */
    val visible get() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    override fun onCreate() {
        super.onCreate()
        config = Config(this)
        createChannels()
        WorkManager.initialize(this, workManagerConfiguration)
        updates = Updates(this)
        startEngine()
        watchNetwork()
        updates.schedule()
    }

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(Notifications.CHANNEL_TRANSFERS, getString(R.string.channel_transfers), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.channel_transfers_about)
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(Notifications.CHANNEL_EVENTS, getString(R.string.channel_events), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = getString(R.string.channel_events_about)
            },
        )
    }

    /** Start the engine when signed in (no-op when it's already running). */
    fun startEngine(): Engine? {
        _engine.value?.let { return it }
        val server = config.serverUrl ?: return null
        val token = config.token ?: return null
        val e = Engine.start(File(filesDir, "transfers.db"), ServerConfig(server, token), config.settings, userAgent, files, ::metered)
        _engine.value = e
        observe(e)
        files.cleanIncoming(e.openLocalPaths())
        return e
    }

    fun updateSettings(s: Settings) {
        config.settings = s
        _engine.value?.updateSettings(s)
    }

    /** Forget this device's sign-in (the server side was already removed, or is being). */
    fun signOutLocally() {
        val e = _engine.value
        _engine.value = null
        engineJobs.forEach { it.cancel() }
        scope.launch(Dispatchers.IO) { e?.shutdown() }
        File(filesDir, "transfers.db").let { listOf(it, File("$it-wal"), File("$it-shm")) }.forEach { it.delete() }
        config.signOut()
        android.webkit.CookieManager.getInstance().removeAllCookies(null)
        Notifications.cancelProgress(this)
    }

    @OptIn(FlowPreview::class)
    private fun observe(e: Engine) {
        engineJobs.forEach { it.cancel() }
        engineJobs = listOf(
            scope.launch {
                e.snapshot.sample(1000).collect { s ->
                    if (s.busy && !s.signedOut) KeepAlive.ensure(this@LoomApp)
                    Notifications.progress(this@LoomApp, s)
                }
            },
            scope.launch {
                e.events.collect { ev ->
                    when (ev) {
                        is EngineEvent.BatchFinished -> {
                            Notifications.finished(this@LoomApp, ev)
                            launch(Dispatchers.IO) { files.cleanIncoming(e.openLocalPaths()) }
                        }
                        is EngineEvent.ConflictsFound -> Notifications.conflicts(this@LoomApp, ev.count)
                        is EngineEvent.SignedOut -> Notifications.signedOut(this@LoomApp)
                        is EngineEvent.DiskFull -> Notifications.diskFull(this@LoomApp)
                        is EngineEvent.ScanFinished -> {}
                    }
                }
            },
        )
    }

    // ── network ──────────────────────────────────────────────────────────────

    private val cm by lazy { getSystemService(ConnectivityManager::class.java) }

    /** On mobile data (or another metered network). */
    fun metered(): Boolean = cm.isActiveNetworkMetered

    private fun watchNetwork() {
        var last: String? = null
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                val kind = when {
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    else -> "other"
                } + network.toString()
                if (kind != last) {
                    last = kind
                    _engine.value?.networkChanged()
                }
            }

            override fun onLost(network: Network) {
                last = null
                _engine.value?.networkChanged()
            }
        })
    }

    companion object {
        fun of(context: Context) = context.applicationContext as LoomApp
    }
}
