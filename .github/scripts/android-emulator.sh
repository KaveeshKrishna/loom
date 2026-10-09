#!/usr/bin/env bash
# Runs inside the emulator job (clients/android): the test Loom on the
# runner is reached as localhost:18085 through adb reverse, then the
# screenshots are pulled out for review.
set -uo pipefail
adb reverse tcp:18085 tcp:18085
status=0
gradle --no-daemon :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.loomTestUrl=http://localhost:18085 \
  -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true || status=$?
mkdir -p screens
adb pull /data/local/tmp/loom-screens/. screens/ || adb pull /sdcard/Android/data/app.loom.android/files/screens/. screens/ || true
ls -la screens || true
exit $status
