#!/bin/sh
# The channel-recovery check, on a real server: builds a release APK whose diagnostics
# screen logs in to the phone's paired server, as Update server does, and runs
# install.sh recovery-check there: phoenixd's database set aside, a Normal
# channel from ACINQ within 15 minutes with the same balance, else the
# database put back. Installs it on the phone over adb and prints the result
# from logcat. The app's data is kept; reinstall the normal
# build afterwards (make phone-install). Needs the Android SDK and one phone on adb, paired with a
# server that has a Normal channel and was updated by this version of the app
# (Update server uploads the install.sh with recovery-check). Run from the
# repo root: make phone-recovery-check
#
# RESULT=1 (make phone-recovery-check RESULT=1) builds one that only reads the
# last check's result (install.sh recovery-check result), waiting for one that
# still runs: for when the phone's session dropped, so that no second check
# stops cardd again.
#
# Afterwards, put the normal app back with `make phone-install` (never `npx
# expo run:android`: it would reuse this bundle and open the app).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
[ "$("$adb" devices | grep -c 'device$')" -eq 1 ] || { echo "connect exactly one phone (adb devices)" >&2; exit 2; }

if [ -n "${RESULT:-}" ]; then mode=result; else mode=1; fi
EXPO_PUBLIC_DIAG_RECOVERY=$mode sh "$root/deploy/test/release-apk.sh"
"$adb" logcat -c
"$adb" shell am force-stop tech.whitewolf.karto.dev
"$adb" shell monkey -p tech.whitewolf.karto.dev -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
if [ "$mode" = result ]; then
	echo "reading the last check's result, waiting for one that still runs (up to 20 minutes; keep the app open)..."
else
	echo "waiting for the server's check (up to 20 minutes; keep the app open)..."
fi
out=$(mktemp)
trap 'rm -f "$out"' EXIT
# 15 minutes for the channel, phoenixd's stops and starts, and the login.
sh "$root/deploy/test/diag-wait.sh" 1500 | tee "$out"
grep -q '"fail":0' "$out"
echo PASS
