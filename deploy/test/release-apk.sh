#!/bin/sh
# Builds the release APK and installs it over the app on the one phone on adb,
# keeping the app's data and never opening it. The JS bundle is always made
# afresh: Metro inlines EXPO_PUBLIC_* values, which aren't a Gradle input, so
# createBundleReleaseJsAndAssets would otherwise reuse a bundle built with
# other values (a diagnostics bundle was once reinstalled as the
# normal app). Built at low priority with Gradle's build cache. android/ is
# kept between builds while prebuild's inputs stay the same (prebuild.sh), so
# unchanged native modules aren't compiled again. EXPO_PUBLIC_* in the
# environment go into the bundle. The APK is signed with the project's own
# key before it is checked (no Play Services) and installed: this is the one
# script that installs an APK, and it installs no other. Run from anywhere.
#
# A development build: native code for the phone's own ABI only, and a Gradle
# daemon of its own. The daemon is started here under nice and ionice, so it
# builds at low priority too, and it is listed in a registry of its own
# (~/.gradle/cardapp-daemon), so this build is never handed to a daemon
# started elsewhere at normal priority. It quits after a minute idle, as every
# daemon in app/android does (plugins/withGradleDaemon.js): builds come hours
# apart, and a warm one held ~9 GB. CARDAPP_FULL_BUILD=1 builds all four ABIs,
# without a daemon.
#
# APP_VARIANT=pos builds Karto PoS in place of Karto Wallet (app/variant.js):
# the setting goes to the config (APP_VARIANT) and to the bundle
# (EXPO_PUBLIC_APP_VARIANT), with the commit for its build label, and the
# bundle is checked to hold its own app and none of the other's.
#
# KARTO_STORE=play builds Karto Wallet for the Play Store: the card-native module's
# build.gradle adds UnifiedPush's embedded FCM distributor, the bundle is told
# (EXPO_PUBLIC_KARTO_STORE), and play-gms.sh checks it in place of no-gms.sh.
# Same package and key, so it installs over the wallet. Karto PoS is built
# Google-free only (app/variant.js refuses the setting for it).
#
# CARDAPP_BUILD_ONLY=1 builds, signs and checks without a phone: nothing is
# installed, and a development build is for arm64-v8a (the dev phones'), or
# for CARDAPP_ABI when set (x86_64 for an emulator).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
build_only=${CARDAPP_BUILD_ONLY:-}
[ "$build_only" = 1 ] || [ "$("$adb" devices | grep -c 'device$')" -eq 1 ] || { echo "connect exactly one phone (adb devices)" >&2; exit 2; }
variant=${APP_VARIANT:-wallet}
store=${KARTO_STORE:-}
export APP_VARIANT="$variant" EXPO_PUBLIC_APP_VARIANT="$variant" KARTO_STORE="$store" EXPO_PUBLIC_KARTO_STORE="$store"
if [ "$variant" = pos ]; then
	EXPO_PUBLIC_BUILD_COMMIT=$(git -C "$root" rev-parse --short HEAD)
	EXPO_PUBLIC_BUILD_TIME=$(date +%s)
	export EXPO_PUBLIC_BUILD_COMMIT EXPO_PUBLIC_BUILD_TIME
fi
cd "$root/app"
sh "$root/deploy/test/prebuild.sh"
apk=android/app/build/outputs/apk/release/app-release.apk
if [ "${CARDAPP_FULL_BUILD:-}" = 1 ]; then
	set -- --no-daemon
else
	if [ "$build_only" = 1 ]; then
		abi=${CARDAPP_ABI:-arm64-v8a}
	else
		abi=$("$adb" shell getprop ro.product.cpu.abi | tr -d '\r')
	fi
	set -- --daemon "-Dorg.gradle.daemon.registry.base=$HOME/.gradle/cardapp-daemon" "-PreactNativeArchitectures=$abi"
	echo "development build for $abi, on a low-priority daemon"
fi
(cd android && nice -n 19 ionice -c3 ./gradlew "$@" --build-cache :app:createBundleReleaseJsAndAssets --rerun :app:assembleRelease)
# Gradle signed it with the template's debug key, which everyone has: it is signed again with the project's key
# (deploy/signing/sign-apk.sh), and that file is the one checked and installed. Without the key nothing is installed.
signed=android/app/build/outputs/apk/release/app-release-signed.apk
sh "$root/deploy/signing/sign-apk.sh" "$apk" "$signed"
if [ "$store" = play ]; then
	sh "$root/deploy/test/play-gms.sh" "$signed"
else
	sh "$root/deploy/test/no-gms.sh" "$signed"
fi
sh "$root/deploy/test/bundle-markers.sh" "$signed" "$variant"
# For deploy/test/signing-proof.sh alone: both files kept, named by the app, for what it then offers the phone.
if [ -n "${CARDAPP_KEEP_APKS:-}" ]; then
	mkdir -p "$CARDAPP_KEEP_APKS"
	cp "$apk" "$CARDAPP_KEEP_APKS/$variant-debug-key.apk"
	cp "$signed" "$CARDAPP_KEEP_APKS/$variant-project-key.apk"
fi
if [ "$build_only" = 1 ]; then
	echo "built $root/app/$signed (not installed)"
	exit 0
fi
"$adb" install -r "$signed"
