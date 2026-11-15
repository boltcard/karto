#!/bin/sh
# Signs a release APK with the project's own key (deploy/signing/README.md).
#   sh deploy/signing/sign-apk.sh <in.apk> <out.apk>
# Gradle signs the release APK with the React Native template's debug key, which everyone has. This signs it again:
# by the debug key for the older signature scheme, as the phones' apps were signed before, and by the project's key
# for every Android that knows key rotation (9 up), with the lineage that says the one follows the other. Such an
# APK installs over an app signed with the debug key alone, and after it an APK without the project's key doesn't.
#
# The key is a PKCS #12 keystore outside the repository and its password is in the desktop's login keyring; this
# folder holds what is public: the old key (old.keystore), the lineage (lineage.bin) and the new certificate's
# SHA-256 (signer.sha256). With any of them missing, wrong or locked the script stops and leaves no output file:
# it never signs with the old key alone.
#
# For the test (deploy/test/sign-apk-test.sh), which uses throwaway keys: KARTO_SIGNING_DIR (this folder),
# KARTO_KEYSTORE (the keystore), KARTO_PASS_CMD (a command that prints the password).
set -eu
[ $# -eq 2 ] || { echo "usage: sign-apk.sh <in.apk> <out.apk>" >&2; exit 2; }
in=$1
out=$2
here=$(cd "$(dirname "$0")" && pwd)
dir=${KARTO_SIGNING_DIR:-$here}
keystore=${KARTO_KEYSTORE:-$HOME/.config/karto/signing/karto-android.p12}
# shellcheck source=/dev/null # checked on its own
. "$here/../test/android-env.sh"
tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
stop() { echo "sign-apk: $*" >&2; exit 1; }
hex() { tr -d ': \t\r' | tr 'A-F' 'a-f'; }
# The password, from the login keyring unless the test gives another way. The keyring's own reason, if it has one,
# is passed on (it never holds the password).
password() {
	if [ -n "${KARTO_PASS_CMD:-}" ]; then sh -c "$KARTO_PASS_CMD"; else /usr/bin/python3 "$here/keyring.py" get; fi
}

[ "$in" != "$out" ] || stop "the output must be another file than the input"
# Whatever comes of this run, no signed file from an earlier one is left to be taken for its work.
rm -f "$out" "$out.idsig"
trap 'exit 130' INT TERM HUP
[ -f "$in" ] || stop "no APK at $in"
[ -x "$tools/apksigner" ] || stop "no apksigner under $ANDROID_HOME/build-tools"
for f in old.keystore lineage.bin signer.sha256; do
	[ -f "$dir/$f" ] || stop "$dir/$f is missing: deploy/signing/make-key.sh makes lineage.bin and signer.sha256, once, and they are committed"
done
[ -f "$keystore" ] || stop "no signing key at $keystore: it is made once by deploy/signing/make-key.sh, on the one computer that builds for a phone, and restored there from its backup"
said=$out.signing.$$.said
pass=$(password 2>"$said") || pass=
why=$(tail -1 "$said" 2>/dev/null || true)
rm -f "$said"
[ -n "$pass" ] || stop "the signing key's password could not be read from the login keyring${why:+: $why} (is the desktop session unlocked, and python3-secretstorage installed?)"
pin=$(hex <"$dir/signer.sha256")
[ ${#pin} -eq 64 ] || stop "$dir/signer.sha256 does not hold a SHA-256"

# The old key must be the lineage's first: it signs the older scheme for as long as the lineage is used.
old=$(keytool -list -v -keystore "$dir/old.keystore" -storepass android 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p' | head -1 | hex)
first=$("$tools/apksigner" lineage --in "$dir/lineage.bin" --print-certs 2>/dev/null | sed -n 's/^Signer #1 in lineage certificate SHA-256 digest: //p' | hex)
[ -n "$old" ] && [ "$old" = "$first" ] || stop "old.keystore is not the first key of the lineage"

tmp=$out.signing.$$
clean() { rm -f "$tmp" "$tmp.idsig" "$tmp.said" "$out.idsig"; }
trap clean EXIT
# The password goes in on standard input, for the second signer alone: never on a command line or in the environment.
printf '%s\n' "$pass" | "$tools/apksigner" sign \
	--ks "$dir/old.keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android \
	--next-signer --ks "$keystore" --ks-key-alias karto --ks-pass stdin \
	--lineage "$dir/lineage.bin" --rotation-min-sdk-version 28 \
	--v1-signing-enabled false --v4-signing-enabled false \
	--out "$tmp" "$in" >"$tmp.said" 2>&1 || stop "apksigner could not sign (a wrong password, or a lineage that isn't these keys'): $(grep -v '^[[:space:]]*at ' "$tmp.said" | tail -2 | tr '\n' ' ')"
[ -s "$tmp" ] || stop "apksigner wrote nothing"

verified=$("$tools/apksigner" verify -v --print-certs "$tmp" 2>/dev/null) || stop "the signed APK does not verify"
echo "$verified" | grep -q '^Verified using v3 scheme (APK Signature Scheme v3): true' || stop "the signed APK is not signed by scheme v3"
signers=$(echo "$verified" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: //p' | hex)
[ "$signers" = "$pin" ] || stop "the signed APK's signer is not the one pinned in signer.sha256"
mv "$tmp" "$out"
echo "signed by $(echo "$pin" | cut -c1-16)… (the project's key), scheme v3"
