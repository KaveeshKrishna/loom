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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.loom.engine.Engine
import app.loom.engine.LoomException
import app.loom.engine.Node

/**
 * "Upload to which folder?" for Share › Loom and the Upload shortcut: browse
 * Loom's folders, then upload into the one on screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DestinationPicker(engine: Engine, start: String, what: String, onCancel: () -> Unit, onPick: (String) -> Unit) {
    var path by rememberSaveable { mutableStateOf(start) }
    var folders by remember { mutableStateOf<List<Node>?>(null) }
    var canWrite by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(path) {
        folders = null
        problem = null
        try {
            val l = engine.api.list(path)
            folders = l.children.filter { it.isDir }.sortedBy { it.name.lowercase() }
            canWrite = l.canWrite
        } catch (e: LoomException.SignedOut) {
            problem = "This device was signed out of Loom."
        } catch (e: Exception) {
            if (path.isNotEmpty() && e is LoomException.Permanent) path = "" else problem = "Can't reach Loom right now."
            folders = emptyList()
        }
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Upload $what") },
            navigationIcon = {
                IconButton(onClick = { if (path.isEmpty()) onCancel() else path = path.substringBeforeLast('/', "") }) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back")
                }
            },
            actions = { TextButton(onClick = onCancel) { Text("Cancel") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
        )
        // Where we are: Loom › Photos › 2026
        val crumbs = listOf("" to "Loom") + path.split('/').filter { it.isNotEmpty() }.runningReduce { a, b -> "$a/$b" }.map { it to it.substringAfterLast('/') }
        LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            items(crumbs) { (p, name) ->
                TextButton(onClick = { path = p }) { Text(name, maxLines = 1) }
                if (p != path) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        HorizontalDivider()
        Box(Modifier.weight(1f)) {
            val list = folders
            when {
                problem != null -> Text(problem!!, Modifier.align(Alignment.Center).padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                list == null -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                list.isEmpty() -> Text("No folders in here", Modifier.align(Alignment.Center), color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 4.dp)) {
                    items(list, key = { it.relativePath }) { f ->
                        Row(
                            Modifier.fillMaxWidth().clickable { path = f.relativePath }.padding(horizontal = 20.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.Folder, null, tint = MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(16.dp))
                            Text(f.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!canWrite && folders != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Lock, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(8.dp))
                        Text("You can't add files here. Open a folder you can change.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Button(onClick = { onPick(path) }, enabled = canWrite, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                    Text("Upload to ${crumbs.last().second}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
