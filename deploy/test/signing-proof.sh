#!/bin/sh
# The proof, on a real phone, that the project's signing key does what it is for (deploy/signing/README.md). It was
# written for one test phone, a Pixel 8 Pro, and refuses any other model (the check below: change it for another
# test phone, never a phone whose apps matter). It offers the phone APKs that must be refused, and plants strangers' apps for the wallet to
# turn away; what the apps then show is looked at by whoever runs it. Nothing is paid and nothing leaves the phone.
#
# First build both apps with their files kept, from the repo root:
#   CARDAPP_KEEP_APKS=$PWD/.signing-proof make pos-install
#   CARDAPP_KEEP_APKS=$PWD/.signing-proof make phone-install
# (those two installs are the proof's first steps: the new key over the old, and over itself). Then:
#   sh deploy/test/signing-proof.sh refuse-old        the old key alone, over each app: refused
#   sh deploy/test/signing-proof.sh refuse-stranger   a stranger's lineage from the same public key: refused
#   sh deploy/test/signing-proof.sh plant old         Karto PoS removed, the old-key one put in its place
#   sh deploy/test/signing-proof.sh plant stranger    the same, with the stranger's
#   sh deploy/test/signing-proof.sh restore           the planted app removed, this branch's Karto PoS installed
# After each plant: in Karto Wallet, Add a PoS phone, Karto PoS is on this phone. It must say the app isn't ours.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
keep=${CARDAPP_KEEP_APKS:-$root/.signing-proof}
stop() { echo "signing-proof: $*" >&2; exit 1; }
[ "$("$adb" devices | grep -c 'device$')" -eq 1 ] || stop "connect exactly one phone (adb devices)"
# Every command from here goes to that one phone, whatever else comes onto adb meanwhile.
ANDROID_SERIAL=$("$adb" devices | sed -n 's/\tdevice$//p')
export ANDROID_SERIAL
model=$("$adb" shell getprop ro.product.model | tr -d '\r')
[ "$model" = "Pixel 8 Pro" ] || stop "this is for the Pixel 8 Pro, the throwaway phone, and this is a $model: nothing done"
for f in wallet-old-key wallet-new-key pos-old-key pos-new-key; do
	[ -f "$keep/$f.apk" ] || stop "$keep/$f.apk is missing: build both apps with CARDAPP_KEEP_APKS=$keep first"
done

# Offers an APK over the installed app; it must be refused, and the app must still be the one that was there.
refused() { # refused <apk> <package> <what>
	before=$("$adb" shell dumpsys package "$2" | sed -n 's/^ *lastUpdateTime=//p' | head -1)
	if out=$("$adb" install -r "$1" 2>&1); then stop "$3: Android INSTALLED it over $2: $out"; fi
	# Only Android's own refusal of the signer counts: a verifier's no, or a prompt left unanswered, proves nothing.
	echo "$out" | grep -q INSTALL_FAILED_UPDATE_INCOMPATIBLE || stop "$3: it was not installed, but not for its signature: $out"
	after=$("$adb" shell dumpsys package "$2" | sed -n 's/^ *lastUpdateTime=//p' | head -1)
	[ -n "$before" ] && [ "$before" = "$after" ] || stop "$3: $2 changed though the install failed"
	echo "signing-proof: $3: refused (INSTALL_FAILED_UPDATE_INCOMPATIBLE); $2 is as it was"
}

# A stranger's key and lineage, as anyone can make from the public debug key, and both apps signed with them.
stranger() {
	s=$keep/stranger
	mkdir -p "$s"
	[ -f "$s/key.p12" ] || keytool -genkeypair -keystore "$s/key.p12" -storetype PKCS12 -storepass stranger1 -alias karto -keyalg EC -groupname secp256r1 -sigalg SHA256withECDSA -validity 30 -dname "CN=A stranger" >/dev/null 2>&1
	[ -f "$s/lineage.bin" ] || "$tools/apksigner" rotate --out "$s/lineage.bin" \
		--old-signer --ks "$root/deploy/signing/old.keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android \
		--new-signer --ks "$s/key.p12" --ks-key-alias karto --ks-pass pass:stranger1 >/dev/null
	for app in wallet pos; do
		"$tools/apksigner" sign --ks "$root/deploy/signing/old.keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android \
			--next-signer --ks "$s/key.p12" --ks-key-alias karto --ks-pass pass:stranger1 --lineage "$s/lineage.bin" --rotation-min-sdk-version 28 \
			--v1-signing-enabled false --v4-signing-enabled false --out "$keep/$app-stranger.apk" "$keep/$app-old-key.apk" >/dev/null
	done
}

case "${1:-}" in
refuse-old)
	refused "$keep/wallet-old-key.apk" app.cardapp "Karto Wallet signed with the old key alone"
	refused "$keep/pos-old-key.apk" app.cardapp.pos "Karto PoS signed with the old key alone"
	;;
refuse-stranger)
	stranger
	refused "$keep/wallet-stranger.apk" app.cardapp "Karto Wallet with a stranger's lineage"
	refused "$keep/pos-stranger.apk" app.cardapp.pos "Karto PoS with a stranger's lineage"
	;;
plant)
	case "${2:-}" in
	old) apk=$keep/pos-old-key.apk ;;
	stranger) stranger; apk=$keep/pos-stranger.apk ;;
	*) stop "plant old | plant stranger" ;;
	esac
	echo "signing-proof: removing Karto PoS (app.cardapp.pos, and no other app) and installing a $2-signed one in its place"
	"$adb" uninstall app.cardapp.pos >/dev/null 2>&1 || true
	"$adb" install "$apk" >/dev/null
	echo "signing-proof: planted. In Karto Wallet: Add a PoS phone, then Karto PoS is on this phone. Expected: \"The app on this phone that goes by Karto PoS's name isn't signed as this app is. The code wasn't given to it.\""
	;;
restore)
	"$adb" uninstall app.cardapp.pos >/dev/null 2>&1 || true
	"$adb" install "$keep/pos-new-key.apk" >/dev/null
	echo "signing-proof: this branch's Karto PoS is installed again, unpaired: pair it from Karto Wallet"
	;;
*) stop "refuse-old | refuse-stranger | plant old | plant stranger | restore" ;;
esac
