#!/bin/sh
# Builds a release APK whose diagnostics screen runs the backup probe:
# a database of about 4 MB, encrypted with age, decrypted by the app's own age
# code and opened from memory with expo-sqlite, each step timed. Installs it on
# the phone over adb and prints the results from logcat. The app's data is
# kept; reinstall the normal build afterwards. Needs the Android SDK and one
# phone on adb. Run from the repo root: make phone-backup-probe
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
[ "$("$adb" devices | grep -c 'device$')" -eq 1 ] || { echo "connect exactly one phone (adb devices)" >&2; exit 2; }

EXPO_PUBLIC_DIAG_BACKUP=1 sh "$root/deploy/test/release-apk.sh"
"$adb" logcat -c
"$adb" shell am force-stop tech.whitewolf.karto.dev
"$adb" shell monkey -p tech.whitewolf.karto.dev -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
echo "waiting for the phone's results..."
out=$(mktemp)
trap 'rm -f "$out"' EXIT
sh "$root/deploy/test/diag-wait.sh" 180 | tee "$out"
grep -q '"fail":0' "$out"
echo PASS
