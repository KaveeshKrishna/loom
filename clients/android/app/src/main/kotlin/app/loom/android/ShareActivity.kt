package app.loom.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import app.loom.android.ui.DestinationPicker
import app.loom.android.ui.LoomMark
import app.loom.android.ui.LoomTheme
import app.loom.engine.OnConflict
import app.loom.engine.UploadRequest
import app.loom.engine.UploadSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Share › Loom from any app: choose a folder, then the files upload in the background. */
class ShareActivity : ComponentActivity() {
    private var preparing by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val app = LoomApp.of(this)
        val uris = shared(intent)
        setContent {
            LoomTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
                    val engine = app.startEngine()
                    when {
                        engine == null -> NotSignedIn()
                        uris.isEmpty() -> Message("There's nothing here Loom can upload.")
                        preparing != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator()
                                Spacer(Modifier.height(16.dp))
                                Text(preparing!!, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                        else -> Box(Modifier.safeDrawingPadding()) {
                            DestinationPicker(engine, app.config.lastFolder, Format.items(uris.size), onCancel = ::finish) { dest ->
                                upload(app, dest, uris)
                            }
                        }
                    }
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun shared(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra(Intent.EXTRA_STREAM),
        )
        Intent.ACTION_SEND_MULTIPLE ->
            (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()
        else -> emptyList()
    }

    /** The sharing app's permission ends with this screen, so the files are copied first. */
    private fun upload(app: LoomApp, dest: String, uris: List<Uri>) {
        preparing = "Preparing ${Format.items(uris.size)}…"
        lifecycleScope.launch {
            val copies = withContext(Dispatchers.IO) { app.files.copyIn(uris) { i -> preparing = "Preparing ${i + 1} of ${uris.size}…" } }
            val engine = app.engine.value
            if (copies.isEmpty() || engine == null) {
                Toast.makeText(this@ShareActivity, "Couldn't read the shared files", Toast.LENGTH_LONG).show()
                finish()
                return@launch
            }
            engine.upload(UploadRequest(dest, copies.map { UploadSource(it.path) }, OnConflict.Ask))
            KeepAlive.ensure(this@ShareActivity)
            Toast.makeText(this@ShareActivity, "Uploading ${Format.items(copies.size)} to ${dest.substringAfterLast('/').ifEmpty { "Loom" }}", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    @androidx.compose.runtime.Composable
    private fun NotSignedIn() {
        Box(Modifier.fillMaxSize().safeDrawingPadding().padding(32.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                LoomMark(48.dp)
                Text("Sign in to Loom first", style = MaterialTheme.typography.titleMedium)
                Text("Then share again to upload.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                Button(onClick = {
                    startActivity(Intent(this@ShareActivity, MainActivity::class.java))
                    finish()
                }) { Text("Open Loom") }
            }
        }
    }

    @androidx.compose.runtime.Composable
    private fun Message(text: String) {
        Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) { Text(text) }
    }
}
