#!/bin/sh
# install.sh recovery-check on a fake Docker: the paths the stack test can't
# reach (its phoenixd never has a channel) and the ones it can only reach
# slowly. phoenixd's volume is a directory, a container is a file, phoenix-cli
# answers from the database it runs on ("original" or "fresh"), and date and
# sleep run on a fake clock. The fake records anything that must never happen:
# cardd started while phoenixd's original database is set aside, or phoenixd
# started on a retired server. Run from the repo root: make deploy-test
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
export FAKE="$t/fake"
app="$t/card-app"
vol="$FAKE/vol"
mkdir -p "$t/bin" "$FAKE" "$app"
cp "$root/deploy/install.sh" "$app/"

cat >"$t/bin/docker" <<'EOF'
#!/bin/sh
set -eu
F=$FAKE
vol=$F/vol
say() { echo "$*" >>"$F/docker.log"; }
running() { [ -f "$F/run/$1" ]; }
db() { cat "$vol/phoenix.mainnet.x.db" 2>/dev/null || echo none; }
start() {
	for s in "$@"; do
		running "$s" && continue
		if [ "$s" = phoenixd ]; then
			[ ! -f "$vol/RETIRED" ] || echo "phoenixd started on a retired server" >>"$F/violations"
			# A phoenixd without its database makes a new one.
			if [ ! -e "$vol/phoenix.mainnet.x.db" ]; then
				echo fresh >"$vol/phoenix.mainnet.x.db"
				echo fresh-wal >"$vol/phoenix.mainnet.x.db-wal"
				echo fresh-log >"$vol/phoenix.log"
			fi
			echo 0 >"$F/reads"
		fi
		if [ "$s" = cardd ] && ls -d "$vol"/aside-* >/dev/null 2>&1; then
			echo "cardd started while $(cd "$vol" && ls -d aside-*) was set aside" >>"$F/violations"
		fi
		touch "$F/run/$s"
		say "start $s ($(db))"
	done
}
# phoenix-cli getinfo: the original database has its channel; a fresh one
# gets one (Normal, with $3 sat, id $4) from its read number $2 on, if "fresh" says so.
getinfo() {
	n=$(($(cat "$F/reads") + 1))
	echo "$n" >"$F/reads"
	[ "$(cat "$F/retire-at" 2>/dev/null)" != "$n" ] || echo "2026-10-07T00:00:00Z 1004" >"$vol/RETIRED"
	state= bal=0 id=
	case $(db) in
	original) state=Normal bal=$(cat "$F/orig") id=c0ffee ;;
	fresh) if [ -f "$F/fresh" ]; then
		read -r from b i <"$F/fresh"
		[ "$n" -lt "$from" ] || state=Normal bal=$b id=$i
	fi ;;
	esac
	echo "$bal" >"$F/bal"
	printf '{\n    "nodeId": "02aa",\n    "channels": ['
	[ -z "$state" ] || printf '\n        {\n            "state": "%s",\n            "channelId": "%s",\n            "balanceSat": %s\n        }\n    ' "$state" "$id" "$bal"
	printf '],\n    "chain": "mainnet",\n    "version": "0.9.2"\n}\n'
}
[ "$1" = info ] && exit 0
[ "$1" = compose ] || exit 1
shift
cmd=$1
shift
case $cmd in
stop)
	any=
	for a; do
		case $a in --timeout | [0-9]*) ;; *)
			any=1
			rm -f "$F/run/$a"
			say "stop $a"
			;;
		esac
	done
	[ -n "$any" ] || { rm -f "$F/run/"*; say "stop all"; }
	# A full disk from the moment phoenixd is stopped alone (putting the original back): the state can't be written.
	if [ "$*" = "--timeout 60 phoenixd" ] && [ -f "$F/full-at-put-back" ]; then mkdir -p "$(cat "$F/full-at-put-back")/recovery-check.state.tmp"; fi
	;;
up)
	wait= svcs=
	for a; do case $a in -d | --quiet-pull) ;; --wait) wait=1 ;; *) svcs="$svcs $a" ;; esac; done
	if [ -n "$wait" ] && [ -f "$F/fail-up" ]; then
		rm "$F/fail-up"
		say "up failed"
		exit 1
	fi
	# shellcheck disable=SC2086 # a list of services
	start ${svcs:-phoenixd cardd caddy}
	;;
down) rm -f "$F/run/"* && say down ;;
ps) if running phoenixd; then echo 0123abcd; fi ;;
exec)
	[ "$1" != -T ] || shift
	running "$1" || { echo "service \"$1\" is not running" >&2; exit 1; }
	case "$*" in
	"phoenixd /phoenix/phoenix-cli getinfo") getinfo ;;
	"phoenixd /phoenix/phoenix-cli getbalance") printf '{\n    "balanceSat": %s,\n    "feeCreditSat": 0\n}\n' "$(cat "$F/bal")" ;;
	"cardd /cardd ledger holds") cat "$F/holds" 2>/dev/null || true ;;
	*) exit 1 ;;
	esac
	;;
run)
	ep=
	while :; do case $1 in --rm | --no-deps | -T) shift ;; --entrypoint) ep=$2 && shift 2 ;; --user | -v) shift 2 ;; *) break ;; esac; done
	svc=$1
	shift
	if [ -z "$ep" ]; then
		[ "$svc $*" = "cardd ledger holds" ] || exit 1
		cat "$F/holds-stopped" 2>/dev/null || true
		exit 0
	fi
	# The volume where phoenixd's container has it.
	n=$#
	while [ "$n" -gt 0 ]; do
		a=$(printf '%s' "$1" | sed "s#/phoenix/.phoenix#$vol#g")
		shift
		set -- "$@" "$a"
		n=$((n - 1))
	done
	"$ep" "$@"
	;;
*) exit 1 ;;
esac
EOF
cat >"$t/bin/date" <<'EOF'
#!/bin/sh
if [ "$*" = +%s ]; then cat "$FAKE/clock"; else exec /bin/date "$@"; fi
EOF
cat >"$t/bin/sleep" <<'EOF'
#!/bin/sh
echo $(($(cat "$FAKE/clock") + $1)) >"$FAKE/clock"
EOF
chmod +x "$t/bin/docker" "$t/bin/date" "$t/bin/sleep"
export PATH="$t/bin:$PATH"

fail() {
	echo "FAIL: $scenario: $*" >&2
	echo "-- exit $code, stdout: $out" >&2
	cat "$t/err" "$app/recovery-check.log" "$FAKE/docker.log" >&2 2>/dev/null || true
	(cd "$vol" && find . | sort) >&2
	exit 1
}

# A server with a Normal channel of 50123 sat, everything running.
setup() {
	scenario=$1 code='' out=''
	rm -rf "$vol" "$FAKE/run" "$app/recovery-check".*
	rm -f "$FAKE"/*
	mkdir -p "$vol" "$FAKE/run"
	echo seed >"$vol/seed.dat"
	echo conf >"$vol/phoenix.conf"
	echo original >"$vol/phoenix.mainnet.x.db"
	echo original-wal >"$vol/phoenix.mainnet.x.db-wal"
	echo original-log >"$vol/phoenix.log"
	touch "$FAKE/run/phoenixd" "$FAKE/run/cardd" "$FAKE/run/caddy"
	echo 1000000 >"$FAKE/clock"
	echo 0 >"$FAKE/reads"
	echo 50123 >"$FAKE/orig"
}
# install.sh ARGS: $code, $out (stdout) and $t/err.
run() {
	set +e
	out=$(sh "$app/install.sh" "$@" </dev/null 2>"$t/err")
	code=$?
	set -e
}
want_code() { [ "$code" -eq "$1" ] || fail "exited $code, want $1"; }
# The files in phoenixd's volume's root, or in one of its directories.
# shellcheck disable=SC2086 # $1 is a glob
files() { (cd "$vol" && cd ${1:-.} && for f in *; do [ -f "$f" ] && printf '%s=%s ' "$f" "$(cat "$f")"; done); }
subdirs() { (cd "$vol" && find . -mindepth 1 -maxdepth 1 -type d | sed 's#^\./##; s/-.*//' | sort | tr '\n' ' '); }
ORIGINAL="phoenix.conf=conf phoenix.log=original-log phoenix.mainnet.x.db=original phoenix.mainnet.x.db-wal=original-wal seed.dat=seed "
FRESH="phoenix.conf=conf phoenix.log=fresh-log phoenix.mainnet.x.db=fresh phoenix.mainnet.x.db-wal=fresh-wal seed.dat=seed "
original_back() {
	[ "$(files)" = "$ORIGINAL" ] || fail "the original database isn't back: $(files)"
	[ "$(subdirs)" = "new " ] || fail "phoenixd's volume has $(subdirs), want new-*"
	[ "$(files new-*)" = "phoenix.log=fresh-log phoenix.mainnet.x.db=fresh phoenix.mainnet.x.db-wal=fresh-wal " ] ||
		fail "the check's database isn't in new-*: $(files new-*)"
}
kept_new() {
	[ "$(files)" = "$FRESH" ] || fail "the new database isn't kept: $(files)"
	[ "$(subdirs)" = "stale " ] || fail "phoenixd's volume has $(subdirs), want stale-*"
	[ "$(files stale-*)" = "phoenix.log=original-log phoenix.mainnet.x.db=original phoenix.mainnet.x.db-wal=original-wal " ] ||
		fail "the old database isn't in stale-*: $(files stale-*)"
}
running() { (cd "$FAKE/run" && find . -type f | sed 's#^\./##' | sort | tr '\n' ' '); }
all_running() { [ "$(running)" = "caddy cardd phoenixd " ] || fail "running: $(running)"; }
settled() {
	[ ! -f "$FAKE/violations" ] || fail "$(cat "$FAKE/violations")"
	[ ! -e "$app/recovery-check.state" ] || fail "the state is left: $(cat "$app/recovery-check.state")"
}
said() { echo "$out" | grep -q "$1" || fail "printed '$out', want $1"; }

echo "== recovery-check: the channel comes back with the same balance: the new database kept"
setup same
echo "3 50123 c0ffee" >"$FAKE/fresh"
run recovery-check 1
want_code 0
echo "$out" | grep -Eqx '\{"ok":true,"before":\{"balanceSat":50123,"channels":\["Normal"\],"channelIds":\["c0ffee"\]\},"after":\{"balanceSat":50123,"channels":\["Normal"\],"channelIds":\["c0ffee"\]\},"at":"[0-9]{8}T[0-9]{6}Z","seconds":30\}' ||
	fail "printed '$out'"
kept_new
all_running
settled
grep -q 'start cardd (fresh)' "$FAKE/docker.log" || fail "cardd wasn't started on the new database"
run recovery-check result
want_code 0
said '"ok":true'

echo "== recovery-check: a Normal channel with another balance: the new database kept, exit 9"
setup balance
echo "2 49000 c0ffee" >"$FAKE/fresh"
run recovery-check 1
want_code 9
said '"reason":"the channel came back with 49000 sat, not 50123: the new database is kept, the old one is in stale-'
said '"after":{"balanceSat":49000,"channels":\["Normal"\],"channelIds":\["c0ffee"\]}'
kept_new
all_running
settled

echo "== recovery-check: another channel came back: the new database kept, exit 9"
setup channel
echo "2 50123 beef" >"$FAKE/fresh"
run recovery-check 1
want_code 9
said '"reason":"another channel came back (beef, not c0ffee): the new database is kept'
kept_new
settled

echo "== recovery-check: a channel Normal only at the last look, after the wait, is kept"
setup last
# 6 reads in the minute's wait (every 10 s), then the last look.
echo "7 50123 c0ffee" >"$FAKE/fresh"
run recovery-check 1
want_code 0
kept_new
settled

echo "== recovery-check: no channel: the original database back, the new one in new-*, exit 9"
setup none
run recovery-check 1
want_code 9
said '"reason":"no Normal channel within 1 min (phoenixd: no channels, 0 sat): the original database is back"'
original_back
all_running
settled
run recovery-check result
want_code 9
said 'the original database is back'

echo "== recovery-check: the last start fails after the database is back: it stays back (never deleted)"
setup abort
touch "$FAKE/fail-up"
run recovery-check 1
want_code 1
said '"reason":"the check stopped on an error (exit 1): see recovery-check.log; no Normal channel within 1 min'
original_back
all_running
settled

echo "== recovery-check: refused, touching nothing, while a payment is in progress"
setup hold
printf '7\tpool\tsend\t1000000\t2026-10-07T00:00:00Z\n' >"$FAKE/holds"
run recovery-check 1
want_code 10
grep -q 'a payment is in progress' "$t/err" || fail "said '$(cat "$t/err")'"
[ ! -f "$FAKE/docker.log" ] || ! grep -q '^start\|^stop' "$FAKE/docker.log" || fail "it started or stopped: $(cat "$FAKE/docker.log")"
[ "$(files)" = "$ORIGINAL" ] && [ -z "$(subdirs)" ] || fail "phoenixd's volume changed: $(files) $(subdirs)"

echo "== recovery-check: a payment that began as cardd stopped: nothing moved, everything started again"
setup hold-late
printf '7\tpool\tsend\t1000000\t2026-10-07T00:00:00Z\n' >"$FAKE/holds-stopped"
run recovery-check 1
want_code 10
said '"reason":"a payment started as the check began (cardd ledger holds): nothing was changed"'
[ "$(files)" = "$ORIGINAL" ] && [ -z "$(subdirs)" ] || fail "phoenixd's volume changed: $(files) $(subdirs)"
all_running
settled

echo "== recovery-check: refused when cardd can't say whether a payment is in progress"
setup no-cardd
rm "$FAKE/run/cardd"
run recovery-check 1
want_code 10
grep -q 'cardd ledger holds' "$t/err" || fail "said '$(cat "$t/err")'"

echo "== recovery-check, up, retire and wipe: refused (11) while a check runs"
setup busy
printf 'started\n20261007T000000Z\n50123\n{}\n"c0ffee"\n' >"$app/recovery-check.state"
for args in "recovery-check" "recovery-check result" "up" "retire 1004" "wipe"; do
	set +e
	# shellcheck disable=SC2086 # split on purpose
	out=$(flock "$app/recovery-check.lock" sh "$app/install.sh" $args </dev/null 2>"$t/err")
	code=$?
	set -e
	want_code 11
	case $args in
	recovery-check*) want='install.sh recovery-check: a check is running (from 20261007T000000Z, started)' ;;
	*) want="install.sh ${args%% *}: a recovery check is running" ;;
	esac
	grep -q "$want" "$t/err" || fail "install.sh $args said '$(cat "$t/err")', want $want"
done
[ ! -f "$FAKE/docker.log" ] || ! grep -q '^start\|^stop\|^down' "$FAKE/docker.log" || fail "a refused step touched the containers: $(cat "$FAKE/docker.log")"

# Interrupted checks (a reboot, a SIGKILL): the state file and the volume as
# the worker left them at each phase, then up or recovery-check finishes it.
interrupted() { # PHASE: a state file from a check at 20261007T000000Z
	printf '%s\n20261007T000000Z\n50123\n{"balanceSat":50123,"channels":["Normal"],"channelIds":["c0ffee"]}\n"c0ffee"\n' "$1" >"$app/recovery-check.state"
}
aside() { # FILES...: moved from the root to aside-*
	mkdir -p "$vol/aside-20261007T000000Z"
	for f; do mv "$vol/$f" "$vol/aside-20261007T000000Z/"; done
}
fresh() { # the fresh database, as phoenixd makes it
	echo fresh >"$vol/phoenix.mainnet.x.db" && echo fresh-wal >"$vol/phoenix.mainnet.x.db-wal" && echo fresh-log >"$vol/phoenix.log"
}

echo "== interrupted while moving the database aside: up puts it back before starting anything"
setup moving
interrupted moving
aside phoenix.mainnet.x.db
rm "$FAKE/run/cardd" "$FAKE/run/phoenixd"
run up
want_code 0
[ "$(files)" = "$ORIGINAL" ] && [ -z "$(subdirs)" ] || fail "phoenixd's volume: $(files) $(subdirs)"
all_running
settled
run recovery-check result
want_code 9
said '"reason":"the check from 20261007T000000Z was interrupted; finishing it: phoenixd never started without its database: the original database is back"'

echo "== interrupted while phoenixd ran without its database: recovery-check puts it back"
setup started
interrupted started
aside phoenix.mainnet.x.db phoenix.mainnet.x.db-wal phoenix.log
fresh
rm "$FAKE/run/cardd"
run recovery-check
want_code 9
said 'the check from 20261007T000000Z was interrupted; finishing it: no Normal channel (phoenixd: no channels, 0 sat): the original database is back'
original_back
all_running
settled

echo "== interrupted, phoenixd stopped (not restarted): up starts it to look, then puts the original back"
setup started-stopped
interrupted started
aside phoenix.mainnet.x.db phoenix.mainnet.x.db-wal phoenix.log
fresh
rm "$FAKE/run/cardd" "$FAKE/run/phoenixd"
run up
want_code 0
original_back
all_running
settled
grep -q 'start phoenixd (fresh)' "$FAKE/docker.log" || fail "phoenixd wasn't started to look"

echo "== interrupted, and the channel came back meanwhile: the new database kept"
setup started-normal
interrupted started
aside phoenix.mainnet.x.db phoenix.mainnet.x.db-wal phoenix.log
fresh
echo "1 50123 c0ffee" >"$FAKE/fresh"
rm "$FAKE/run/cardd"
run recovery-check
want_code 0
kept_new
all_running
settled

echo "== interrupted after a Normal channel: the new database kept even if it isn't Normal now"
setup normal
interrupted normal
aside phoenix.mainnet.x.db phoenix.mainnet.x.db-wal phoenix.log
fresh
rm "$FAKE/run/cardd"
run up
want_code 0
kept_new
all_running
settled

echo "== interrupted while moving the new database out, then while moving the original back"
setup clearing
interrupted clearing
aside phoenix.mainnet.x.db phoenix.mainnet.x.db-wal phoenix.log
fresh
mkdir "$vol/new-20261007T000000Z"
mv "$vol/phoenix.log" "$vol/new-20261007T000000Z/"
rm "$FAKE/run/cardd" "$FAKE/run/phoenixd"
run up
want_code 0
original_back
settled
setup returning
interrupted returning
aside phoenix.mainnet.x.db phoenix.mainnet.x.db-wal
mkdir "$vol/new-20261007T000000Z"
echo fresh-log >"$vol/new-20261007T000000Z/phoenix.log"
echo fresh >"$vol/new-20261007T000000Z/phoenix.mainnet.x.db"
echo fresh-wal >"$vol/new-20261007T000000Z/phoenix.mainnet.x.db-wal"
rm "$FAKE/run/cardd" "$FAKE/run/phoenixd"
run up
want_code 0
original_back
settled

echo "== a database set aside with no state: up and recovery-check refuse to guess, starting nothing"
setup no-state
aside phoenix.mainnet.x.db
rm "$FAKE/run/cardd" "$FAKE/run/phoenixd"
for args in up recovery-check; do
	run "$args"
	want_code 1
	grep -q 'aside-20261007T000000Z with no record of the check: see deploy/README.md' "$t/err" || fail "said '$(cat "$t/err")'"
done
[ "$(running)" = "caddy " ] || fail "started something: $(running)"

echo "== a damaged state: up and recovery-check stop before touching anything"
setup damaged
printf 'started\n\n50123\n{}\n\n' >"$app/recovery-check.state"
aside phoenix.mainnet.x.db
rm "$FAKE/run/cardd" "$FAKE/run/phoenixd"
run up
want_code 1
grep -q 'recovery-check.state is damaged: see deploy/README.md' "$t/err" || fail "up said '$(cat "$t/err")'"
run recovery-check
want_code 1
grep -q 'recovery-check.state is damaged' "$app/recovery-check.log" || fail "the log: $(cat "$app/recovery-check.log")"
[ "$(running)" = "caddy " ] || fail "started something: $(running)"
[ "$(files aside-*)" = "phoenix.mainnet.x.db=original " ] || fail "the set-aside database moved: $(files aside-*)"
[ ! -f "$FAKE/docker.log" ] || ! grep -q '^start\|^stop' "$FAKE/docker.log" || fail "it touched the containers: $(cat "$FAKE/docker.log")"

echo "== the state can't be written while putting the original back (a full disk): nothing started, the state intact; up finishes it"
setup full
echo "$app" >"$FAKE/full-at-put-back"
run recovery-check 1
want_code 1
said "phoenixd's database couldn't be settled (at started): nothing was started"
[ "$(sed -n 1p "$app/recovery-check.state")" = started ] || fail "the state: $(cat "$app/recovery-check.state")"
sed -n 2p "$app/recovery-check.state" | grep -Eqx '[0-9]{8}T[0-9]{6}Z' || fail "the state: $(cat "$app/recovery-check.state")"
[ "$(running)" = "caddy " ] || fail "running: $(running)"
[ "$(files aside-*)" = "phoenix.log=original-log phoenix.mainnet.x.db=original phoenix.mainnet.x.db-wal=original-wal " ] ||
	fail "the original database moved: $(files aside-*)"
rm "$FAKE/full-at-put-back"
rmdir "$app/recovery-check.state.tmp"
run up
want_code 0
original_back
all_running
settled

echo "== the first state can't be written: nothing stopped or moved"
setup full-first
mkdir "$app/recovery-check.state.tmp"
run recovery-check 1
want_code 1
said '"reason":"the check stopped on an error (exit [0-9]*) before it began: nothing was changed'
[ "$(files)" = "$ORIGINAL" ] && [ -z "$(subdirs)" ] || fail "phoenixd's volume changed: $(files) $(subdirs)"
all_running
[ ! -f "$FAKE/docker.log" ] || ! grep -q '^stop' "$FAKE/docker.log" || fail "it stopped something: $(cat "$FAKE/docker.log")"
rmdir "$app/recovery-check.state.tmp"

echo "== a resumed state with no phase: never 'before it began'; nothing started, the files left"
setup no-phase
printf '\n20261007T000000Z\n50123\n{}\n"c0ffee"\n' >"$app/recovery-check.state"
aside phoenix.mainnet.x.db
rm "$FAKE/run/cardd" "$FAKE/run/phoenixd"
run recovery-check
want_code 1
said "phoenixd's database couldn't be settled (at ): nothing was started"
[ "$(running)" = "caddy " ] || fail "started something: $(running)"
[ "$(files aside-*)" = "phoenix.mainnet.x.db=original " ] || fail "the set-aside database moved: $(files aside-*)"

echo "== retired during the check: nothing started again, the databases left where they are"
setup retired
echo 3 >"$FAKE/retire-at"
run recovery-check 1
want_code 1
said '"reason":"this server was retired (replaced by VM 1004) during the check: nothing was started'
[ "$(running)" = "caddy " ] || fail "running: $(running)"
[ "$(files aside-*)" = "phoenix.log=original-log phoenix.mainnet.x.db=original phoenix.mainnet.x.db-wal=original-wal " ] ||
	fail "the original database moved: $(files aside-*)"
[ ! -f "$FAKE/violations" ] || fail "$(cat "$FAKE/violations")"
run up
want_code 8
run recovery-check
want_code 10
grep -q 'this server was retired' "$t/err" || fail "said '$(cat "$t/err")'"

echo PASS
