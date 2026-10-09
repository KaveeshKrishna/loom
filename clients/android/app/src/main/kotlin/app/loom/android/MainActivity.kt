package app.loom.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.view.ContentInfoCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.draganddrop.DropHelper
import androidx.lifecycle.lifecycleScope
import app.loom.android.ui.ApprovalBanner
import app.loom.android.ui.DestinationPicker
import app.loom.android.ui.LoomTheme
import app.loom.android.ui.Offline
import app.loom.android.ui.OldWebView
import app.loom.android.ui.Onboarding
import app.loom.android.ui.Scanner
import app.loom.android.ui.SettingsScreen
import app.loom.android.ui.TransferStrip
import app.loom.android.ui.TransfersScreen
import app.loom.engine.DownloadRequest
import app.loom.engine.OnConflict
import app.loom.engine.RemoteEntry
import app.loom.engine.UploadRequest
import app.loom.engine.UploadSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Where the app is. Loom's page stays loaded underneath the others. */
sealed interface Screen {
    data object Loom : Screen
    data object Transfers : Screen
    data object Settings : Screen
    data object Scan : Screen
    /** Choose where picked files go (the Upload shortcut). */
    data class Destination(val uris: List<Uri>) : Screen
}

class MainActivity : ComponentActivity(), LoomWeb.Events {
    companion object {
        const val ACTION_TRANSFERS = "app.loom.android.TRANSFERS"
        const val ACTION_SETTINGS = "app.loom.android.SETTINGS"
        const val ACTION_UPLOAD = "app.loom.android.UPLOAD"
    }

    private val app get() = LoomApp.of(this)
    private var web: LoomWeb? = null
    private var screen by mutableStateOf<Screen>(Screen.Loom)
    private var signedIn by mutableStateOf(false)
    private var checkCode by mutableStateOf<String?>(null)
    private var pendingPair by mutableStateOf<Pair<String, String>?>(null)
    /** The folder on screen in Loom, and whether files can be added there. */
    private var location: Pair<String, Boolean>? = null
    /** Dropped onto Loom (tablets, split screen), waiting for "Upload?". */
    private var dropped by mutableStateOf<List<Uri>?>(null)
    private var fullscreen: View? = null

    // ── pickers ──────────────────────────────────────────────────────────────

    private var pickDest = ""
    private val pickFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> picked(uris, folder = false) }
    private val pickFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri -> picked(listOfNotNull(uri), folder = true) }
    private val pickForShortcut = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) {
            uris.forEach { keepAccess(it) }
            screen = Screen.Destination(uris)
        }
    }
    private var chooserCallback: ValueCallback<Array<Uri>>? = null
    private val pageChooser = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        chooserCallback?.onReceiveValue(uris.toTypedArray())
        chooserCallback = null
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    private var afterStoragePermission: (() -> Unit)? = null
    private val askStorage = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) afterStoragePermission?.invoke() else toast("Loom needs permission to save downloads")
        afterStoragePermission = null
    }

    private fun keepAccess(uri: Uri) {
        // Uploads resume after a restart, so the access must outlive this screen.
        runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    private fun picked(uris: List<Uri>, folder: Boolean) {
        if (uris.isEmpty()) return
        uris.forEach { keepAccess(it) }
        upload(pickDest, uris.map { UploadSource(it.toString()) }, if (folder) null else uris.size)
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        signedIn = app.config.signedIn
        app.updates.afterUpdate()
        handleIntent(intent)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    web?.exitFullscreen() == true -> {}
                    screen != Screen.Loom -> screen = Screen.Loom
                    web?.view?.canGoBack() == true -> web!!.view.goBack()
                    else -> moveTaskToBack(true)
                }
            }
        })

        setContent {
            LoomTheme {
                val wide = calculateWindowSizeClass(this).widthSizeClass == WindowWidthSizeClass.Expanded
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
                    if (!signedIn) SignIn() else Main(wide)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        when (intent?.action) {
            ACTION_TRANSFERS -> if (app.config.signedIn) screen = Screen.Transfers
            ACTION_SETTINGS -> if (app.config.signedIn) screen = Screen.Settings
            ACTION_UPLOAD -> if (app.config.signedIn) pickForShortcut.launch(arrayOf("*/*"))
            Intent.ACTION_VIEW -> intent.data?.toString()?.let { Pairing.parseQr(it) }?.let { if (!app.config.signedIn) pendingPair = it }
        }
    }

    override fun onDestroy() {
        web?.view?.destroy()
        super.onDestroy()
    }

    // ── signing in ───────────────────────────────────────────────────────────

    @Composable
    private fun SignIn() {
        if (screen == Screen.Scan) {
            Scanner(onResult = { text ->
                screen = Screen.Loom
                val p = Pairing.parseQr(text)
                if (p == null) toast("That isn't a Loom pairing code") else pendingPair = p
            }, onClose = { screen = Screen.Loom })
            return
        }
        val approving = checkCode != null && web != null
        if (approving) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                ApprovalBanner(checkCode!!) {
                    checkCode = null
                    web?.view?.destroy()
                    web = null
                }
                AndroidView({ web!!.view.also { (it.parent as? ViewGroup)?.removeView(it) } }, Modifier.fillMaxSize())
            }
            return
        }
        val pair = pendingPair
        Onboarding(
            initialServer = pair?.first ?: app.config.serverUrl,
            initialCode = pair?.second,
            onApprove = { server -> approve(server) },
            onRedeem = { server, code -> redeem(server, code) },
            onScan = { screen = Screen.Scan },
        )
    }

    private fun approve(server: String) {
        lifecycleScope.launch {
            try {
                val started = Pairing.start(server, app.config.deviceName)
                app.config.serverUrl = server
                val w = LoomWeb(this@MainActivity, app, lifecycleScope, this@MainActivity).also { it.pairing = true }
                web = w
                checkCode = started.checkCode
                w.load(started.approveUrl)
                when (val r = Pairing.await(server, started)) {
                    is Pairing.Result.Approved -> signedInAs(server, r)
                    is Pairing.Result.Failed -> {
                        toast(r.message)
                        checkCode = null
                        web?.view?.destroy()
                        web = null
                    }
                }
            } catch (e: Exception) {
                toast(e.message ?: "Couldn't start signing in")
            }
        }
    }

    private suspend fun redeem(server: String, code: String): String? =
        when (val r = Pairing.redeem(server, code, app.config.deviceName)) {
            is Pairing.Result.Approved -> {
                signedInAs(server, r)
                null
            }
            is Pairing.Result.Failed -> r.message
        }

    private fun signedInAs(server: String, r: Pairing.Result.Approved) {
        app.config.serverUrl = server
        app.config.token = r.token
        app.config.userName = r.userName
        app.config.userEmail = r.userEmail
        app.startEngine()
        checkCode = null
        pendingPair = null
        web?.view?.destroy()
        web = null
        signedIn = true
        if (Build.VERSION.SDK_INT >= 33) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun signOut() {
        val e = app.engine.value
        lifecycleScope.launch {
            runCatching { e?.api?.signOut() }
            app.signOutLocally()
            web?.view?.destroy()
            web = null
            screen = Screen.Loom
            signedIn = false
        }
    }

    // ── signed in ────────────────────────────────────────────────────────────

    private fun web(): LoomWeb = web ?: LoomWeb(this, app, lifecycleScope, this).also { w ->
        web = w
        w.load()
        installDrop(w)
        lifecycleScope.launch { w.requests.collect { it?.let { r -> w.requests.value = null; onRequest(r) } } }
        lifecycleScope.launch {
            app.engine.collectLatest { e -> e?.snapshot?.collect { s -> w.bridge.transfers(s) } }
        }
    }

    @Composable
    private fun Main(wide: Boolean) {
        val engine by app.engine.collectAsState()
        val e = engine
        if (e == null) {
            LaunchedEffect(Unit) { if (app.startEngine() == null) signedIn = false }
            return
        }
        WebViewCheck.tooOld(this)?.let { version ->
            OldWebView(version)
            return
        }
        val w = web()
        val snapshot by e.snapshot.collectAsState()
        val loading by w.loading.collectAsState()
        val offline by w.offline.collectAsState()
        LaunchedEffect(snapshot.signedOut) {
            if (snapshot.signedOut) {
                toast("This device was signed out of Loom")
                app.signOutLocally()
                web?.view?.destroy()
                web = null
                signedIn = false
            }
        }
        // On a wide screen Transfers sits beside Loom; otherwise it covers it.
        val side = wide && screen == Screen.Transfers
        Row(Modifier.fillMaxSize()) {
            Column(Modifier.weight(1f).fillMaxHeight().statusBarsPadding().navigationBarsPadding().imePadding()) {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    AndroidView({ w.view.also { (it.parent as? ViewGroup)?.removeView(it) } }, Modifier.fillMaxSize())
                    if (loading && !offline) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
                    if (offline) Offline(w.server, onReload = { w.reload() }, onTransfers = { screen = Screen.Transfers })
                }
                if (!side) TransferStrip(snapshot) { screen = Screen.Transfers }
            }
            if (side) {
                VerticalDivider()
                Surface(Modifier.width(440.dp).fillMaxHeight().statusBarsPadding().navigationBarsPadding()) {
                    TransfersScreen(e, wide = false, onBack = { screen = Screen.Loom }, onShowInLoom = { w.openFolder(it) })
                }
            }
        }
        AnimatedVisibility(visible = screen != Screen.Loom && !side) {
            Surface(Modifier.fillMaxSize().safeDrawingPadding(), color = MaterialTheme.colorScheme.surface) {
                when (val s = screen) {
                    Screen.Transfers -> TransfersScreen(e, wide, onBack = { screen = Screen.Loom }, onShowInLoom = { screen = Screen.Loom; w.openFolder(it) })
                    Screen.Settings -> SettingsScreen(app, onBack = { screen = Screen.Loom }, onSignOut = ::signOut)
                    is Screen.Destination -> DestinationPicker(e, app.config.lastFolder, Format.items(s.uris.size), onCancel = { screen = Screen.Loom }) { dest ->
                        screen = Screen.Loom
                        upload(dest, s.uris.map { UploadSource(it.toString()) }, s.uris.size)
                    }
                    else -> {}
                }
            }
        }
        dropped?.let { uris ->
            val (folder, _) = location ?: ("" to false)
            AlertDialog(
                onDismissRequest = { dropped = null },
                title = { Text("Upload to ${folder.substringAfterLast('/').ifEmpty { "Loom" }}?") },
                text = { Text(Format.items(uris.size)) },
                confirmButton = {
                    TextButton(onClick = {
                        dropped = null
                        uploadCopies(folder, uris)
                    }) { Text("Upload") }
                },
                dismissButton = { TextButton(onClick = { dropped = null }) { Text("Cancel") } },
            )
        }
    }

    // ── what the page asks for ───────────────────────────────────────────────

    private fun onRequest(r: PageRequest) {
        when (r) {
            is PageRequest.PickUpload -> {
                pickDest = r.destDir
                if (r.folder) pickFolder.launch(null) else pickFiles.launch(arrayOf("*/*"))
            }
            is PageRequest.Download -> withStorage {
                val e = app.engine.value ?: return@withStorage
                e.download(DownloadRequest(r.items.map { RemoteEntry(it.first, it.second, it.third) }, app.files.downloadRoot, zip = r.zip))
                KeepAlive.ensure(this)
                web?.bridge?.toast(if (r.zip) "Making a ZIP in Download/Loom" else "Downloading to Download/Loom", action = "transfers")
            }
            PageRequest.OpenTransfers -> screen = Screen.Transfers
            PageRequest.OpenSettings -> screen = Screen.Settings
            is PageRequest.SetLocation -> {
                location = r.path?.let { it to r.canWrite }
                if (r.path != null && r.canWrite) app.config.lastFolder = r.path
            }
            PageRequest.SignedOut -> signOut()
        }
    }

    /** Before Android 10, saving to Download/ needs a permission. */
    private fun withStorage(then: () -> Unit) {
        if (Build.VERSION.SDK_INT >= 29 || ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
            then()
        } else {
            afterStoragePermission = then
            askStorage.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
    }

    private fun upload(dest: String, sources: List<UploadSource>, files: Int?) {
        val e = app.engine.value ?: return
        e.upload(UploadRequest(dest, sources, OnConflict.Ask))
        KeepAlive.ensure(this)
        val where = dest.substringAfterLast('/').ifEmpty { "Loom" }
        val what = if (files == null) "the folder" else Format.items(files)
        web?.bridge?.toast("Uploading $what to $where", action = "transfers") ?: toast("Uploading $what to $where")
        if (!app.config.batteryAsked) {
            app.config.batteryAsked = true
            BatteryPrompt.maybeAsk(this)
        }
    }

    /** Dropped and shared files: their access ends soon, so they're copied first. */
    private fun uploadCopies(dest: String, uris: List<Uri>) {
        lifecycleScope.launch {
            val copies = withContext(Dispatchers.IO) { app.files.copyIn(uris) }
            if (copies.isEmpty()) return@launch toast("Couldn't read what was dropped")
            upload(dest, copies.map { UploadSource(it.path) }, copies.size)
        }
    }

    // ── drag and drop (tablets, split screen, desktop mode) ─────────────────

    private fun installDrop(w: LoomWeb) {
        DropHelper.configureView(
            this,
            w.view,
            // Any file (DropHelper doesn't take "*/*").
            arrayOf("image/*", "video/*", "audio/*", "text/*", "application/*", "font/*", "model/*"),
            DropHelper.Options.Builder().setHighlightColor(getColor(R.color.loom_blue)).setHighlightCornerRadiusPx(0).build(),
        ) { _, payload ->
            val clip = payload.clip
            val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
            val loc = location
            when {
                uris.isEmpty() -> return@configureView payload
                loc == null || !loc.second -> toast("Open a folder you can add to, then drop the files there")
                else -> dropped = uris
            }
            null as ContentInfoCompat?
        }
    }

    // ── LoomWeb.Events ───────────────────────────────────────────────────────

    override fun onDownload(path: String, name: String) = withStorage {
        app.engine.value?.download(DownloadRequest(listOf(RemoteEntry(path, name, false)), app.files.downloadRoot))
        KeepAlive.ensure(this)
        web?.bridge?.toast("Downloading to Download/Loom", action = "transfers")
    }

    override fun onFileChooser(callback: ValueCallback<Array<Uri>>, multiple: Boolean): Boolean {
        chooserCallback?.onReceiveValue(null)
        chooserCallback = callback
        pageChooser.launch(arrayOf("*/*"))
        return true
    }

    override fun onFullscreen(view: View?) {
        val decor = window.decorView as FrameLayout
        val controller = WindowCompat.getInsetsController(window, decor)
        fullscreen?.let { decor.removeView(it) }
        fullscreen = view
        if (view != null) {
            decor.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
}
