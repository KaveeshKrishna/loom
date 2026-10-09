pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "loom-android"

// The engine is plain Kotlin and builds anywhere; the app needs the Android
// SDK. `gradle -PengineOnly :engine:test` works on machines without one.
include(":engine")
if (!providers.gradleProperty("engineOnly").isPresent) include(":app")
