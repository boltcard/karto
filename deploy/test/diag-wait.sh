#!/bin/sh
# Waits for the diagnostics screen's results: prints each CARDAPP-DIAG line
# from `adb logcat -s ReactNativeJS:I` as it comes, and exits 0 once a
# CARDAPP-DIAG-DONE line has come, or 124 after SECONDS without one. The
# logcat runs in the background into a temporary file, read every 2 seconds,
# and is stopped on the way out, so nothing is left waiting on a pipe (an
# `adb logcat | while … break` waiter once hung after DIAG-DONE, as
# adb never got its SIGPIPE). Usage: diag-wait.sh SECONDS
set -eu
secs=${1:-}
case $secs in '' | *[!0-9]*)
	echo "usage: diag-wait.sh SECONDS" >&2
	exit 2
	;;
esac
root=$(cd "$(dirname "$0")/../.." && pwd)
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
adb="$ANDROID_HOME/platform-tools/adb"
log=$(mktemp)
pid=
stop() {
	if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
	rm -f "$log"
}
trap stop EXIT
trap 'exit 130' INT TERM
"$adb" logcat -s ReactNativeJS:I >"$log" 2>/dev/null &
pid=$!
shown=0
waited=0
while :; do
	# Whole lines only: one still being written waits for the next look.
	n=$(wc -l <"$log")
	if [ "$n" -gt "$shown" ]; then
		if awk -v from="$shown" -v to="$n" '
			NR > to { exit }
			NR > from && /CARDAPP-DIAG/ { print; if (/CARDAPP-DIAG-DONE/) { done = 1; exit } }
			END { exit !done }' "$log"; then
			exit 0
		fi
		shown=$n
	fi
	[ "$waited" -lt "$secs" ] || exit 124
	sleep 2
	waited=$((waited + 2))
done
