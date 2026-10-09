plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(libs.coroutines.core)
    api(libs.okhttp)
    api(libs.serialization.json)
    implementation(libs.sqlite.bundled)
    testImplementation(libs.junit)
    api(libs.okhttp.tls)
}

tasks.test {
    // The live tests need a Loom to talk to: tests/stack/stack.sh up
    val server = System.getenv("LOOM_TEST_URL") ?: ""
    inputs.property("loomTestUrl", server)
    if (server.isNotEmpty()) {
        // Against a live server the result depends on it: never reuse an earlier run.
        outputs.upToDateWhen { false }
        outputs.cacheIf { false }
    }
    environment("LOOM_TEST_URL", server)
    environment("LOOM_TEST_DIR", System.getenv("LOOM_TEST_DIR") ?: "")
    testLogging {
        events("passed", "failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStandardStreams = false
    }
    maxParallelForks = 1
}
