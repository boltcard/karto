#!/bin/sh
# Checks that an APK's JS bundle holds its own app and not the other's: Karto Wallet
# and Karto PoS are two builds of one project. The bundle is Hermes bytecode, whose
# strings are kept as they are written, so a marker is a sentence or a name
# that one part of the project alone holds: Karto PoS's bundle must hold none
# of three, one each from src/app/, services/ and onboarding/, and its own
# first screen's; Karto Wallet's must hold those three and none of the PoS's.
# Usage: bundle-markers.sh path/to/app.apk wallet|pos
set -eu
apk=${1:?usage: bundle-markers.sh app.apk wallet|pos}
variant=${2:?usage: bundle-markers.sh app.apk wallet|pos}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
unzip -p "$apk" assets/index.android.bundle >"$work/bundle"
[ -s "$work/bundle" ] || { echo "no JS bundle in $apk" >&2; exit 2; }
count() { grep -a -c -F "$1" "$work/bundle" || true; }
app=$(count 'Add your first card')
services=$(count 'CARDAPP-ONBOARDING')
onboarding=$(count '.lnvps.cloud')
pos=$(count 'Pair this phone to take payments')
echo "markers in the $variant bundle: src/app $app, services $services, onboarding $onboarding, pos-app $pos"
case "$variant" in
pos)
	[ "$pos" -gt 0 ] || { echo "the PoS's own screen isn't in its bundle" >&2; exit 1; }
	[ "$app" -eq 0 ] && [ "$services" -eq 0 ] && [ "$onboarding" -eq 0 ] || { echo "Karto Wallet's code is in the PoS's bundle" >&2; exit 1; }
	;;
wallet)
	[ "$app" -gt 0 ] && [ "$services" -gt 0 ] && [ "$onboarding" -gt 0 ] || { echo "a wallet marker is missing: the markers no longer name the wallet's code" >&2; exit 2; }
	[ "$pos" -eq 0 ] || { echo "Karto PoS's code is in the wallet's bundle" >&2; exit 1; }
	;;
*)
	echo "the variant is wallet or pos" >&2
	exit 2
	;;
esac
echo PASS
