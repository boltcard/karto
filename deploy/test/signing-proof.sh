#!/bin/sh
# The proof, on a test phone, that the project's signing key does what it is for (deploy/signing/README.md): an APK
# signed with the React Native template's debug key, which everyone has, is refused as an update of either app, and
# a Karto PoS signed with it, put on the phone under Karto PoS's name, is turned away by the wallet. What the wallet
# then shows is looked at by whoever runs it. Nothing is paid and nothing leaves the phone. It runs on an emulator,
# or on the one phone named by SIGNING_PROOF_MODEL (its ro.product.model): never a phone whose apps matter.
#
# First build both apps with their files kept, from the repo root:
#   CARDAPP_KEEP_APKS=$PWD/.signing-proof make pos-install
#   CARDAPP_KEEP_APKS=$PWD/.signing-proof make phone-install
# Then:
#   sh deploy/test/signing-proof.sh refuse-debug   the debug key's APK over each app: refused
#   sh deploy/test/signing-proof.sh plant          Karto PoS removed, the debug key's one put in its place
#   sh deploy/test/signing-proof.sh restore        the planted app removed, this branch's Karto PoS installed
# After plant: in Karto Wallet, Add a PoS phone, Karto PoS is on this phone. It must say the app isn't ours.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
keep=${CARDAPP_KEEP_APKS:-$root/.signing-proof}
wallet=tech.whitewolf.karto.dev
pos=tech.whitewolf.kartopos.dev
stop() { echo "signing-proof: $*" >&2; exit 1; }
[ "$("$adb" devices | grep -c 'device$')" -eq 1 ] || stop "connect exactly one phone (adb devices)"
# Every command from here goes to that one phone, whatever else comes onto adb meanwhile.
ANDROID_SERIAL=$("$adb" devices | sed -n 's/\tdevice$//p')
export ANDROID_SERIAL
model=$("$adb" shell getprop ro.product.model | tr -d '\r')
qemu=$("$adb" shell getprop ro.kernel.qemu | tr -d '\r')
# A model that can't be read is no test phone: an adb hiccup must not let this through.
[ -n "$model" ] || stop "could not read the phone's model: nothing done"
if [ "$qemu" != 1 ] && { [ -z "${SIGNING_PROOF_MODEL:-}" ] || [ "$model" != "$SIGNING_PROOF_MODEL" ]; }; then
	stop "this is a $model, not an emulator: name a test phone with SIGNING_PROOF_MODEL='<its model>' to run on it. Nothing done"
fi
for f in wallet-debug-key wallet-project-key pos-debug-key pos-project-key; do
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

case "${1:-}" in
refuse-debug)
	refused "$keep/wallet-debug-key.apk" "$wallet" "Karto Wallet signed with the debug key"
	refused "$keep/pos-debug-key.apk" "$pos" "Karto PoS signed with the debug key"
	;;
plant)
	echo "signing-proof: removing Karto PoS ($pos, and no other app) and installing a debug-key one in its place"
	"$adb" uninstall "$pos" >/dev/null 2>&1 || true
	"$adb" install "$keep/pos-debug-key.apk" >/dev/null
	echo "signing-proof: planted. In Karto Wallet: Add a PoS phone, then Karto PoS is on this phone. Expected: \"The app on this phone that goes by Karto PoS's name isn't signed as this app is. The code wasn't given to it.\""
	;;
restore)
	"$adb" uninstall "$pos" >/dev/null 2>&1 || true
	"$adb" install "$keep/pos-project-key.apk" >/dev/null
	echo "signing-proof: this branch's Karto PoS is installed again, unpaired: pair it from Karto Wallet"
	;;
*) stop "refuse-debug | plant | restore" ;;
esac
