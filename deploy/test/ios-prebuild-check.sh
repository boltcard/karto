#!/bin/sh
# Writes the iPhone app's Xcode project on Linux (expo prebuild: nothing is installed or compiled) and checks
# what the app's settings became in it, for the wallet, the diagnostics app and Karto PoS. Cheap, so a wrong setting is found
# here and not by a Mac's twenty minutes. Needs node, python3 and app/node_modules. app/ios is made afresh.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root/app"
[ -d node_modules ] || npm ci

# check KIND: prebuilds with the environment it is given, then reads the result.
check() {
	kind=$1
	rm -rf ios
	npx expo prebuild -p ios --no-install >/dev/null 2>&1 || {
		echo "FAIL: expo prebuild ($kind)"
		exit 1
	}
	python3 - "$kind" <<'PY'
import plistlib, sys
kind = sys.argv[1]
# Expo names the project after the app's name without its spaces: the till's is KartoPoS.
proj = 'KartoPoS' if kind == 'pos' else 'Karto'
info = plistlib.load(open(f'ios/{proj}/Info.plist', 'rb'))
rights = plistlib.load(open(f'ios/{proj}/{proj}.entitlements', 'rb'))
project = open(f'ios/{proj}.xcodeproj/project.pbxproj', encoding='utf-8').read()
bad = []
def want(what, got, expected):
    if got != expected: bad.append(f'{what}: {got!r}, not {expected!r}')
want("the NTAG 424 DNA's application ID", info.get('com.apple.developer.nfc.readersession.iso7816.select-identifiers'), ['D2760000850101'])
want("the card reader's entitlement", rights.get('com.apple.developer.nfc.readersession.formats'), ['TAG'])
# The cameras record no sound and keep nothing on the phone.
for key in ('NSMicrophoneUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSPhotoLibraryAddUsageDescription'):
    want(f'no {key}', info.get(key), None)
want('the fonts', sorted(info.get('UIAppFonts', [])), ['Inter-Bold.ttf', 'Inter-Regular.ttf', 'Inter-SemiBold.ttf'])
want('not for tablets', 'TARGETED_DEVICE_FAMILY = "1";' in project, True)
if kind == 'pos':
    # Karto PoS: its own identifier and lines, no Face ID, no server files.
    want('the identifier', 'PRODUCT_BUNDLE_IDENTIFIER = "tech.whitewolf.kartopos.dev";' in project, True)
    want("the card reader's line", info.get('NFCReaderUsageDescription'), 'Karto PoS reads Bolt Cards to charge them.')
    want('no Face ID line', info.get('NSFaceIDUsageDescription'), None)
    want("the camera's line", info.get('NSCameraUsageDescription'), 'Karto PoS uses the camera to scan the pairing code Karto Wallet shows.')
    want('no step that copies the server files', 'Copy the server bundle (withDeployAssets)' in project, False)
    want('the name', info.get('CFBundleDisplayName'), 'Karto PoS')
    want('no local-network line', info.get('NSLocalNetworkUsageDescription'), None)
else:
    want('the identifier', 'PRODUCT_BUNDLE_IDENTIFIER = "tech.whitewolf.karto.dev";' in project, True)
    want("the card reader's line", info.get('NFCReaderUsageDescription'), 'Karto Wallet reads and sets up your Bolt Cards.')
    want('the Face ID line', info.get('NSFaceIDUsageDescription'), 'Karto Wallet asks for Face ID before it shows your recovery phrase, wipes a card or changes your server.')
    want("the camera's line", info.get('NSCameraUsageDescription'), 'Karto Wallet uses the camera to scan a QR code you want to pay and to photograph your cards.')
    want('the step that copies the server files', 'Copy the server bundle (withDeployAssets)' in project, True)
if kind == 'wallet':
    want('the name', info.get('CFBundleDisplayName'), 'Karto')
    want('no local-network line', info.get('NSLocalNetworkUsageDescription'), None)
elif kind == 'diagnostics':
    want('the name', info.get('CFBundleDisplayName'), 'Karto Diagnostics')
    want('the local-network line', info.get('NSLocalNetworkUsageDescription'), 'Karto Diagnostics reaches a test server on this network.')
for b in bad: print(f'FAIL ({kind}): {b}')
print(f'{kind}: {"ok" if not bad else str(len(bad)) + " wrong"}')
sys.exit(1 if bad else 0)
PY
}

EXPO_PUBLIC_DIAG_SSH='' check wallet
EXPO_PUBLIC_DIAG_SSH='192.168.1.10:12224:debian:AAAA:ab' check diagnostics
# Last: under dash an assignment before a function call outlives the call.
APP_VARIANT=pos EXPO_PUBLIC_DIAG_SSH='' check pos
rm -rf ios
echo PASS
