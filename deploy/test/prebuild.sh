#!/bin/sh
# Makes app/android from app.json and the config plugins. Expo's prebuild
# deletes android/ and makes it again unless told --no-clean, and with it go
# Gradle's history and every native module it compiled: each phone build then
# compiled all of them (about 7 minutes for a JS change). So android/ is made
# afresh only when prebuild's inputs have changed (app.json, app.config.js and
# variant.js, package.json, package-lock.json, the config plugins, which of
# the two apps is being built (APP_VARIANT, wallet when unset), and whether it
# is a release (KARTO_RELEASE: the identifiers, so the package's folder)), so nothing
# a removed plugin, or the other app, put there stays behind; otherwise the
# plugins are applied to the android/ already there. KARTO_STORE is not an
# input: it changes no config, and the card-native module's build.gradle reads
# it at each build. Run from anywhere.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root/app"
stamp=android/.prebuild-inputs
inputs=$({ echo "variant ${APP_VARIANT:-wallet} release ${KARTO_RELEASE:-}"; cat app.json app.config.js variant.js package.json package-lock.json plugins/*; } | sha256sum | cut -d' ' -f1)
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$inputs" ]; then
	npx expo prebuild -p android --no-install --no-clean >/dev/null
else
	echo "prebuild inputs changed: making app/android afresh"
	npx expo prebuild -p android --no-install >/dev/null
	echo "$inputs" >"$stamp"
fi
