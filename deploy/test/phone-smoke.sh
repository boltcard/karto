#!/bin/sh
# Builds the release app, installs it on the phone connected over adb, clears
# its data, and walks the first screens (phone-smoke.py). Nothing reaches
# LNVPS. Needs the Android SDK and a phone with USB debugging on.
# Run from the repo root: make phone-smoke
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
[ "$("$adb" devices | grep -c 'device$')" -eq 1 ] || { echo "connect exactly one phone with USB debugging on (adb devices)" >&2; exit 2; }
# Checks the APK has no Play Services, too.
sh "$root/deploy/test/release-apk.sh"
"$adb" shell am force-stop tech.whitewolf.karto.dev
"$adb" shell pm clear tech.whitewolf.karto.dev >/dev/null
"$adb" shell monkey -p tech.whitewolf.karto.dev -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
python3 "$root/deploy/test/phone-smoke.py" "$adb"
