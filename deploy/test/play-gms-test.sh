#!/bin/sh
# deploy/test/play-gms.sh on manifest-only APKs made with aapt2, each with a classes.dex that is only the class
# names the check counts: it passes the one manifest entry the Play build may have, <queries><package
# android:name="com.google.android.gms"/>, and fails a longer package, the same name elsewhere, and a second entry.
# Run from the repo root: sh deploy/test/play-gms-test.sh (make test runs it).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
{ [ -d "$ANDROID_HOME/build-tools" ] && [ -d "$ANDROID_HOME/platforms" ]; } || { echo "play-gms-test: skipped, no Android SDK at $ANDROID_HOME"; exit 0; }
tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
platform=$(find "$ANDROID_HOME/platforms" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
t=$(mktemp -d)
trap 'rm -rf "${t:?}"' EXIT
trap 'exit 130' INT TERM HUP
fail() { echo "play-gms-test: FAIL: $*" >&2; exit 1; }
printf 'Lexpo/modules/Kernel;\nLorg/unifiedpush/android/embedded_fcm_distributor/Module;\n' >"$t/classes.dex"

# check <name> <want exit> <manifest's children>: an APK with that manifest, checked.
check() {
	cat >"$t/AndroidManifest.xml" <<EOF
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="t.playgms" android:versionCode="1">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/>
  $3
</manifest>
EOF
	rm -f "$t/app.apk"
	"$tools/aapt2" link -o "$t/app.apk" --manifest "$t/AndroidManifest.xml" -I "$platform/android.jar"
	(cd "$t" && zip -q app.apk classes.dex)
	set +e
	sh "$root/deploy/test/play-gms.sh" "$t/app.apk" >"$t/log" 2>&1
	code=$?
	set -e
	[ "$code" -eq "$2" ] || { cat "$t/log"; fail "$1: exited $code, want $2"; }
	echo "play-gms-test: $1: exit $code"
}

QUERY='<queries><package android:name="com.google.android.gms"/></queries>'
check "the distributor's one query" 0 "$QUERY<application android:hasCode=\"false\"/>"
check "a longer package" 1 '<queries><package android:name="com.google.android.gms.auth"/></queries><application android:hasCode="false"/>'
check "the same name, not in <queries>" 1 '<application android:hasCode="false"><meta-data android:name="x" android:value="com.google.android.gms"/></application>'
check "a second entry" 1 "$QUERY<application android:hasCode=\"false\"><service android:name=\"com.google.firebase.X\"/></application>"
check "no entry" 1 '<application android:hasCode="false"/>'
echo "play-gms-test: PASS"
