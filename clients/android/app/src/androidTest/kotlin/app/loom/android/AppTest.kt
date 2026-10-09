package app.loom.android

import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import app.loom.engine.OnConflict
import app.loom.engine.UploadRequest
import app.loom.engine.UploadSource
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import kotlin.random.Random

/*
 * The app on a real (emulated) phone or tablet against the test Loom
 * (tests/stack, reached through `adb reverse`): sign in with a pairing code,
 * see Loom, upload a file, and screenshots of every screen in light and
 * dark for review. CI passes -Pandroid.testInstrumentationRunnerArguments.loomTestUrl=…
 */
@RunWith(AndroidJUnit4::class)
class AppTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    private val instr = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instr)
    private val app get() = instr.targetContext.applicationContext as LoomApp
    private val base = InstrumentationRegistry.getArguments().getString("loomTestUrl").orEmpty()
    private val http = OkHttpClient()
    private val json = "application/json".toMediaType()
    private val kind = if (instr.targetContext.resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "phone"

    private fun shot(name: String) {
        Thread.sleep(1200)
        instr.waitForIdleSync()
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot() ?: return
        val dir = File(instr.targetContext.getExternalFilesDir(null), "screens").apply { mkdirs() }
        val file = File(dir, "api${Build.VERSION.SDK_INT}-$kind-$name.png")
        FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        // Somewhere the test run's uninstall doesn't delete, for CI to collect.
        device.executeShellCommand("mkdir -p /data/local/tmp/loom-screens")
        device.executeShellCommand("cp ${file.path} /data/local/tmp/loom-screens/")
    }

    private fun post(path: String, body: String, headers: Map<String, String> = emptyMap()) =
        http.newCall(Request.Builder().url("$base$path").post(body.toRequestBody(json)).apply { headers.forEach { (k, v) -> header(k, v) } }.build()).execute()

    /** Signed in as the test stack's Owner (set up on first use). */
    private fun ownerCookie(): String {
        val setup = http.newCall(Request.Builder().url("$base/api/setup").build()).execute().use { Json.parseToJsonElement(it.body!!.string()).jsonObject }
        if (setup["needsSetup"]?.jsonPrimitive?.contentOrNull == "true") {
            post("/api/setup", """{"name":"Alex","email":"owner@loom.test","password":"owner-password-123"}""").close()
        }
        post("/api/auth/sign-in/email", """{"email":"owner@loom.test","password":"owner-password-123"}""", mapOf("origin" to base)).use { res ->
            assertTrue("sign-in ${res.code}", res.isSuccessful)
            return res.headers("set-cookie").joinToString("; ") { it.substringBefore(';') }
        }
    }

    private fun open(action: String) {
        rule.activityRule.scenario.onActivity { it.startActivity(Intent(it, MainActivity::class.java).setAction(action)) }
        Thread.sleep(800)
    }

    private fun waitFor(what: String, ms: Long, f: () -> Boolean) {
        val until = System.currentTimeMillis() + ms
        while (!f()) {
            if (System.currentTimeMillis() > until) throw AssertionError("timed out waiting for $what")
            Thread.sleep(250)
        }
    }

    @Test
    fun signInUploadAndEveryScreen() {
        assumeTrue("no test Loom given", base.isNotEmpty())
        if (Build.VERSION.SDK_INT >= 33) instr.uiAutomation.grantRuntimePermission(instr.targetContext.packageName, Manifest.permission.POST_NOTIFICATIONS)
        device.executeShellCommand("cmd uimode night no")
        val cookie = ownerCookie()
        val folder = "Android test %04x".format(Random.nextInt(0xffff))
        post("/api/fs/mkdir", """{"parentPath":"","name":"$folder"}""", mapOf("cookie" to cookie)).close()
        post("/api/fs/mkdir", """{"parentPath":"$folder","name":"Holiday photos"}""", mapOf("cookie" to cookie)).close()

        shot("1-welcome")
        rule.onNodeWithTag("address").performTextInput(base)
        rule.onNodeWithText("Continue").performClick()
        rule.waitUntil(20_000) { rule.onAllNodesWithText("Use a pairing code").fetchSemanticsNodes().isNotEmpty() }
        shot("2-sign-in")
        rule.onNodeWithText("Use a pairing code").performClick()
        val code = post("/api/devices/codes", "{}", mapOf("cookie" to cookie)).use { Json.parseToJsonElement(it.body!!.string()).jsonObject["code"]!!.jsonPrimitive.content }
        rule.onNodeWithTag("code").performTextInput(code)
        shot("3-code")
        rule.onNodeWithText("Sign in").performClick()
        waitFor("signing in", 30_000) { app.config.signedIn && app.engine.value != null }

        // Loom's own page, signed in through the device token.
        Thread.sleep(9000)
        shot("4-loom")

        // An upload through the app's engine, checked on the server.
        val f = File(instr.targetContext.cacheDir, "hello from android.txt").apply { writeText("Hello from the Loom app") }
        val engine = app.engine.value!!
        engine.upload(UploadRequest("$folder/Holiday photos", listOf(UploadSource(f.path)), OnConflict.KeepBoth))
        waitFor("the upload", 60_000) {
            http.newCall(Request.Builder().url("$base/api/files?path=" + java.net.URLEncoder.encode("$folder/Holiday photos", "UTF-8")).header("cookie", cookie).build()).execute().use { res ->
                Json.parseToJsonElement(res.body!!.string()).jsonObject["children"]!!.jsonArray.any { it.jsonObject["name"]?.jsonPrimitive?.contentOrNull == "hello from android.txt" }
            }
        }

        open(MainActivity.ACTION_TRANSFERS)
        shot("5-transfers")
        open(MainActivity.ACTION_SETTINGS)
        shot("6-settings")

        device.executeShellCommand("cmd uimode night yes")
        Thread.sleep(1500)
        shot("7-settings-dark")
        open(MainActivity.ACTION_TRANSFERS)
        shot("8-transfers-dark")
        device.pressBack()
        Thread.sleep(2500)
        shot("9-loom-dark")
        device.executeShellCommand("cmd uimode night no")
    }
}
