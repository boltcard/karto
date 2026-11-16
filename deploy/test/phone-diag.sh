#!/bin/sh
# Builds a release APK with the diagnostics screen, installs it on the phone
# connected over adb, points it at a throwaway OpenSSH server on this machine
# (through `adb reverse`, so no network setup), and reports the phone's
# results from logcat. Needs Docker, the Android SDK and a phone with USB
# debugging on. Run from the repo root: make phone-diag
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
name=cardapp-sshd-phone
[ "$("$adb" devices | grep -c 'device$')" -eq 1 ] || { echo "connect exactly one phone with USB debugging on (adb devices)" >&2; exit 2; }

pub=$(sed -n 's/.*"sshAuthorizedKey": "\([^"]*\)".*/\1/p' "$root/testvectors/vectors.json")
seed=$(sed -n 's/.*"sshEd25519Seed": "\([^"]*\)".*/\1/p' "$root/testvectors/vectors.json")
docker rm -f "$name" >/dev/null 2>&1 || true
out=$(mktemp)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; "$adb" reverse --remove tcp:12222 >/dev/null 2>&1 || true; rm -f "$out"' EXIT
docker run -d --name "$name" -p 127.0.0.1:12222:2222 -e PUBLIC_KEY="$pub" -e USER_NAME=debian \
	lscr.io/linuxserver/openssh-server:latest >/dev/null
for _ in $(seq 1 30); do
	docker exec "$name" test -s /config/ssh_host_keys/ssh_host_ed25519_key.pub 2>/dev/null && break
	sleep 1
done
sleep 2
blob=$(docker exec "$name" cut -d' ' -f2 /config/ssh_host_keys/ssh_host_ed25519_key.pub)
"$adb" reverse tcp:12222 tcp:12222 >/dev/null

EXPO_PUBLIC_DIAG_SSH="127.0.0.1:12222:debian:$blob:$seed" sh "$root/deploy/test/release-apk.sh"
"$adb" logcat -c
"$adb" shell am force-stop tech.whitewolf.karto.dev
"$adb" shell monkey -p tech.whitewolf.karto.dev -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
echo "waiting for the phone's results..."
sh "$root/deploy/test/diag-wait.sh" 180 | tee "$out"
grep -q '"fail":0' "$out"
echo PASS
