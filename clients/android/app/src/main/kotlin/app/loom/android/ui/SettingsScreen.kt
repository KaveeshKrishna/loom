package app.loom.android.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.loom.android.BuildConfig
import app.loom.android.LoomApp
import app.loom.android.Notifications
import app.loom.android.UpdateMode
import app.loom.android.UpdateState
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(app: LoomApp, onBack: () -> Unit, onSignOut: () -> Unit) {
    val context = LocalContext.current
    var settings by remember { mutableStateOf(app.config.settings) }
    var mode by remember { mutableStateOf(app.config.updateMode) }
    val update by app.updates.state.collectAsState()
    var confirmSignOut by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) } // re-read Android's settings when coming back
    val scope = rememberCoroutineScope()

    fun save(s: app.loom.engine.Settings) {
        settings = s
        app.updateSettings(s)
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Settings") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
        )
        Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Section("Account") {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        LoomMark(40.dp)
                        Spacer(Modifier.size(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(app.config.userName ?: "Signed in", style = MaterialTheme.typography.titleSmall)
                            Text(
                                listOfNotNull(app.config.userEmail, app.config.serverUrl?.removePrefix("https://")).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Row(Modifier.padding(start = 16.dp, end = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("This device: ${app.config.deviceName}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                        TextButton(onClick = { confirmSignOut = true }) { Text("Sign out") }
                    }
                }

                Section("Transfers") {
                    Label("Files at the same time", "More is faster on a good connection")
                    Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (n in listOf(1, 2, 3, 4, 6)) FilterChip(selected = settings.parallelFiles == n, onClick = { save(settings.copy(parallelFiles = n)) }, label = { Text("$n") })
                    }
                    Spacer(Modifier.height(8.dp))
                    Label("Speed limit", null)
                    Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((label, v) in listOf("None" to 0L, "1 MB/s" to 1_000_000L, "5 MB/s" to 5_000_000L, "20 MB/s" to 20_000_000L)) {
                            FilterChip(selected = settings.speedLimit == v, onClick = { save(settings.copy(speedLimit = v)) }, label = { Text(label) })
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Toggle("Wi-Fi only", "Wait for Wi-Fi instead of using mobile data", settings.wifiOnly) { save(settings.copy(wifiOnly = it)) }
                    Toggle("Directly on the home network", "Skip the internet when this device is at home with Loom", settings.useLan) { save(settings.copy(useLan = it)) }
                }

                Section("In the background") {
                    val pm = context.getSystemService(PowerManager::class.java)
                    val unrestricted = remember(refresh) { pm.isIgnoringBatteryOptimizations(context.packageName) }
                    val notifications = remember(refresh) { Notifications.allowed(context) }
                    Status(
                        "Battery",
                        if (unrestricted) "Loom may run in the background without limits" else "Android may pause long transfers to save battery",
                        if (unrestricted) null else "Allow",
                    ) {
                        @SuppressLint("BatteryLife")
                        val i = Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
                        runCatching { context.startActivity(i) }
                        refresh++
                    }
                    Status("Notifications", if (notifications) "Progress shows in the notification shade" else "Turned off: you won't see progress outside the app", if (notifications) null else "Turn on") {
                        context.startActivity(Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(AndroidSettings.EXTRA_APP_PACKAGE, context.packageName))
                        refresh++
                    }
                }

                Section("Updates") {
                    for ((m, title, detail) in listOf(
                        Triple(UpdateMode.Ask, "Download automatically, ask to install", "Recommended"),
                        Triple(UpdateMode.Auto, "Install automatically", "When nothing is being transferred"),
                        Triple(UpdateMode.Notify, "Only tell me", "Nothing is downloaded until you choose"),
                    )) {
                        Row(
                            Modifier.fillMaxWidth().selectable(selected = mode == m, role = Role.RadioButton, onClick = { mode = m; app.config.updateMode = m })
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = mode == m, onClick = null, modifier = Modifier.padding(8.dp))
                            Column {
                                Text(title, style = MaterialTheme.typography.bodyLarge)
                                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    UpdateStatus(update, app, onCheck = { scope.launch { app.updates.check(manual = true) } })
                }

                Section("About") {
                    Text(
                        "Loom for Android ${BuildConfig.VERSION_NAME}\nLoom is open source. Your files stay on your own server.",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }

    LaunchedEffect(Unit) {
        // Android's own screens (battery, notifications) change things behind our back.
        while (true) {
            kotlinx.coroutines.delay(1500)
            refresh++
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out of Loom?") },
            text = { Text("Unfinished transfers on this device are cancelled. Your files in Loom aren't touched.") },
            confirmButton = { TextButton(onClick = { confirmSignOut = false; onSignOut() }) { Text("Sign out") } },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun UpdateStatus(state: UpdateState, app: LoomApp, onCheck: () -> Unit) {
    val context = LocalContext.current
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        val text = when (state) {
            UpdateState.Idle -> "Version ${BuildConfig.VERSION_NAME}"
            UpdateState.Checking -> "Checking for updates…"
            is UpdateState.UpToDate -> "Up to date · checked ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(state.checkedAt))}"
            is UpdateState.Available -> "Loom ${state.info.versionName} is available"
            is UpdateState.Downloading -> "Downloading Loom ${state.info.versionName}… ${state.percent}%"
            is UpdateState.Ready -> "Loom ${state.info.versionName} is ready to install"
            is UpdateState.Installing -> "Installing Loom ${state.info.versionName}…"
            is UpdateState.Failed -> state.message
        }
        Text(text, style = MaterialTheme.typography.bodyMedium, color = if (state is UpdateState.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        if (state is UpdateState.Downloading) LinearProgressIndicator(progress = { state.percent / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
        val notes = (state as? UpdateState.Ready)?.info?.notes ?: (state as? UpdateState.Available)?.info?.notes
        if (!notes.isNullOrBlank()) Text(notes, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp), maxLines = 8)
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when (state) {
                is UpdateState.Ready -> Button(onClick = {
                    if (!app.updates.canInstall()) {
                        context.startActivity(Intent(AndroidSettings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
                    } else {
                        app.updates.install(state)
                    }
                }) { Text(if (app.updates.canInstall()) "Install now" else "Allow Loom to install updates") }
                is UpdateState.Available -> Button(onClick = onCheck) { Text("Download") }
                else -> OutlinedButton(onClick = onCheck, enabled = state !is UpdateState.Checking && state !is UpdateState.Downloading && state !is UpdateState.Installing) { Text("Check now") }
            }
        }
    }
}

@Composable
fun Section(title: String, content: @Composable () -> Unit) {
    Column {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 4.dp, bottom = 8.dp))
        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(vertical = 4.dp)) { content() }
        }
    }
}

@Composable
private fun Label(title: String, detail: String?) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(title, style = MaterialTheme.typography.bodyLarge)
        if (detail != null) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Toggle(title: String, detail: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!value) }.padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.size(12.dp))
        Switch(checked = value, onCheckedChange = onChange)
    }
}

@Composable
private fun Status(title: String, detail: String, action: String?, onAction: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (action != null) TextButton(onClick = onAction) { Text(action) }
    }
}
