#!/bin/sh
# Builds Karto PoS's release app, installs it on the phone connected over adb,
# clears ITS data (never Karto Wallet's), and walks its first screens
# (pos-smoke.py). Nothing reaches a server. Clearing the data unpairs the
# phone and deletes its key: not for a phone that is somebody's till. Needs
# the Android SDK and a phone with USB debugging on.
# Run from the repo root: make pos-smoke
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
[ "$("$adb" devices | grep -c 'device$')" -eq 1 ] || { echo "connect exactly one phone with USB debugging on (adb devices)" >&2; exit 2; }
# Checks the APK has no Play Services and holds Karto PoS's code alone, too.
APP_VARIANT=pos sh "$root/deploy/test/release-apk.sh"
"$adb" shell am force-stop tech.whitewolf.kartopos.dev
"$adb" shell pm clear tech.whitewolf.kartopos.dev >/dev/null
"$adb" shell monkey -p tech.whitewolf.kartopos.dev -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
python3 "$root/deploy/test/pos-smoke.py" "$adb"
