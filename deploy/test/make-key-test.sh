#!/bin/sh
# deploy/signing/make-key.sh, on the computer, in a temporary folder and with a file standing in for the login
# keyring: never the real keystore, never the real keyring. Checked: it makes a key and keeps its password where it
# is told; the pinned SHA-256 is the new certificate's; sign-apk.sh signs with what it made; it
# waits for the last four characters of the fingerprint, and takes no other answer; and a second run refuses and
# changes nothing. Run from the repo root: sh deploy/test/make-key-test.sh (make test runs it).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
{ [ -d "$ANDROID_HOME/build-tools" ] && [ -d "$ANDROID_HOME/platforms" ]; } || { echo "make-key-test: skipped, no Android SDK at $ANDROID_HOME"; exit 0; }
tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
t=$(mktemp -d)
trap 'rm -rf "${t:?}"' EXIT
trap 'exit 130' INT TERM HUP
fail() { echo "make-key-test: FAIL: $*" >&2; exit 1; }

dir=$t/signing
mkdir "$dir"
# The stand-in keyring: a file.
export KARTO_SIGNING_DIR="$dir" KARTO_KEYSTORE="$t/home/karto-android.p12"
export KARTO_PASS_CMD="cat $t/keyring" KARTO_PASS_HAS_CMD="test -s $t/keyring" KARTO_PASS_SET_CMD="cat > $t/keyring" KARTO_PASS_DEL_CMD="rm -f $t/keyring"

echo "make-key-test: interrupted before it is done, it takes back what it made"
# The stand-in keyring is slow to take the password: by then the key's file is made. The whole group is stopped, as
# Ctrl-C stops it (by TERM here: a shell's background jobs are started deaf to INT; the script's trap is for both).
KARTO_PASS_SET_CMD="sleep 30; cat > $t/keyring" setsid sh "$root/deploy/signing/make-key.sh" </dev/null >"$t/log0" 2>&1 &
pid=$!
n=0
until [ -e "$KARTO_KEYSTORE" ]; do
	n=$((n + 1))
	[ $n -lt 60 ] || { cat "$t/log0"; fail "the key's file was never made"; }
	sleep 1
done
/bin/kill -TERM -- "-$pid"
wait $pid && fail "an interrupted run ended as if all was well"
[ ! -e "$KARTO_KEYSTORE" ] || fail "an interrupted run left the key's file"
[ ! -e "$t/keyring" ] || fail "an interrupted run left the password in the keyring"
[ ! -e "$dir/signer.sha256" ] || fail "an interrupted run left the public files"
grep -q "took back what it had made" "$t/log0" || fail "an interrupted run didn't say it took things back: $(cat "$t/log0")"

echo "make-key-test: makes the key, and waits for the person's word"
mkfifo "$t/answers"
sh "$root/deploy/signing/make-key.sh" <"$t/answers" >"$t/log" 2>&1 &
pid=$!
exec 3>"$t/answers"
n=0
until grep -q "last four characters" "$t/log" 2>/dev/null; do
	n=$((n + 1))
	[ $n -lt 120 ] || { cat "$t/log"; fail "it never asked for the backup's word"; }
	kill -0 $pid 2>/dev/null || { cat "$t/log"; fail "it ended before asking"; }
	sleep 1
done
pin=$(cat "$dir/signer.sha256")
[ ${#pin} -eq 64 ] || fail "signer.sha256 does not hold a SHA-256: $pin"
echo "nope" >&3
sleep 1
kill -0 $pid 2>/dev/null || fail "it took a wrong answer as the person's word"
echo "$pin" | cut -c61-64 >&3
exec 3>&-
wait $pid || { cat "$t/log"; fail "it failed after the right answer"; }

pass=$(cat "$t/keyring")
echo "$pass" | grep -Eq '^[A-Za-z0-9]{32}$' || fail "the password is not 32 letters and digits"
grep -q "$pass" "$t/log" || fail "the password was not shown for the backup"
[ "$(grep -c "$pass" "$t/log")" -eq 1 ] || fail "the password was shown more than once"
[ "$(stat -c %a "$KARTO_KEYSTORE")" = 600 ] || fail "the keystore is not the person's alone"
[ "$(stat -c %a "$(dirname "$KARTO_KEYSTORE")")" = 700 ] || fail "the keystore's folder is not the person's alone"
[ "$(stat -c %a "$dir/signer.sha256")" = 644 ] || fail "the public file is not for all to read"
cert=$(keytool -list -v -keystore "$KARTO_KEYSTORE" -storepass "$pass" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p' | head -1 | tr -d ':' | tr 'A-F' 'a-f')
[ "$cert" = "$pin" ] || fail "signer.sha256 is not the new certificate's"
keytool -list -v -keystore "$KARTO_KEYSTORE" -storepass "$pass" 2>/dev/null | grep -q "Signature algorithm name: SHA256withECDSA" || fail "not an EC key signed with SHA-256"

echo "make-key-test: sign-apk.sh signs with what it made"
cat >"$t/AndroidManifest.xml" <<'EOF'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="t.signtest" android:versionCode="1">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/>
  <application android:hasCode="false"/>
</manifest>
EOF
platform=$(find "$ANDROID_HOME/platforms" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
"$tools/aapt2" link -o "$t/in.apk" --manifest "$t/AndroidManifest.xml" -I "$platform/android.jar"
sh "$root/deploy/signing/sign-apk.sh" "$t/in.apk" "$t/out.apk" >/dev/null || fail "sign-apk.sh could not sign with the new key"
[ -s "$t/out.apk" ] || fail "no signed APK"

echo "make-key-test: a second run refuses, and changes nothing"
before=$(sha256sum "$KARTO_KEYSTORE" "$dir/signer.sha256" "$t/keyring")
if sh "$root/deploy/signing/make-key.sh" </dev/null >"$t/log2" 2>&1; then fail "it made a second key"; fi
grep -q "already" "$t/log2" || fail "it didn't say why: $(cat "$t/log2")"
[ "$before" = "$(sha256sum "$KARTO_KEYSTORE" "$dir/signer.sha256" "$t/keyring")" ] || fail "the second run changed something"
echo PASS
