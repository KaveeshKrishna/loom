# The engine's SQLite driver loads its native library by name.
-keep class androidx.sqlite.driver.bundled.** { *; }
# OkHttp's optional platform integrations.
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
