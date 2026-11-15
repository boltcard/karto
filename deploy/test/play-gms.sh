#!/bin/sh
# The Play build's own Google check (KARTO_STORE=play): no-gms.sh's
# search, with one manifest entry allowed. UnifiedPush's embedded FCM distributor carries no Play Services or
# Firebase code, and its manifest names Google once: <queries><package android:name="com.google.android.gms"/>, so
# it can ask Play Services for an endpoint (its receiver's c2dm names aren't matched): that package exactly, and
# nowhere else. Fails on any other: every other build stays Google-free and passes no-gms.sh (play-gms-test.sh
# checks both). Usage: play-gms.sh path/to/app.apk
set -eu
apk=${1:?usage: play-gms.sh app.apk}
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
aapt2=$(find "$ANDROID_HOME/build-tools" -name aapt2 | sort | tail -1)
# Expo's classes are the control that the search sees the code at all; the distributor's, that this is the Play build.
expo=$(unzip -p "$apk" 'classes*.dex' | grep -a -c 'Lexpo/modules/' || true)
fcm=$(unzip -p "$apk" 'classes*.dex' | grep -a -c 'Lorg/unifiedpush/android/embedded_fcm_distributor/' || true)
google=$(unzip -p "$apk" 'classes*.dex' | grep -a -c -E 'Lcom/google/(android/gms|firebase)/' || true)
# Each manifest line naming Google, as the element it is in, that element's parent and the value it names: aapt2
# indents a child past its parent (by no fixed amount), so the elements open at each line are a stack by indent.
where=$("$aapt2" dump xmltree --file AndroidManifest.xml "$apk" | awk '
	{ match($0, /^ */); depth = RLENGTH; while (n > 0 && at[n] >= depth) n-- }
	/^ *E: / { n++; at[n] = depth; name[n] = $2; next }
	/com\.google\.(android\.gms|firebase)/ { match($0, /="[^"]*"/); print name[n - 1] "/" name[n] " " substr($0, RSTART + 2, RLENGTH - 3) }
')
manifest=$(printf '%s' "$where" | grep -c . || true)
echo "dex lines naming expo: $expo, the embedded FCM distributor: $fcm, Play Services/Firebase: $google; manifest entries: $manifest (${where:-none})"
[ "$expo" -gt 0 ] || { echo "no Expo classes found: is this the app's APK?" >&2; exit 2; }
[ "$fcm" -gt 0 ] || { echo "no embedded FCM distributor: is this the Play build (KARTO_STORE=play)?" >&2; exit 2; }
[ "$google" -eq 0 ] || { echo "the APK carries Play Services or Firebase code" >&2; exit 1; }
[ "$where" = "queries/package com.google.android.gms" ] || { echo "the manifest names Google other than the distributor's <queries> entry" >&2; exit 1; }
echo PASS
