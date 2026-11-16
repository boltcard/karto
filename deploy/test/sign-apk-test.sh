#!/bin/sh
# deploy/signing/sign-apk.sh, on the computer, with throwaway keys and never the real one: the script is given its
# keystore, its password and its folder of public files by the variables below. The APK is a manifest and nothing
# else, made with aapt2 (a file with no manifest can be signed but not verified), once for Android 7 (Karto PoS's
# floor) and once for Android 9 (the wallet's). Checked: the signed APK's one signer is the key, by schemes v2 and
# v3, not v1, aligned, with no lineage and no .idsig beside it; and that every failure leaves no output file at all
# (a failed apksigner leaves an empty one): no keystore, no password, a wrong password, a pinned signer that isn't
# the one that signed.
# Run from the repo root: sh deploy/test/sign-apk-test.sh (make test runs it).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
# A computer with no Android SDK builds for no phone and signs nothing: there is nothing of this to test there.
{ [ -d "$ANDROID_HOME/build-tools" ] && [ -d "$ANDROID_HOME/platforms" ]; } || { echo "sign-apk-test: skipped, no Android SDK at $ANDROID_HOME"; exit 0; }
tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
platform=$(find "$ANDROID_HOME/platforms" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
t=$(mktemp -d)
trap 'rm -rf "${t:?}"' EXIT
trap 'exit 130' INT TERM HUP
fail() { echo "sign-apk-test: FAIL: $*" >&2; exit 1; }
sha_of() { keytool -list -v -keystore "$1" -storepass "$2" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p' | head -1 | tr -d ':' | tr 'A-F' 'a-f'; }
new_key() { keytool -genkeypair -keystore "$1" -storetype PKCS12 -storepass "$2" -alias karto -keyalg EC -groupname secp256r1 -sigalg SHA256withECDSA -validity 10950 -dname "CN=$3" >/dev/null 2>&1; }
# A manifest-only APK for an Android floor: apk <file> <minSdk>.
apk() {
	cat >"$t/AndroidManifest.xml" <<EOF
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="t.signtest" android:versionCode="1">
  <uses-sdk android:minSdkVersion="$2" android:targetSdkVersion="36"/>
  <application android:hasCode="false"/>
</manifest>
EOF
	"$tools/aapt2" link -o "$1" --manifest "$t/AndroidManifest.xml" -I "$platform/android.jar"
}
apk "$t/in.apk" 24
apk "$t/in28.apk" 28

# The folder of public files, as deploy/signing/ is once make-key.sh has run: the pin.
dir=$t/signing
mkdir "$dir"
new_key "$t/new.p12" trypass1 "Karto test"
sha_of "$t/new.p12" trypass1 >"$dir/signer.sha256"

sign() { KARTO_SIGNING_DIR=$dir KARTO_KEYSTORE=${KS-$t/new.p12} KARTO_PASS_CMD=${PASS_CMD-"echo trypass1"} sh "$root/deploy/signing/sign-apk.sh" "${IN-$t/in.apk}" "$t/out.apk" >"$t/log" 2>&1; }
refused() { # refused <what>: the last sign must have failed and left nothing
	[ ! -e "$t/out.apk" ] || fail "$1: an output file was left"
	[ -z "$(find "$t" -maxdepth 1 -name '*.idsig' -o -maxdepth 1 -name 'out.apk.*')" ] || fail "$1: a file was left beside the output"
}

for floor in 24 28; do
	echo "sign-apk-test: signs with the key, for an app from Android $([ $floor = 24 ] && echo 7 || echo 9) up"
	if [ $floor = 24 ]; then IN=$t/in.apk sign; else IN=$t/in28.apk sign; fi || { cat "$t/log"; fail "signing failed"; }
	# As Android 7 reads it: apksigner leaves out of its report the schemes no Android from the APK's floor reads.
	"$tools/apksigner" verify -v --print-certs --min-sdk-version 24 "$t/out.apk" >"$t/verify"
	grep -q '^Verified using v2 scheme (APK Signature Scheme v2): true' "$t/verify" || fail "minSdk $floor: not verified by scheme v2"
	grep -q '^Verified using v3 scheme (APK Signature Scheme v3): true' "$t/verify" || fail "minSdk $floor: not verified by scheme v3"
	# No v1 (JAR) signature: read from the file, since apksigner reports v1 as false at API 24 even when it is there.
	if unzip -l "$t/out.apk" | grep -Eq 'META-INF/.*\.(SF|RSA|EC|DSA)$'; then fail "minSdk $floor: signed by v1 too"; fi
	[ "$(grep -c 'certificate SHA-256 digest' "$t/verify")" -eq 1 ] || fail "minSdk $floor: more than one signer"
	grep -q "^Signer #1 certificate SHA-256 digest: $(cat "$dir/signer.sha256")$" "$t/verify" || fail "minSdk $floor: the signer is not the key"
	"$tools/zipalign" -c 4 "$t/out.apk" || fail "minSdk $floor: not aligned"
	[ ! -e "$t/out.apk.idsig" ] || fail "minSdk $floor: an .idsig was written"
	# No lineage: no other key was ever this app's.
	if "$tools/apksigner" lineage --in "$t/out.apk" --print-certs >/dev/null 2>&1; then fail "minSdk $floor: the APK carries a lineage"; fi
	rm "$t/out.apk"
done

echo "sign-apk-test: a failure keeps no signed file from before, and the input is never the output"
cp "$t/in.apk" "$t/out.apk"
if KS=$t/none.p12 sign; then fail "signed with no keystore"; fi
refused "an earlier output"
if KARTO_SIGNING_DIR=$dir KARTO_KEYSTORE=$t/new.p12 KARTO_PASS_CMD="echo trypass1" sh "$root/deploy/signing/sign-apk.sh" "$t/in.apk" "$t/in.apk" >"$t/log" 2>&1; then fail "signed a file onto itself"; fi
[ -s "$t/in.apk" ] || fail "the input was lost"

echo "sign-apk-test: no keystore"
if KS=$t/none.p12 sign; then fail "signed with no keystore"; fi
refused "no keystore"
grep -q "no signing key at" "$t/log" || fail "no keystore: it didn't say so: $(cat "$t/log")"

echo "sign-apk-test: no password to be had"
if PASS_CMD=false sign; then fail "signed with no password"; fi
refused "no password"
grep -q "password" "$t/log" || fail "no password: it didn't say so"

echo "sign-apk-test: a wrong password"
if PASS_CMD="echo wrongpass" sign; then fail "signed with a wrong password"; fi
refused "a wrong password"
grep -qi "password" "$t/log" || fail "a wrong password: apksigner's own words were not passed on: $(cat "$t/log")"

echo "sign-apk-test: a signer that isn't the pinned one"
cp "$dir/signer.sha256" "$t/pin.kept"
echo 0000000000000000000000000000000000000000000000000000000000000000 >"$dir/signer.sha256"
if sign; then fail "took a signer that isn't the pinned one"; fi
refused "an unpinned signer"
cp "$t/pin.kept" "$dir/signer.sha256"

echo "sign-apk-test: and signs again once all is as it was"
sign || { cat "$t/log"; fail "signing failed at the end"; }
[ -s "$t/out.apk" ] || fail "no output at the end"
echo PASS
