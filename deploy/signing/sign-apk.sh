#!/bin/sh
# Signs a release APK with the project's own key (deploy/signing/README.md).
#   sh deploy/signing/sign-apk.sh <in.apk> <out.apk>
# Gradle signs the release APK with the React Native template's debug key, which everyone has. This signs it again
# with the project's key alone, by schemes v2 (which Android 7 and 8 read) and v3 (9 up): no other key, no lineage.
# An app signed so takes updates signed with the project's key and no other.
#
# The key is a PKCS #12 keystore outside the repository and its password is in the desktop's login keyring; this
# folder holds what is public: the certificate's SHA-256 (signer.sha256). With any of them missing, wrong or locked
# the script stops and leaves no output file.
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
[ -f "$dir/signer.sha256" ] || stop "$dir/signer.sha256 is missing: deploy/signing/make-key.sh writes it, once, and it is committed"
[ -f "$keystore" ] || stop "no signing key at $keystore: it is made once by deploy/signing/make-key.sh, on the one computer that builds for a phone, and restored there from its backup"
[ -d "$(dirname "$out")" ] || stop "no folder for the output at $(dirname "$out")"
tmp=$out.signing.$$
clean() { rm -f "$tmp" "$tmp.idsig" "$tmp.said" "$out.idsig"; }
trap clean EXIT
said=$tmp.said
pass=$(password 2>"$said") || pass=
why=$(tail -1 "$said" 2>/dev/null || true)
rm -f "$said"
[ -n "$pass" ] || stop "the signing key's password could not be read from the login keyring${why:+: $why} (is the desktop session unlocked, and python3-secretstorage installed?)"
pin=$(hex <"$dir/signer.sha256")
[ ${#pin} -eq 64 ] || stop "$dir/signer.sha256 does not hold a SHA-256"

# The password goes in on standard input: never on a command line or in the environment.
printf '%s\n' "$pass" | "$tools/apksigner" sign --ks "$keystore" --ks-key-alias karto --ks-pass stdin \
	--v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
	--out "$tmp" "$in" >"$tmp.said" 2>&1 || stop "apksigner could not sign (a wrong password?): $(grep -v '^[[:space:]]*at ' "$tmp.said" | tail -2 | tr '\n' ' ')"
[ -s "$tmp" ] || stop "apksigner wrote nothing"

# Verified as Android 7 (API 24, Karto PoS's floor) would: apksigner leaves out of its report a scheme no Android
# from the APK's own floor reads, so the wallet's (Android 9) would show v2 as false without this.
verified=$("$tools/apksigner" verify -v --print-certs --min-sdk-version 24 "$tmp" 2>/dev/null) || stop "the signed APK does not verify"
echo "$verified" | grep -q '^Verified using v2 scheme (APK Signature Scheme v2): true' || stop "the signed APK is not signed by scheme v2"
echo "$verified" | grep -q '^Verified using v3 scheme (APK Signature Scheme v3): true' || stop "the signed APK is not signed by scheme v3"
signers=$(echo "$verified" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: //p' | hex)
[ "$signers" = "$pin" ] || stop "the signed APK's one signer is not the one pinned in signer.sha256"
mv "$tmp" "$out"
echo "signed by $(echo "$pin" | cut -c1-16)… (the project's key), schemes v2 and v3"
