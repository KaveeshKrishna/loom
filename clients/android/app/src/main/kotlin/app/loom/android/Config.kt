package app.loom.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.loom.engine.Settings
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** How the app updates itself. */
enum class UpdateMode(val wire: String) {
    /** Download in the background, then ask before installing (the default). */
    Ask("ask"),

    /** Install by itself when nothing is being transferred. */
    Auto("auto"),

    /** Only say that a new version is out. */
    Notify("notify");

    companion object {
        fun parse(s: String?) = entries.firstOrNull { it.wire == s } ?: Ask
    }
}

/**
 * The app's settings and its sign-in. The device token is encrypted with a
 * key that lives in Android's keystore (never leaves the phone, isn't backed up).
 */
class Config(context: Context) {
    private val prefs = context.getSharedPreferences("loom", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString("server", null)
        set(v) = prefs.edit().putString("server", v).apply()

    var deviceName: String
        get() = prefs.getString("deviceName", null) ?: defaultDeviceName()
        set(v) = prefs.edit().putString("deviceName", v).apply()

    var userName: String?
        get() = prefs.getString("userName", null)
        set(v) = prefs.edit().putString("userName", v).apply()

    var userEmail: String?
        get() = prefs.getString("userEmail", null)
        set(v) = prefs.edit().putString("userEmail", v).apply()

    var token: String?
        get() = prefs.getString("token", null)?.let { Secrets.decrypt(it) }
        set(v) = prefs.edit().putString("token", v?.let { Secrets.encrypt(it) }).apply()

    val signedIn get() = serverUrl != null && token != null

    /** The folder last shown in Loom (Share and the Upload shortcut start there). */
    var lastFolder: String
        get() = prefs.getString("lastFolder", "") ?: ""
        set(v) = prefs.edit().putString("lastFolder", v).apply()

    var settings: Settings
        get() = Settings(
            parallelFiles = prefs.getInt("parallelFiles", 3),
            parallelChunks = 2,
            speedLimit = prefs.getLong("speedLimit", 0),
            useLan = prefs.getBoolean("useLan", true),
            wifiOnly = prefs.getBoolean("wifiOnly", false),
        )
        set(s) = prefs.edit()
            .putInt("parallelFiles", s.parallelFiles)
            .putLong("speedLimit", s.speedLimit)
            .putBoolean("useLan", s.useLan)
            .putBoolean("wifiOnly", s.wifiOnly)
            .apply()

    var updateMode: UpdateMode
        get() = UpdateMode.parse(prefs.getString("updateMode", null))
        set(v) = prefs.edit().putString("updateMode", v.wire).apply()

    var lastUpdateCheck: Long
        get() = prefs.getLong("lastUpdateCheck", 0)
        set(v) = prefs.edit().putLong("lastUpdateCheck", v).apply()

    /** The version that was running last time (to say "Loom was updated"). */
    var lastVersion: Int
        get() = prefs.getInt("lastVersion", 0)
        set(v) = prefs.edit().putInt("lastVersion", v).apply()

    var batteryAsked: Boolean
        get() = prefs.getBoolean("batteryAsked", false)
        set(v) = prefs.edit().putBoolean("batteryAsked", v).apply()

    fun signOut() {
        prefs.edit().remove("token").remove("userName").remove("userEmail").remove("lastFolder").apply()
    }

    companion object {
        fun defaultDeviceName(): String {
            val maker = android.os.Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
            val model = android.os.Build.MODEL
            return if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model"
        }
    }
}

private object Secrets {
    private const val ALIAS = "loom-device-token"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(plain.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    fun decrypt(stored: String): String? = runCatching {
        val raw = Base64.decode(stored, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
        String(c.doFinal(raw, 12, raw.size - 12))
    }.getOrNull()
}
