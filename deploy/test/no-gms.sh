#!/bin/sh
# Fails if an APK contains Google Play Services or Firebase code, or a
# manifest entry for them: the app must work on de-Googled Android.
# Usage: no-gms.sh path/to/app.apk
set -eu
apk=${1:?usage: no-gms.sh app.apk}
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
aapt2=$(find "$ANDROID_HOME/build-tools" -name aapt2 | sort | tail -1)
# Class names in the dex files, e.g. Lcom/google/android/gms/...; Expo's own
# classes are the control that the search sees the code at all.
expo=$(unzip -p "$apk" 'classes*.dex' | grep -a -c 'Lexpo/modules/' || true)
google=$(unzip -p "$apk" 'classes*.dex' | grep -a -c -E 'Lcom/google/(android/gms|firebase)/' || true)
manifest=$("$aapt2" dump xmltree --file AndroidManifest.xml "$apk" | grep -c -E 'com\.google\.(android\.gms|firebase)' || true)
echo "dex lines naming expo: $expo, Play Services/Firebase: $google; manifest entries: $manifest"
[ "$expo" -gt 0 ] || { echo "no Expo classes found: is this the app's APK?" >&2; exit 2; }
[ "$google" -eq 0 ] && [ "$manifest" -eq 0 ] || { echo "the APK depends on Google Play Services or Firebase" >&2; exit 1; }
echo PASS
