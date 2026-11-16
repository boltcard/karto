#!/bin/sh
# Makes the project's Android signing key, once (deploy/signing/README.md says how the apps are signed and why).
# RUN IT YOURSELF, IN A PLAIN TERMINAL WINDOW OF YOUR OWN, AND CLOSE THE WINDOW AFTERWARDS: it shows the key's
# password once, for your backup, and that is for your eyes alone.
#   sh deploy/signing/make-key.sh
# It makes an EC P-256 key in a PKCS #12 keystore outside the repository (~/.config/karto/signing/), keeps its
# password in the desktop's login keyring, and writes the public file every build needs into this folder:
# signer.sha256, the certificate's SHA-256. Commit it. It refuses to run where any of this already exists, and
# takes back what it made if it cannot finish.
#
# For the test (deploy/test/make-key-test.sh): KARTO_SIGNING_DIR, KARTO_KEYSTORE, and the keyring's four commands
# KARTO_PASS_CMD, KARTO_PASS_HAS_CMD, KARTO_PASS_SET_CMD, KARTO_PASS_DEL_CMD.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dir=${KARTO_SIGNING_DIR:-$here}
keystore=${KARTO_KEYSTORE:-$HOME/.config/karto/signing/karto-android.p12}
# The login keyring, unless the test gives its own four commands.
keyring() { # keyring get|has|set|del
	case $1 in
	get) custom=${KARTO_PASS_CMD:-} ;;
	has) custom=${KARTO_PASS_HAS_CMD:-} ;;
	set) custom=${KARTO_PASS_SET_CMD:-} ;;
	del) custom=${KARTO_PASS_DEL_CMD:-} ;;
	esac
	if [ -n "$custom" ]; then sh -c "$custom"; else /usr/bin/python3 "$here/keyring.py" "$1"; fi
}
# shellcheck source=/dev/null # checked on its own
. "$here/../test/android-env.sh"
tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
platform=$(find "$ANDROID_HOME/platforms" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
stop() { echo "make-key: $*" >&2; exit 1; }

[ -n "${KARTO_PASS_CMD:-}" ] || /usr/bin/python3 -c 'import secretstorage' 2>/dev/null || stop "the system's Python has no secretstorage, which reaches the login keyring: sudo apt install python3-secretstorage, then run this again. Nothing made."
[ ! -e "$keystore" ] || stop "there is already a signing key at $keystore: nothing made"
if keyring has 2>/dev/null; then stop "the login keyring already holds a signing password: nothing made"; fi
[ ! -e "$dir/signer.sha256" ] || stop "$dir/signer.sha256 is already there: the key was made before (restore it from your backup): nothing made"

made=
stored=
shown=
work=
undo() {
	[ -z "$work" ] || rm -rf "${work:?}"
	if [ -n "$shown" ]; then echo "make-key: the key is made and in place, but your word that it is backed up was not given. Make the backup before any phone takes this key." >&2; fi
	[ -n "$made" ] || return 0
	rm -f "$keystore" "$dir/signer.sha256"
	# Only a password this run put there is taken out again.
	[ -z "$stored" ] || keyring del 2>/dev/null || true
	echo "make-key: it could not finish, and took back what it had made" >&2
}
trap undo EXIT
# Ctrl-C too: sh runs the trap above only when the script itself exits.
trap 'exit 130' INT TERM HUP
work=$(mktemp -d)
made=1

umask 077
mkdir -p "$(dirname "$keystore")"
chmod 700 "$(dirname "$keystore")"
pass=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
KARTO_NEW_PASS=$pass keytool -genkeypair -keystore "$keystore" -storetype PKCS12 -storepass:env KARTO_NEW_PASS -alias karto \
	-keyalg EC -groupname secp256r1 -sigalg SHA256withECDSA -validity 10950 -dname "CN=Karto apps" >/dev/null 2>&1 || stop "keytool could not make the key"
chmod 600 "$keystore"
printf '%s\n' "$pass" | keyring set || stop "the password could not be put in the login keyring"
stored=1
[ "$(keyring get)" = "$pass" ] || stop "the login keyring did not give the password back"

pin=$(KARTO_NEW_PASS=$pass keytool -list -v -keystore "$keystore" -storepass:env KARTO_NEW_PASS 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p' | head -1 | tr -d ': ' | tr 'A-F' 'a-f')
[ ${#pin} -eq 64 ] || stop "the new certificate's SHA-256 could not be read"
echo "$pin" >"$dir/signer.sha256"
chmod 644 "$dir/signer.sha256"

# The whole chain, once, before anyone is told it is made: a manifest-only APK signed as every build will be.
cat >"$work/AndroidManifest.xml" <<'EOF'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="t.signcheck" android:versionCode="1">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/>
  <application android:hasCode="false"/>
</manifest>
EOF
"$tools/aapt2" link -o "$work/in.apk" --manifest "$work/AndroidManifest.xml" -I "$platform/android.jar"
KARTO_SIGNING_DIR=$dir KARTO_KEYSTORE=$keystore sh "$here/sign-apk.sh" "$work/in.apk" "$work/out.apk" >/dev/null || stop "sign-apk.sh could not sign with the new key"
made=
shown=1

last=$(echo "$pin" | cut -c61-64)
cat <<EOF

The signing key is made.

  Its file:         $keystore
  Its password:     $pass
  Its fingerprint:  $pin

Copy the file and this password to your own backup now. Without them the installed
apps can never be updated again. The password is also in this desktop's login keyring;
it is not shown again.

Then commit deploy/signing/signer.sha256.
EOF
while :; do
	printf '\nWhen your backup is made, type the last four characters of the fingerprint: '
	read -r answer || exit 1
	[ "$answer" = "$last" ] && break
	echo "That isn't it."
done
shown=
if [ -t 1 ]; then clear; fi
echo "Done. The key's fingerprint ends in $last."
