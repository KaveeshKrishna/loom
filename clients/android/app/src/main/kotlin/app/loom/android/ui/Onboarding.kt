package app.loom.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.loom.android.Pairing
import kotlinx.coroutines.launch

/**
 * Signing in: the Loom address first, then either approving this phone in
 * Loom (the usual way) or a one-time code from Loom's Devices page.
 */
@Composable
fun Onboarding(
    initialServer: String?,
    initialCode: String?,
    onApprove: (server: String) -> Unit,
    onRedeem: suspend (server: String, code: String) -> String?,
    onScan: () -> Unit,
) {
    var server by rememberSaveable { mutableStateOf(initialServer) }
    var address by rememberSaveable { mutableStateOf(initialServer?.removePrefix("https://") ?: "") }
    var checking by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var useCode by rememberSaveable { mutableStateOf(initialCode != null) }
    var code by rememberSaveable { mutableStateOf(initialCode ?: "") }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    fun check() {
        if (checking) return
        focus.clearFocus()
        checking = true
        problem = null
        scope.launch {
            when (val r = Pairing.check(address)) {
                is Pairing.Check.Ok -> server = r.url
                is Pairing.Check.Problem -> problem = r.message
            }
            checking = false
        }
    }

    fun redeem() {
        val s = server ?: return
        if (checking) return
        focus.clearFocus()
        checking = true
        problem = null
        scope.launch {
            problem = onRedeem(s, code)
            checking = false
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Box(Modifier.fillMaxSize().safeDrawingPadding().imePadding(), contentAlignment = Alignment.Center) {
            Column(
                Modifier.widthIn(max = 440.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                LoomMark(56.dp)
                Spacer(Modifier.height(20.dp))
                Text(
                    if (server == null) "Welcome to Loom" else "Sign in to Loom",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    if (server == null) "Enter the address you use to open Loom in a browser." else server!!.removePrefix("https://"),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(28.dp))

                if (server == null) {
                    OutlinedTextField(
                        value = address,
                        onValueChange = { address = it; problem = null },
                        label = { Text("Loom address") },
                        placeholder = { Text("loom.example.com") },
                        singleLine = true,
                        isError = problem != null,
                        supportingText = problem?.let { { Text(it) } },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                        keyboardActions = KeyboardActions(onGo = { check() }),
                        modifier = Modifier.fillMaxWidth().testTag("address"),
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = ::check, enabled = address.isNotBlank() && !checking, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                        if (checking) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Continue")
                    }
                    Spacer(Modifier.height(24.dp))
                    HorizontalDivider()
                    Spacer(Modifier.height(16.dp))
                    OutlinedButton(onClick = onScan, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                        Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(18.dp))
                        Spacer(Modifier.size(8.dp))
                        Text("Scan a pairing code")
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "In Loom, open Devices and choose Show pairing code.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                } else if (!useCode) {
                    Button(onClick = { onApprove(server!!) }, modifier = Modifier.fillMaxWidth().height(48.dp).testTag("approve")) {
                        Text("Sign in")
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "You'll sign in to Loom and allow this device.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(20.dp))
                    OutlinedButton(onClick = { useCode = true }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Use a pairing code") }
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = { server = null; problem = null }) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, null, Modifier.size(16.dp))
                        Spacer(Modifier.size(6.dp))
                        Text("Change address")
                    }
                } else {
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it.uppercase().take(14); problem = null },
                        label = { Text("Pairing code") },
                        placeholder = { Text("XXXX-XXXX-XXXX") },
                        singleLine = true,
                        isError = problem != null,
                        supportingText = { Text(problem ?: "From Devices › Show pairing code in Loom") },
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done, autoCorrectEnabled = false),
                        keyboardActions = KeyboardActions(onDone = { redeem() }),
                        modifier = Modifier.fillMaxWidth().testTag("code"),
                        textStyle = Tabular.merge(MaterialTheme.typography.bodyLarge),
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = ::redeem, enabled = code.count { it.isLetterOrDigit() } >= 12 && !checking, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                        if (checking) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Sign in")
                    }
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = onScan) { Text("Scan instead") }
                        TextButton(onClick = { useCode = false; problem = null }) { Text("Sign in another way") }
                    }
                }
            }
        }
    }
}

/** Shown above Loom's approval page while it waits for "Allow". */
@Composable
fun ApprovalBanner(checkCode: String, onCancel: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Check that Loom shows this code", style = MaterialTheme.typography.labelMedium)
                Text(checkCode, style = Tabular.merge(MaterialTheme.typography.titleLarge), fontWeight = FontWeight.SemiBold)
            }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}
