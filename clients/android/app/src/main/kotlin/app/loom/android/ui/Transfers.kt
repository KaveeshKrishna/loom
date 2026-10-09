package app.loom.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.SignalWifiOff
import androidx.compose.material.icons.outlined.SwapVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.loom.android.Format
import app.loom.engine.BatchId
import app.loom.engine.BatchView
import app.loom.engine.ConflictView
import app.loom.engine.Direction
import app.loom.engine.Engine
import app.loom.engine.ItemState
import app.loom.engine.ItemView
import app.loom.engine.OnConflict
import app.loom.engine.Snapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Uploads and downloads: everything the engine is doing or did, with
 * pause, resume, cancel, retry and the "name already taken" decisions.
 * On a wide screen the selected transfer's files show beside the list.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransfersScreen(engine: Engine, wide: Boolean, onBack: (() -> Unit)?, onShowInLoom: (String) -> Unit) {
    val snapshot by engine.snapshot.collectAsState()
    var batches by remember { mutableStateOf(emptyList<BatchView>()) }
    var selected by remember { mutableStateOf<BatchId?>(null) }
    var resolving by remember { mutableStateOf<BatchId?>(null) }
    var menu by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(engine) {
        while (true) {
            batches = withContext(Dispatchers.IO) { engine.batches(true) }
            delay(700)
        }
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Transfers") },
            navigationIcon = { if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
            actions = {
                if (snapshot.busy || snapshot.allPaused) {
                    if (snapshot.allPaused) {
                        TextButton(onClick = { engine.resume(null) }) { Text("Resume all") }
                    } else {
                        TextButton(onClick = { engine.pause(null) }) { Text("Pause all") }
                    }
                }
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Clear finished") }, onClick = {
                            menu = false
                            engine.clearFinished()
                        })
                        DropdownMenuItem(text = { Text("Retry failed") }, onClick = {
                            menu = false
                            engine.retry()
                        })
                    }
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
        )
        StatusBanner(snapshot)
        if (batches.isEmpty()) {
            Empty()
            return@Column
        }
        Row(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = if (wide) Modifier.width(420.dp).fillMaxSize() else Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(batches, key = { it.id }) { b ->
                    BatchCard(
                        b,
                        selected = wide && selected == b.id,
                        onClick = { selected = if (selected == b.id && !wide) null else b.id },
                        onPause = { if (b.paused) engine.resume(b.id) else engine.pause(b.id) },
                        onCancel = { scope.launch { engine.cancel(b.id) } },
                        onRetry = { engine.retry(b.id) },
                        onResolve = { resolving = b.id },
                        onRemove = { engine.removeBatch(b.id) },
                        onShow = { onShowInLoom(b.remoteDir) },
                        expanded = !wide && selected == b.id,
                        engine = engine,
                    )
                }
            }
            if (wide) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    val b = batches.firstOrNull { it.id == selected }
                    if (b == null) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("Select a transfer to see its files", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    } else {
                        ItemList(engine, b.id, Modifier.fillMaxSize())
                    }
                }
            }
        }
    }
    resolving?.let { id -> ConflictDialog(engine, id) { resolving = null } }
}

@Composable
private fun StatusBanner(s: Snapshot) {
    val (icon, text) = when {
        s.signedOut -> Icons.Outlined.ErrorOutline to "This device was signed out of Loom. Sign in again to continue."
        s.diskFull -> Icons.Outlined.ErrorOutline to "Loom's drive is full. Uploads continue when there's space."
        s.offline && s.busy -> Icons.Outlined.CloudOff to "Can't reach Loom. Transfers continue when it's back."
        s.waitingForWifi -> Icons.Outlined.SignalWifiOff to "Waiting for Wi-Fi. Turn off Wi-Fi only in Settings to use mobile data."
        s.via == "lan" && s.active > 0 -> Icons.Outlined.Home to "Transferring directly over your home network."
        else -> return
    }
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(18.dp))
            Spacer(Modifier.width(12.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun Empty() {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Outlined.SwapVert, null, Modifier.size(40.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(12.dp))
            Text("No transfers yet", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text(
                "Uploads and downloads you start in Loom appear here. They keep going in the background.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.width(300.dp),
            )
        }
    }
}

private fun stateLine(b: BatchView): String {
    val files = if (b.filesTotal == 1L) "1 file" else "${b.filesTotal} files"
    return when {
        b.scanning -> "Looking through the folder… ${b.filesTotal} files so far"
        b.state == "cancelled" -> "Cancelled"
        b.finished && b.filesFailed > 0 -> "${b.filesDone} of $files done · ${b.filesFailed} failed"
        b.finished -> buildString {
            append(if (b.direction == Direction.Upload) "Uploaded " else "Downloaded ")
            append(files)
            if (b.filesSkipped > 0) append(" · ${b.filesSkipped} skipped")
            if (b.bytesTotal > 0) append(" · ${Format.bytes(b.bytesTotal)}")
        }
        b.filesConflict > 0 -> "${b.filesConflict} already in Loom · waiting for your decision"
        b.paused -> "Paused · ${Format.bytes(b.bytesDone)} of ${Format.bytes(b.bytesTotal)}"
        else -> buildString {
            append("${b.filesDone} of $files")
            if (b.bytesTotal > 0) append(" · ${Format.bytes(b.bytesDone)} of ${Format.bytes(b.bytesTotal)}")
            if (b.bytesPerSecond > 0) append(" · ${Format.bytes(b.bytesPerSecond.toLong())}/s")
        }
    }
}

@Composable
private fun BatchCard(
    b: BatchView,
    selected: Boolean,
    expanded: Boolean,
    engine: Engine,
    onClick: () -> Unit,
    onPause: () -> Unit,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onResolve: () -> Unit,
    onRemove: () -> Unit,
    onShow: () -> Unit,
) {
    val upload = b.direction == Direction.Upload
    val icon: ImageVector = when {
        b.finished && b.filesFailed == 0L && b.state != "cancelled" -> Icons.Outlined.CheckCircle
        b.filesFailed > 0 -> Icons.Outlined.ErrorOutline
        upload -> Icons.Outlined.CloudUpload
        else -> Icons.Outlined.CloudDownload
    }
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).testTag("batch"),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, Modifier.size(22.dp), tint = if (b.filesFailed > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(b.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        (if (upload) "To " else "From ") + (b.remoteDir.ifEmpty { "Loom" }),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (!b.finished) {
                Spacer(Modifier.height(12.dp))
                val p = if (b.bytesTotal > 0) b.bytesDone.toFloat() / b.bytesTotal else 0f
                if (b.scanning || b.bytesTotal == 0L) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                } else {
                    LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "${(p * 100).toInt()} percent" })
                }
            }
            Spacer(Modifier.height(8.dp))
            Text(stateLine(b), style = Tabular.merge(MaterialTheme.typography.bodySmall), color = MaterialTheme.colorScheme.onSurfaceVariant)
            b.lastError?.takeIf { !b.finished || b.filesFailed > 0 }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                if (b.filesConflict > 0) OutlinedButton(onClick = onResolve) { Text("Decide") }
                if (!b.finished) {
                    IconButton(onClick = onPause) { Icon(if (b.paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause, if (b.paused) "Resume" else "Pause") }
                    IconButton(onClick = onCancel) { Icon(Icons.Outlined.Close, "Cancel") }
                }
                if (b.filesFailed > 0) IconButton(onClick = onRetry) { Icon(Icons.Outlined.Refresh, "Retry") }
                Spacer(Modifier.weight(1f))
                if (upload && b.finished && b.state != "cancelled") TextButton(onClick = onShow) {
                    Icon(Icons.Outlined.FolderOpen, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Show in Loom")
                }
                if (b.finished) TextButton(onClick = onRemove) { Text("Remove") }
            }
            if (expanded) {
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                ItemList(engine, b.id, Modifier.fillMaxWidth().height(320.dp))
            }
        }
    }
}

@Composable
private fun ItemList(engine: Engine, batch: BatchId, modifier: Modifier) {
    var items by remember(batch) { mutableStateOf(emptyList<ItemView>()) }
    LaunchedEffect(batch) {
        while (true) {
            items = withContext(Dispatchers.IO) { engine.items(batch, 0, 300) }
            delay(1000)
        }
    }
    LazyColumn(modifier, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(items, key = { it.id }) { it ->
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(it.remotePath.substringAfterLast('/'), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(8.dp))
                    Text(itemState(it), style = Tabular.merge(MaterialTheme.typography.labelSmall), color = if (it.state == ItemState.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (it.state == ItemState.Running && it.size > 0) {
                    Spacer(Modifier.height(4.dp))
                    LinearProgressIndicator(progress = { it.bytesDone.toFloat() / it.size }, modifier = Modifier.fillMaxWidth())
                }
                it.error?.takeIf { _ -> it.state == ItemState.Failed || it.state == ItemState.Waiting }?.let { e ->
                    Text(e, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                }
            }
        }
    }
}

private fun itemState(i: ItemView) = when (i.state) {
    ItemState.Running -> if (i.size > 0) "${i.bytesDone * 100 / i.size}%" else "Sending"
    ItemState.Done -> Format.bytes(i.size)
    ItemState.Queued, ItemState.Checking -> "Waiting"
    ItemState.Waiting -> "Retrying soon"
    ItemState.Conflict -> "Already in Loom"
    ItemState.Skipped -> "Skipped"
    ItemState.Failed -> "Failed"
    ItemState.Cancelled -> "Cancelled"
}

/** "These files are already in Loom": Replace, Skip or Keep both, one by one or for all. */
@Composable
private fun ConflictDialog(engine: Engine, batch: BatchId, onDone: () -> Unit) {
    var list by remember { mutableStateOf(emptyList<ConflictView>()) }
    LaunchedEffect(batch) {
        while (true) {
            list = withContext(Dispatchers.IO) { engine.conflicts(batch) }
            if (list.isEmpty()) {
                onDone()
                return@LaunchedEffect
            }
            delay(800)
        }
    }
    val first = list.firstOrNull()
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(if (list.size == 1) "This file is already in Loom" else "${list.size} files are already in Loom") },
        text = {
            Column {
                if (first != null) {
                    Text(first.relativePath, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        buildString {
                            append("New: ${Format.bytes(first.incomingSize)}")
                            first.existingSize?.let { append(" · In Loom: ${Format.bytes(it)}") }
                            if (first.same) append(" · Probably the same file")
                        },
                        style = Tabular.merge(MaterialTheme.typography.bodySmall),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (first.existingIsFolder) Text("A folder has this name: the file can only be kept beside it or skipped.", style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(16.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (!first.existingIsFolder) OutlinedButton(onClick = { engine.decide(batch, first.itemId, OnConflict.Replace) }) { Text("Replace") }
                        OutlinedButton(onClick = { engine.decide(batch, first.itemId, OnConflict.Skip) }) { Text("Skip") }
                        OutlinedButton(onClick = { engine.decide(batch, first.itemId, OnConflict.KeepBoth) }) { Text("Keep both") }
                    }
                    if (!first.existingIsFolder) {
                        Spacer(Modifier.height(8.dp))
                        Text("Replace moves the file in Loom to Trash.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        },
        confirmButton = {
            if (list.size > 1) TextButton(onClick = { engine.decide(batch, null, OnConflict.KeepBoth); onDone() }) { Text("Keep both for all") }
        },
        dismissButton = {
            if (list.size > 1) TextButton(onClick = { engine.decide(batch, null, OnConflict.Skip); onDone() }) { Text("Skip all") }
            else TextButton(onClick = onDone) { Text("Later") }
        },
    )
}

/** The slim bar under Loom's page while something is being transferred. */
@Composable
fun TransferStrip(s: Snapshot, onOpen: () -> Unit) {
    if (!(s.busy || s.allPaused)) return
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen).testTag("strip")) {
        Column {
            val p = if (s.bytesTotal > 0) s.bytesDone.toFloat() / s.bytesTotal else 0f
            if (s.bytesTotal > 0 && !s.allPaused) LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth().height(3.dp))
            else HorizontalDivider()
            Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.SwapVert, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(12.dp))
                val files = s.active + s.queued + s.waiting
                val text = when {
                    s.allPaused -> "Transfers paused"
                    s.offline -> "Waiting for Loom · $files left"
                    s.waitingForWifi -> "Waiting for Wi-Fi · $files left"
                    s.conflicts > 0 && files == 0L -> "${s.conflicts} need a decision"
                    else -> buildString {
                        append("$files ${if (files == 1L) "file" else "files"} left")
                        if (s.bytesTotal > 0) append(" · ${(p * 100).toInt()}%")
                        if (s.bytesPerSecond > 0) append(" · ${Format.bytes(s.bytesPerSecond.toLong())}/s")
                    }
                }
                Text(text, style = Tabular.merge(MaterialTheme.typography.bodyMedium), modifier = Modifier.weight(1f), maxLines = 1)
                if (s.via == "lan" && s.active > 0) {
                    Surface(shape = RoundedCornerShape(6.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                        Text("Home network", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                    }
                }
            }
        }
    }
}
