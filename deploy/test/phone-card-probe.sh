#!/bin/sh
# Builds a release APK whose diagnostics screen probes a real NTAG 424 DNA card
# read-only, installs it on the phone over adb, and prints the
# results from logcat. Hold a blank card to the phone when the script says so.
# The app's data is kept; reinstall the normal build afterwards. Needs the
# Android SDK and one phone on adb. Run from the repo root: make phone-card-probe
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
[ "$("$adb" devices | grep -c 'device$')" -eq 1 ] || { echo "connect exactly one phone (adb devices)" >&2; exit 2; }

EXPO_PUBLIC_DIAG_CARD=1 sh "$root/deploy/test/release-apk.sh"
"$adb" logcat -c
"$adb" shell am force-stop app.cardapp
"$adb" shell monkey -p app.cardapp -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
echo "hold a blank NTAG 424 DNA card to the back of the phone (5 minutes)..."
# The results go to stdout and a temporary file (tee /dev/stderr would reopen,
# and so truncate, a log file stderr is redirected to).
out=$(mktemp)
trap 'rm -f "$out"' EXIT
sh "$root/deploy/test/diag-wait.sh" 300 | tee "$out"
grep -q '"fail":0' "$out"
echo PASS
