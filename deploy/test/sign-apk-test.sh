#!/bin/sh
# deploy/signing/sign-apk.sh, on the computer, with throwaway keys and never the real one: the script is given its
# keystore, its password and its folder of public files by the variables below. The APK is a manifest and nothing
# else, made with aapt2 (a file with no manifest can be signed but not verified). Checked: the signed APK's one
# signer is the new key, by scheme v3, aligned, with no .idsig beside it; and that every failure leaves no output
# file at all (a failed apksigner leaves an empty one): no keystore, no password, a wrong password, a lineage of
# another key, an old key that isn't the lineage's first, a pinned signer that isn't the one that signed.
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
lineage() { # lineage <out> <old keystore> <old alias> <old pass> <new keystore> <new pass>
	"$tools/apksigner" rotate --out "$1" \
		--old-signer --ks "$2" --ks-key-alias "$3" --ks-pass "pass:$4" --key-pass "pass:$4" --set-shared-uid false --set-auth false \
		--new-signer --ks "$5" --ks-key-alias karto --ks-pass "pass:$6" >/dev/null
}

# A manifest-only APK.
cat >"$t/AndroidManifest.xml" <<'EOF'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="t.signtest" android:versionCode="1">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/>
  <application android:hasCode="false"/>
</manifest>
EOF
"$tools/aapt2" link -o "$t/in.apk" --manifest "$t/AndroidManifest.xml" -I "$platform/android.jar"

# The folder of public files, as deploy/signing/ will be once make-key.sh has run: the old key, the lineage, the pin.
dir=$t/signing
mkdir "$dir"
cp "$root/deploy/signing/old.keystore" "$dir/old.keystore"
[ "$(sha_of "$dir/old.keystore" android)" = fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c ] || fail "deploy/signing/old.keystore is not the React Native template's debug key"
new_key "$t/new.p12" trypass1 "Karto test"
lineage "$dir/lineage.bin" "$dir/old.keystore" androiddebugkey android "$t/new.p12" trypass1
sha_of "$t/new.p12" trypass1 >"$dir/signer.sha256"

sign() { KARTO_SIGNING_DIR=$dir KARTO_KEYSTORE=${KS-$t/new.p12} KARTO_PASS_CMD=${PASS_CMD-"echo trypass1"} sh "$root/deploy/signing/sign-apk.sh" "$t/in.apk" "$t/out.apk" >"$t/log" 2>&1; }
refused() { # refused <what>: the last sign must have failed and left nothing
	[ ! -e "$t/out.apk" ] || fail "$1: an output file was left"
	[ -z "$(find "$t" -maxdepth 1 -name '*.idsig' -o -maxdepth 1 -name 'out.apk.*')" ] || fail "$1: a file was left beside the output"
}

echo "sign-apk-test: signs with the new key"
sign || { cat "$t/log"; fail "signing failed"; }
"$tools/apksigner" verify -v --print-certs "$t/out.apk" >"$t/verify"
grep -q '^Verified using v3 scheme (APK Signature Scheme v3): true' "$t/verify" || fail "not verified by scheme v3"
grep -q '^Verified using v1 scheme (JAR signing): false' "$t/verify" || fail "signed by v1 too"
[ "$(grep -c 'certificate SHA-256 digest' "$t/verify")" -eq 1 ] || fail "more than one signer"
grep -q "^Signer #1 certificate SHA-256 digest: $(cat "$dir/signer.sha256")$" "$t/verify" || fail "the signer is not the new key"
"$tools/zipalign" -c 4 "$t/out.apk" || fail "not aligned"
[ ! -e "$t/out.apk.idsig" ] || fail "an .idsig was written"
# The lineage travels in the APK: the old key first, then the new.
[ "$("$tools/apksigner" lineage --in "$t/out.apk" --print-certs | grep -c 'certificate SHA-256 digest')" -eq 2 ] || fail "the APK carries no lineage of two"
rm "$t/out.apk"

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

echo "sign-apk-test: a lineage of another key"
new_key "$t/other.p12" trypass1 "Somebody else"
cp "$dir/lineage.bin" "$t/lineage.kept"
lineage "$dir/lineage.bin" "$dir/old.keystore" androiddebugkey android "$t/other.p12" trypass1
if sign; then fail "signed with another key's lineage"; fi
refused "another key's lineage"
cp "$t/lineage.kept" "$dir/lineage.bin"

echo "sign-apk-test: an old key that isn't the lineage's first"
cp "$dir/old.keystore" "$t/old.kept"
keytool -genkeypair -keystore "$t/notold.jks" -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10 -dname "CN=Not the debug key" >/dev/null 2>&1
cp "$t/notold.jks" "$dir/old.keystore"
if sign; then fail "signed with an old key that isn't the lineage's"; fi
refused "a changed old key"
grep -q "old.keystore is not the first key of the lineage" "$t/log" || fail "a changed old key: it didn't say so: $(cat "$t/log")"
cp "$t/old.kept" "$dir/old.keystore"

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
