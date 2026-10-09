#!/usr/bin/env bash
# Runs inside the emulator job (clients/android): the test Loom on the
# runner is reached as 10.0.2.2:18085 (the emulator's name for the host),
# then the screenshots are pulled out for review.
set -uo pipefail
status=0
gradle --no-daemon :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.loomTestUrl=http://10.0.2.2:18085 \
  -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true || status=$?
mkdir -p screens
adb pull /data/local/tmp/loom-screens/. screens/ || adb pull /sdcard/Android/data/app.loom.android/files/screens/. screens/ || true
adb logcat -d -s LoomPage:* chromium:* AndroidRuntime:E > screens/logcat.txt || true
ls -la screens || true
exit $status
