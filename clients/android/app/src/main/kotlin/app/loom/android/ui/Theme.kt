package app.loom.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

val LoomBlue = Color(0xFF1A5FF0)

private val Light = lightColorScheme(
    primary = LoomBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE6FF),
    onPrimaryContainer = Color(0xFF00205F),
    secondary = Color(0xFF555F71),
    secondaryContainer = Color(0xFFE6EAF3),
    onSecondaryContainer = Color(0xFF1F2633),
    background = Color(0xFFFFFFFF),
    surface = Color(0xFFFFFFFF),
    surfaceVariant = Color(0xFFF2F3F7),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF7F8FB),
    surfaceContainer = Color(0xFFF2F3F7),
    surfaceContainerHigh = Color(0xFFECEEF3),
    onSurfaceVariant = Color(0xFF5B6170),
    outline = Color(0xFFC6CAD3),
    outlineVariant = Color(0xFFE3E5EA),
    error = Color(0xFFC62828),
)

private val Dark = darkColorScheme(
    primary = Color(0xFF8DB1FF),
    onPrimary = Color(0xFF002E85),
    primaryContainer = Color(0xFF1D3F87),
    onPrimaryContainer = Color(0xFFDCE6FF),
    secondary = Color(0xFFBCC6DA),
    secondaryContainer = Color(0xFF2B313D),
    onSecondaryContainer = Color(0xFFDDE3F0),
    background = Color(0xFF111318),
    surface = Color(0xFF111318),
    surfaceVariant = Color(0xFF1C1F26),
    surfaceContainerLowest = Color(0xFF0C0E12),
    surfaceContainerLow = Color(0xFF171A20),
    surfaceContainer = Color(0xFF1C1F26),
    surfaceContainerHigh = Color(0xFF242832),
    onSurfaceVariant = Color(0xFFA9AFBC),
    outline = Color(0xFF4A505C),
    outlineVariant = Color(0xFF2C3039),
    error = Color(0xFFFF8A80),
)

/** Sizes and speeds line up when they change. */
val Tabular = TextStyle(fontFeatureSettings = "tnum")

@Composable
fun LoomTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, typography = Typography(), content = content)
}

/** Loom's mark (brand/mark.py): warp and weft woven over and under. */
@Composable
fun LoomMark(size: Dp = 48.dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val s = this.size.width / 1024f
        drawRoundRect(LoomBlue, cornerRadius = CornerRadius(230 * s))
        val pieces = listOf(
            floatArrayOf(374f, 214f, 276f, 136f, 0f), floatArrayOf(214f, 444f, 206f, 136f, 0f), floatArrayOf(604f, 444f, 206f, 136f, 0f),
            floatArrayOf(374f, 674f, 276f, 136f, 0f), floatArrayOf(214f, 214f, 136f, 206f, 1f), floatArrayOf(214f, 604f, 136f, 206f, 1f),
            floatArrayOf(444f, 374f, 136f, 276f, 1f), floatArrayOf(674f, 214f, 136f, 206f, 1f), floatArrayOf(674f, 604f, 136f, 206f, 1f),
        )
        for (p in pieces) {
            drawRoundRect(
                if (p[4] == 1f) Color(0xFFB5CBFF) else Color.White,
                topLeft = Offset(p[0] * s, p[1] * s),
                size = Size(p[2] * s, p[3] * s),
                cornerRadius = CornerRadius(12 * s),
            )
        }
    }
}
