#!/bin/sh
# Runs the real stack locally (phoenixd, cardd, Caddy with its internal CA for
# localhost, ntfy) through install.sh and cardd-ctl, under a throwaway compose
# project, then removes it. Needs Docker and internet access (phoenixd
# connects to its LSP). Run from the repo root: make deploy-test
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
export COMPOSE_PROJECT_NAME=cardapp-test HTTP_PORT=18081 HTTPS_PORT=18443 NTFY_PORT=18444
cleanup() {
	(cd "$work/card-app" 2>/dev/null && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
	rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# What the app uploads: deploy/ plus the linux binary as bin/cardd.
cp -r "$root/deploy" "$work/card-app"
rm -rf "$work/card-app/test"
mkdir -p "$work/card-app/bin"
(cd "$root/server" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$work/card-app/bin/cardd" ./cmd/cardd)
cd "$work/card-app"

SEED_A="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
SEED_B="zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"
KEY_A=866a12e42e31a09aa8ca4f25a02e999e
KEY_B=00000000000000000000000000000001

# SFTP uploads may drop the exec bit; prepare must not depend on it.
chmod -x bin/cardd
./install.sh prepare localhost
grep -qx 'CARDD_HOST=localhost' .env || fail ".env not written"
[ "$(stat -c %a .env)" = 600 ] || fail ".env is $(stat -c %a .env), want 600 (it holds ntfy's write token)"

echo "== up refuses to start phoenixd before the seed is written"
set +e
./install.sh up 2>/dev/null
code=$?
set -e
[ "$code" -eq 4 ] || fail "up without a seed exited $code, want 4"
if docker compose run --rm --no-deps -T --entrypoint test phoenixd -e /phoenix/.phoenix/seed.dat; then
	fail "phoenixd generated its own seed"
fi

echo "== seed: write, repeat, refuse a different one, reject garbage"
printf '%s\n' "$SEED_A" | ./install.sh seed || fail "first seed write"
printf '  %s  \n' "$SEED_A" | ./install.sh seed || fail "same seed again"
if printf '%s' "$SEED_B" | ./install.sh seed 2>/dev/null; then fail "a different seed was accepted"; fi
if printf 'not a seed' | ./install.sh seed 2>/dev/null; then fail "garbage seed was accepted"; fi
got=$(docker compose run --rm --no-deps -T --entrypoint cat phoenixd /phoenix/.phoenix/seed.dat)
[ "$got" = "$SEED_A" ] || fail "seed.dat is '$got'"

echo "== issuer key: write, repeat, refuse a different one"
echo "$KEY_A" | ./install.sh issuer-key || fail "first key write"
echo "$KEY_A" | ./install.sh issuer-key || fail "same key again"
set +e
echo "$KEY_B" | ./install.sh issuer-key 2>/dev/null
code=$?
set -e
[ "$code" -eq 3 ] || fail "a different key exited $code, want 3"

echo "== up: everything healthy, HTTPS through Caddy"
./install.sh up || fail "compose up --wait"
health=$(curl -fsSk --resolve localhost:18443:127.0.0.1 https://localhost:18443/health) || fail "no HTTPS health"
echo "$health" | grep -q '"ok":true' || fail "health said $health"
[ "$(docker compose run --rm --no-deps -T --entrypoint cat phoenixd /phoenix/.phoenix/seed.dat)" = "$SEED_A" ] ||
	fail "phoenixd replaced the seed on first start"

echo "== money wiring: cardd reads phoenix.conf, asks phoenixd for invoices, reconciles"
pub() { curl -fsSk --resolve localhost:18443:127.0.0.1 "https://localhost:18443$1"; }
pub /.well-known/lnurlp/pool | grep -q '"tag":"payRequest"' || fail "no pay request for pool@"
pub '/lnurlp/pool/cb?amount=1000000' | grep -q '"pr":"lnbc' || fail "cardd got no invoice from phoenixd"
i=0
while pub /health | grep -q '"alert"'; do
	i=$((i + 1))
	[ "$i" -lt 30 ] || fail "spending still paused: $(pub /health)"
	sleep 2
done
docker inspect -f '{{json .Args}}' "$(docker compose ps -q phoenixd)" | grep -q 'http://cardd:8081/phoenixd' ||
	fail "phoenixd has no webhook to cardd"
code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve localhost:18443:127.0.0.1 -X POST https://localhost:18443/phoenixd)
[ "$code" = 404 ] || [ "$code" = 405 ] || fail "the webhook is reachable through Caddy (HTTP $code)"
# cardd mounts phoenixd's volume for phoenix.conf; its user must not read the seed.
if docker compose run --rm --no-deps -T --user 65532:65532 --entrypoint cat phoenixd /phoenix/.phoenix/seed.dat >/dev/null 2>&1; then
	fail "cardd's user can read phoenixd's seed"
fi

echo "== an older stack without IPv6 comes back on the IPv6 network"
# A server installed before compose.yaml gave the stack's network IPv6 runs on one without it. Docker can't change a network in place: Update
# server's prepare must take that stack down first, and up must bring every container back on the new network.
cp compose.yaml compose.new
sed '/^networks:/,$d' compose.new >compose.yaml
docker compose down --timeout 30 >/dev/null 2>&1 || fail "down before the old stack"
docker compose up -d --wait --quiet-pull >/dev/null 2>&1 || fail "the old stack (no IPv6) didn't come up"
net=cardapp-test_default
[ "$(docker network inspect -f '{{.EnableIPv6}}' "$net")" = false ] || fail "the old stack's network already has IPv6"
mv compose.new compose.yaml
./install.sh prepare localhost || fail "prepare over a stack without IPv6"
./install.sh up || fail "up after prepare over a stack without IPv6"
[ "$(docker network inspect -f '{{.EnableIPv6}}' "$net")" = true ] || fail "the stack's network has no IPv6 after the update"
on=$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net")
for svc in phoenixd cardd caddy ntfy; do
	echo "$on" | grep -q "cardapp-test-$svc-1" || fail "$svc isn't on the new network (on it: $on)"
done
pub '/lnurlp/pool/cb?amount=1000000' | grep -q '"pr":"lnbc' || fail "cardd can't reach phoenixd after the update"

echo "== cardd-ctl: device add twice gives one device, meta round trip"
PUB=0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299
[ "$(./cardd-ctl device add -pubkey "$PUB" -name test)" = b18b86ce1389e46d ] || fail "device add"
[ "$(./cardd-ctl device add -pubkey "$PUB" -name test)" = b18b86ce1389e46d ] || fail "device add again"
[ "$(./cardd-ctl device list | wc -l)" -eq 1 ] || fail "device list"
./cardd-ctl meta set vm.id 1001
[ "$(./cardd-ctl meta get vm.id)" = 1001 ] || fail "meta get"

echo "== photos: a card's photo set, listed and read back through Caddy, signed with the test device key"
(cd "$root/server" && CARDD_STACK_URL=https://localhost:18443 go test -count=1 -run TestAStackPhotoRoundTrip ./internal/api/) >/dev/null ||
	fail "a card's photo didn't make the round trip through Caddy"

# ntfy: read-only to the world on up* topics, written only by
# cardd with its token; a down ntfy never takes the API with it.
echo "== ntfy: healthy at :8443, the hash reaching it literally, the API up without it, anonymous posts refused"
ntfy() { curl -sk --resolve localhost:18444:127.0.0.1 "$@"; }
ntfy -f https://localhost:18444/v1/health | grep -q '"healthy":true' || fail "ntfy isn't healthy at :8443: $(ntfy https://localhost:18444/v1/health)"
token=$(sed -n "s/^NTFY_CARDD_TOKEN='\(tk_[a-z0-9]\{29\}\)'\$/\1/p" .env)
hash=$(sed -n "s/^NTFY_CARDD_HASH='\(\\\$2a\\\$1[0-9]\\\$[./A-Za-z0-9]\{53\}\)'\$/\1/p" .env)
[ -n "$token" ] && [ -n "$hash" ] || fail ".env has no single-quoted ntfy token and hash: $(grep NTFY_ .env | sed 's/=.*/=…/')"
# A $ in .env that compose read as a variable would leave a mangled hash.
docker compose exec -T ntfy env | grep -qxF "NTFY_AUTH_USERS=cardd:$hash:user" || fail "ntfy didn't get .env's hash as it is"
docker compose exec -T ntfy env | grep -qxF "NTFY_AUTH_TOKENS=cardd:$token:cardd" || fail "ntfy didn't get .env's token"
docker compose exec -T ntfy env | grep -qxF "GOMEMLIMIT=48MiB" || fail "ntfy has no GOMEMLIMIT under its 64M cap"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(docker compose ps -q cardd)" | grep -qxF "CARDD_NTFY_TOKEN=$token" ||
	fail "cardd hasn't ntfy's token"
docker compose stop ntfy >/dev/null 2>&1
pub /health | grep -q '"ok":true' || fail "the API on :443 went with ntfy"
[ "$(ntfy -o /dev/null -w '%{http_code}' https://localhost:18444/v1/health)" = 502 ] || fail ":8443 with ntfy stopped isn't a 502"
docker compose start ntfy >/dev/null 2>&1
i=0
until ntfy -f https://localhost:18444/v1/health 2>/dev/null | grep -q '"healthy":true'; do
	i=$((i + 1))
	[ "$i" -lt 30 ] || fail "ntfy not healthy again 30 s after its start"
	sleep 1
done
code=$(ntfy -o /dev/null -w '%{http_code}' -d hi https://localhost:18444/upTest123456)
[ "$code" = 403 ] || fail "an anonymous post to an up topic answered HTTP $code, want 403"
code=$(ntfy -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" -d hi https://localhost:18444/other)
[ "$code" = 403 ] || fail "cardd's token posted to a topic that isn't up*: HTTP $code, want 403"
code=$(ntfy -o /dev/null -w '%{http_code}' https://localhost:18444/other/json?poll=1)
[ "$code" = 403 ] || fail "an anonymous read of a topic that isn't up* answered HTTP $code, want 403"

echo "== ntfy: a test alert cardd posts inside the stack reaches a subscriber within 2 s"
topic=upTest123456
ntfy -N "https://localhost:18444/$topic/json" >"$work/sub.out" 2>&1 &
sub=$!
i=0
until grep -q '"event":"open"' "$work/sub.out"; do
	i=$((i + 1))
	[ "$i" -lt 50 ] || fail "the subscriber never opened: $(cat "$work/sub.out")"
	sleep 0.1
done
(cd "$root/server" && CARDD_STACK_URL=https://localhost:18443 CARDD_STACK_NTFY_TOPIC=$topic go test -count=1 -run TestAStackPushNtfy ./internal/api/) >"$work/push.out" 2>&1 ||
	fail "cardd's push API didn't send a test alert through ntfy: $(cat "$work/push.out")"
i=0
until grep -q '"event":"message"' "$work/sub.out"; do
	i=$((i + 1))
	[ "$i" -lt 20 ] || fail "no message on $topic 2 s after cardd's post: $(cat "$work/sub.out")"
	sleep 0.1
done
kill "$sub" 2>/dev/null || true
grep '"event":"message"' "$work/sub.out" | grep -q '"encoding":"base64"' || fail "ntfy didn't take cardd's post as an encrypted UnifiedPush message: $(cat "$work/sub.out")"
echo "ntfy's memory after a message: $(docker stats --no-stream --format '{{.MemUsage}}' "$(docker compose ps -q ntfy)")"

echo "== send out's lookup: a signed BIP353 name, broken DNSSEC and no such name, through Google and Cloudflare"
(cd "$root/server" && CARDD_STACK_URL=https://localhost:18443 go test -count=1 -run TestAStackLookup ./internal/api/) >/dev/null ||
	fail "send out's lookup of real names"

echo "== backups: a snapshot within a minute of the recipient, encrypted to it; revoke-others"
recipient=$(sed -n 's/.*"backupAgeRecipient": "\([^"]*\)".*/\1/p' "$root/testvectors/vectors.json")
./cardd-ctl meta set backup.recipient "$recipient"
i=0
until docker compose cp cardd:/data/backups/1.age "$work/1.age" >/dev/null 2>&1; do
	i=$((i + 1))
	[ "$i" -lt 45 ] || fail "no snapshot 90 s after the recipient arrived"
	sleep 2
done
(cd "$root/server" && CARDD_BACKUP_TEST_FILE="$work/1.age" go test -count=1 -run TestAStackSnapshotDecrypts ./internal/backup/) >/dev/null ||
	fail "the stack's snapshot doesn't open with the backup key"
if ./cardd-ctl device revoke-others -keep 0000000000000000 >/dev/null 2>&1; then fail "revoke-others kept an unknown device"; fi
[ "$(./cardd-ctl device revoke-others -keep b18b86ce1389e46d)" = 0 ] || fail "revoke-others"

echo "== re-running every step is harmless"
before=$(docker compose ps -q cardd)
ntfy_before=$(docker compose ps -q ntfy)
env_before=$(grep '^NTFY_' .env)
./install.sh prepare localhost
[ "$(docker compose ps -q cardd)" = "$before" ] || fail "prepare recreated the running cardd container"
[ "$(docker inspect -f '{{.State.Running}}' "$before")" = true ] || fail "cardd stopped after prepare"
[ "$(grep '^NTFY_' .env)" = "$env_before" ] || fail "prepare changed ntfy's token or hash"
printf '%s' "$SEED_A" | ./install.sh seed
echo "$KEY_A" | ./install.sh issuer-key
./install.sh up
[ "$(docker compose ps -q ntfy)" = "$ntfy_before" ] || fail "re-running the steps recreated ntfy"
[ "$(./cardd-ctl meta get vm.id)" = 1001 ] || fail "data lost on re-run"

# The channel-recovery check. This phoenixd has no
# channel, so recovery itself isn't proved: the check must refuse, and its
# failure path (forced by the test override) must put everything back.
echo "== recovery-check: refused without a Normal channel, touching nothing"
for args in "recovery-check x" "recovery-check 0" "recovery-check 1 2"; do
	set +e
	# shellcheck disable=SC2086 # split on purpose
	./install.sh $args </dev/null 2>/dev/null
	code=$?
	set -e
	[ "$code" -eq 2 ] || fail "install.sh $args exited $code, want 2"
done
# The files' names, inodes and checksums (but phoenixd's log), and when each container started.
volume() {
	docker compose exec -T phoenixd sh -c 'cd /phoenix/.phoenix && ls -iA && find . -type f ! -name phoenix.log -exec sha256sum {} + | sort'
}
started() { docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' "$(docker compose ps -q cardd)" "$(docker compose ps -q phoenixd)"; }
vol_before=$(volume)
started_before=$(started)
set +e
out=$(./install.sh recovery-check 2>"$work/err")
code=$?
set -e
[ "$code" -eq 10 ] || fail "recovery-check without a channel exited $code, want 10"
[ -z "$out" ] || fail "recovery-check refused but printed '$out'"
grep -q 'no Normal channel to check' "$work/err" || fail "recovery-check said '$(cat "$work/err")'"
[ "$(volume)" = "$vol_before" ] || fail "recovery-check changed phoenixd's volume: $(volume)"
[ "$(started)" = "$started_before" ] || fail "recovery-check stopped or restarted a container"

echo "== recovery-check: no channel within the time, so the original database comes back"
# The new database has the same name (the seed's node id): its inode tells them apart.
db_before=$(docker compose exec -T phoenixd sh -c 'cd /phoenix/.phoenix && ls -i phoenix.mainnet.*.db')
keep_before=$(docker compose exec -T phoenixd sh -c 'cd /phoenix/.phoenix && sha256sum seed.dat phoenix.conf')
# The check's own database goes to new-<time>/ (never deleted), so leave those out.
names() { docker compose exec -T phoenixd ls -A /phoenix/.phoenix | grep -v -e '-wal$' -e '-shm$' -e '^new-'; }
names_before=$(names)
set +e
out=$(CARD_APP_RECOVERY_TEST=1 ./install.sh recovery-check 1 2>"$work/err")
code=$?
set -e
[ "$code" -eq 9 ] || fail "recovery-check with no channel coming back exited $code, want 9: $(cat "$work/err")"
echo "$out" | grep -Eqx '\{"ok":false,"reason":"[^"]+","before":\{"balanceSat":0,"channels":\[\],"channelIds":\[\]\},"at":"[0-9]{8}T[0-9]{6}Z","seconds":[0-9]+\}' ||
	fail "recovery-check printed '$out'"
[ "$(docker compose ps --status running --services | sort | tr '\n' ' ')" = "caddy cardd ntfy phoenixd " ] ||
	fail "not everything is running after the check: $(docker compose ps)"
[ "$(docker compose exec -T phoenixd sh -c 'cd /phoenix/.phoenix && ls -i phoenix.mainnet.*.db')" = "$db_before" ] ||
	fail "phoenixd's database isn't the original after a failed check"
[ "$(docker compose exec -T phoenixd sh -c 'cd /phoenix/.phoenix && sha256sum seed.dat phoenix.conf')" = "$keep_before" ] ||
	fail "the check changed seed.dat or phoenix.conf"
[ "$(names)" = "$names_before" ] || fail "phoenixd's volume after a failed check: $(names)"
pub /health | grep -q '"ok":true' || fail "no health after the check"
[ "$(./cardd-ctl meta get vm.id)" = 1001 ] || fail "cardd's data lost by the check"
db_is_original() {
	[ "$(docker compose exec -T phoenixd sh -c 'cd /phoenix/.phoenix && ls -i phoenix.mainnet.*.db')" = "$db_before" ] ||
		fail "phoenixd's database isn't the original $1"
	[ "$(names)" = "$names_before" ] || fail "phoenixd's volume $1: $(names)"
	[ "$(docker compose ps --status running --services | sort | tr '\n' ' ')" = "caddy cardd ntfy phoenixd " ] ||
		fail "not everything is running $1: $(docker compose ps)"
	pub /health | grep -q '"ok":true' || fail "no health $1"
}

echo "== recovery-check: the last start fails once the original is back: it stays (never deleted)"
set +e
out=$(CARD_APP_RECOVERY_TEST=abort ./install.sh recovery-check 1 2>"$work/err")
code=$?
set -e
[ "$code" -eq 1 ] || fail "recovery-check with its last start failing exited $code, want 1: $(cat "$work/err")"
echo "$out" | grep -q '"reason":"the check stopped on an error (exit 1): see recovery-check.log; no Normal channel within 1 min' ||
	fail "recovery-check printed '$out'"
db_is_original "after the check's last start failed"
[ "$(./install.sh recovery-check result)" = "$out" ] || fail "recovery-check result isn't the last result"

# A check in the background, at the step where phoenixd runs without its database.
check_in_background() {
	CARD_APP_RECOVERY_TEST=1 ./install.sh recovery-check 1 >"$work/bg.out" 2>"$work/bg.err" &
	bg=$!
	i=0
	until [ "$(sed -n 1p recovery-check.state 2>/dev/null)" = started ]; do
		i=$((i + 1))
		[ "$i" -lt 60 ] || fail "the check never started phoenixd without its database: $(cat recovery-check.log)"
		sleep 1
	done
}
refused_while_running() {
	set +e
	# shellcheck disable=SC2086 # split on purpose
	./install.sh $1 </dev/null >/dev/null 2>"$work/err"
	code=$?
	set -e
	[ "$code" -eq 11 ] || fail "install.sh $1 while a check runs exited $code, want 11"
	grep -q "$2" "$work/err" || fail "install.sh $1 said '$(cat "$work/err")'"
}

echo "== recovery-check: up, retire, wipe and a second check refused while one runs"
check_in_background
refused_while_running up "install.sh up: a recovery check is running"
refused_while_running "retire 1004" "install.sh retire: a recovery check is running"
refused_while_running wipe "install.sh wipe: a recovery check is running"
refused_while_running recovery-check "install.sh recovery-check: a check is running (from [0-9TZ]*, started)"
refused_while_running "recovery-check result" "a check is running"

echo "== recovery-check: killed mid-check (as by a reboot): up finishes it, the original back before cardd starts"
pkill -KILL -f 'install.sh recovery-run'
set +e
wait "$bg"
set -e
i=0
until flock -n recovery-check.lock true; do
	i=$((i + 1))
	[ "$i" -lt 60 ] || fail "the lock is still held after the check was killed"
	sleep 1
done
[ "$(sed -n 1p recovery-check.state)" = started ] || fail "no state left by the killed check"
[ "$(docker compose ps --status running --services | sort | tr '\n' ' ')" = "caddy ntfy phoenixd " ] ||
	fail "after the kill, want phoenixd running on its new database and cardd stopped: $(docker compose ps)"
# The leftover check is finished before anything else, and never on a retired server.
docker compose run --rm --no-deps -T --entrypoint sh phoenixd -c 'echo "2026-10-07T00:00:00Z 1004" >/phoenix/.phoenix/RETIRED'
set +e
./install.sh recovery-check </dev/null >/dev/null 2>"$work/err"
code=$?
set -e
[ "$code" -eq 10 ] || fail "recovery-check on a retired server exited $code, want 10"
grep -q 'this server was retired' "$work/err" || fail "recovery-check said '$(cat "$work/err")'"
set +e
./install.sh up 2>/dev/null
code=$?
set -e
[ "$code" -eq 8 ] || fail "up on a retired server with a check left exited $code, want 8"
docker compose run --rm --no-deps -T --entrypoint rm phoenixd -f /phoenix/.phoenix/RETIRED
./install.sh up 2>"$work/err" || fail "up after a killed check: $(cat "$work/err")"
grep -q 'finishing the recovery check from' "$work/err" || fail "up didn't finish the check: $(cat "$work/err")"
[ ! -e recovery-check.state ] || fail "up left the check's state"
db_is_original "after up finished a killed check"
set +e
out=$(./install.sh recovery-check result 2>/dev/null)
code=$?
set -e
[ "$code" -eq 9 ] || fail "recovery-check result after up finished the check exited $code, want 9"
echo "$out" | grep -q '"reason":"the check from [0-9TZ]* was interrupted; finishing it: no Normal channel (phoenixd: no channels, 0 sat): the original database is back"' ||
	fail "recovery-check result printed '$out'"

echo "== recovery-check: the server retired mid-check: nothing started again, the databases left; the next check finishes it"
check_in_background
docker compose run --rm --no-deps -T --entrypoint sh phoenixd -c 'echo "2026-10-07T00:00:00Z 1004" >/phoenix/.phoenix/RETIRED'
set +e
wait "$bg"
code=$?
set -e
[ "$code" -eq 1 ] || fail "a check on a server retired meanwhile exited $code, want 1: $(cat "$work/bg.err")"
grep -q '"reason":"this server was retired (replaced by VM 1004) during the check: nothing was started' "$work/bg.out" ||
	fail "recovery-check printed '$(cat "$work/bg.out")'"
[ "$(docker compose ps --status running --services | tr '\n' ' ')" = "caddy ntfy " ] ||
	fail "something runs on a retired server: $(docker compose ps)"
[ "$(docker compose run --rm --no-deps -T --entrypoint sh phoenixd -c 'cd /phoenix/.phoenix && ls -i aside-*/phoenix.mainnet.*.db | sed "s# aside-[^/]*/# #"')" = "$db_before" ] ||
	fail "the original database isn't left set aside"
docker compose run --rm --no-deps -T --entrypoint rm phoenixd -f /phoenix/.phoenix/RETIRED
set +e
out=$(./install.sh recovery-check 2>"$work/err")
code=$?
set -e
[ "$code" -eq 9 ] || fail "recovery-check finishing a check exited $code, want 9: $(cat "$work/err")"
echo "$out" | grep -q '"reason":"the check from [0-9TZ]* was interrupted; finishing it: no Normal channel (phoenixd: no channels, 0 sat): the original database is back"' ||
	fail "recovery-check printed '$out'"
db_is_original "after the next check finished it"

# Rebuild on this one stack: the old server's side (final snapshot,
# retire), then an in-place rebuild (wipe, restore). Real phoenixd has no
# channel here, so the restore ends at no_channel (its copy owes 1 sat:
# one owing nothing is set at once); recovery isn't proved.
echo "== rebuild: a final snapshot, with this phone revoked in it"
./cardd-ctl device revoke -key-id b18b86ce1389e46d
snap=$(./install.sh final-snapshot) || fail "final-snapshot"
version=$(echo "$snap" | sed -n 's/^{"version":\([0-9]*\),"created":[0-9]*}$/\1/p')
[ -n "$version" ] || fail "final-snapshot printed '$snap'"
docker compose cp "cardd:/data/backups/$version.age" "$work/final.age" >/dev/null 2>&1 || fail "no snapshot $version"
(cd "$root/server" && CARDD_BACKUP_TEST_FILE="$work/final.age" CARDD_BACKUP_TEST_PLAIN="$work/final.db" CARDD_BACKUP_TEST_OWE=1 CARDD_BACKUP_TEST_BIG=1 go test -count=1 -run TestAStackSnapshotDecrypts ./internal/backup/) >/dev/null ||
	fail "the final snapshot doesn't open with the backup key"

echo "== restore: bad arguments, and never over a database it didn't restore"
for args in "restore" "restore 04xyz" "restore $PUB" "restore $PUB 20x h 1.2.3.4" "restore $PUB 1004 vm-1004.lnvps.cloud 45.67.89.171 bad/from" \
	"restore $PUB 1004 vm-1004.lnvps.cloud 45.67.89.171 a-1-2 finally" \
	"restore-fresh" "restore-fresh $PUB 1004" "retire" "retire 20x"; do
	set +e
	# shellcheck disable=SC2086 # split on purpose
	./install.sh $args </dev/null 2>/dev/null
	code=$?
	set -e
	[ "$code" -eq 2 ] || fail "install.sh $args exited $code, want 2"
done
set +e
base64 "$work/final.db" | ./install.sh restore "$PUB" 1004 vm-1004.lnvps.cloud 45.67.89.171 2>/dev/null
code=$?
set -e
[ "$code" -eq 7 ] || fail "restore over the live database exited $code, want 7"

echo "== retire: everything stopped and removed, and up refuses"
[ "$(./install.sh retire 1004)" = retired ] || fail "retire"
[ -z "$(docker compose ps -aq)" ] || fail "containers left after retire"
marker=$(./install.sh retired) || fail "no marker after retire"
echo "$marker" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z 1004$' || fail "marker '$marker'"
set +e
msg=$(./install.sh up 2>&1)
code=$?
set -e
[ "$code" -eq 8 ] || fail "up on a retired server exited $code, want 8"
[ "$msg" = "install.sh up: this server was retired (replaced by VM 1004)" ] || fail "up said '$msg'"
[ -z "$(docker compose ps -aq)" ] || fail "up started something on a retired server"
# cardd saved the unpaid cap's state as it stopped; a retired server never reads it.
cardd=$(docker compose run --rm --no-deps -T -v cardapp-test_cardd_data:/data --entrypoint ls phoenixd -A /data | tr '\n' ' ')
case " $cardd" in *" unpaid-cap.json"*) fail "the unpaid cap's state left after retire: $cardd" ;; esac

echo "== wipe: the databases and the marker go, the seed and issuer key stay"
docker compose run --rm --no-deps -T --user 65532:65532 -v cardapp-test_cardd_data:/data --entrypoint sh phoenixd \
	-c 'echo {} >/data/unpaid-cap.json && echo {} >/data/unpaid-cap.json.tmp' || fail "seeding the cap's state"
./install.sh wipe
set +e
./install.sh retired >/dev/null
code=$?
set -e
[ "$code" -eq 1 ] || fail "retired after wipe exited $code, want 1"
phoenix=$(docker compose run --rm --no-deps -T --entrypoint ls phoenixd -A /phoenix/.phoenix | tr '\n' ' ')
[ "$phoenix" = "seed.dat " ] || fail "phoenixd's volume after wipe: $phoenix"
[ "$(docker compose run --rm --no-deps -T --entrypoint cat phoenixd /phoenix/.phoenix/seed.dat)" = "$SEED_A" ] || fail "wipe changed the seed"
cardd=$(docker compose run --rm --no-deps -T -v cardapp-test_cardd_data:/data --entrypoint ls phoenixd -A /data | tr '\n' ' ')
[ "$cardd" = "issuer.key " ] || fail "cardd's volume after wipe: $cardd"

echo "== restore: a newer schema refused, then the backup once, and up with the restore pending"
# user_version is the big-endian integer at byte 60 of an SQLite file.
cp "$work/final.db" "$work/newer.db"
printf '\000\000\003\347' | dd of="$work/newer.db" bs=1 seek=60 conv=notrunc 2>/dev/null
set +e
base64 "$work/newer.db" | ./install.sh restore "$PUB" 1004 vm-1004.lnvps.cloud 45.67.89.171 2>/dev/null
code=$?
set -e
[ "$code" -eq 6 ] || fail "restore of a newer schema exited $code, want 6"
base64 "$work/final.db" | ./install.sh restore "$PUB" 1004 vm-1004.lnvps.cloud 45.67.89.171 0123abcd-2-1759750000 final || fail "restore"
[ "$(base64 "$work/final.db" | ./install.sh restore "$PUB" 1004 vm-1004.lnvps.cloud 45.67.89.171)" = "already restored" ] || fail "restore again"
CARDD_RESTORE_CHANNEL_WAIT=10s ./install.sh up || fail "up after the restore"
[ "$(./cardd-ctl meta get restore.from)" = 0123abcd-2-1759750000 ] || fail "restore.from"
[ "$(./cardd-ctl meta get restore.final)" = 1 ] || fail "restore.final isn't set for a final snapshot"
[ "$(./cardd-ctl meta get restore.reconcile)" = pending ] || fail "restore.reconcile isn't pending"
[ "$(./cardd-ctl meta get vm.id)" = 1004 ] || fail "vm.id isn't the new VM's"
[ "$(./cardd-ctl device list)" = "$(printf 'b18b86ce1389e46d\ttest\tactive')" ] || fail "this phone wasn't re-activated: $(./cardd-ctl device list)"
# The restored copy is over 2 MB (CARDD_BACKUP_TEST_BIG): its snapshot's VACUUM needs a temporary file, and the
# container's only writable place is /data (Dockerfile.cardd's SQLITE_TMPDIR).
./cardd-ctl backup now >/dev/null || fail "no snapshot of a database over 2 MB: SQLite had nowhere for its temporary file"
pub /health | grep -q '"alert"' || fail "spending isn't paused while the restore is pending"
if out=$(./cardd-ctl ledger reconcile 2>&1); then fail "set the books while the restore is pending"; fi
echo "$out" | grep -q 'after a restore' || fail "ledger reconcile said '$out'"
# phoenixd wrote a new phoenix.conf after the wipe, and cardd reads it.
pub '/lnurlp/pool/cb?amount=1000000' | grep -q '"pr":"lnbc' || fail "cardd got no invoice from phoenixd after the wipe"

echo "== the point of sale: a PoS phone paired by a code, a sale's invoice from phoenixd (spending still paused), the phone removed"
(cd "$root/server" && CARDD_STACK_URL=https://localhost:18443 go test -count=1 -run TestAStackPoSSale ./internal/api/) >/dev/null ||
	fail "a PoS phone couldn't be paired, or make a sale, through Caddy"

echo "== no channel comes back: no_channel once CARDD_RESTORE_CHANNEL_WAIT has passed"
i=0
until [ "$(./cardd-ctl meta get restore.reconcile)" = no_channel ]; do
	i=$((i + 1))
	[ "$i" -lt 30 ] || fail "restore.reconcile still $(./cardd-ctl meta get restore.reconcile) after 2.5 minutes"
	sleep 5
done

echo "== restore-fresh: wipe the running server, then an empty database from the phrase"
./install.sh wipe
[ -z "$(docker compose ps -aq)" ] || fail "containers left after wipe"
./install.sh restore-fresh "$PUB" 1004 vm-1004.lnvps.cloud 45.67.89.171 || fail "restore-fresh"
[ "$(./install.sh restore-fresh "$PUB" 1004 vm-1004.lnvps.cloud 45.67.89.171)" = "already restored" ] || fail "restore-fresh again"
[ "$(docker compose run --rm --no-deps -T cardd meta get restore.from)" = phrase ] || fail "restore-fresh's restore.from"
[ -z "$(docker compose run --rm --no-deps -T cardd device list)" ] || fail "restore-fresh made devices"

echo "== retired: exit 9 where phoenixd has no seed (no volume, or none in it), never a guess"
retired_code() {
	set +e
	./install.sh retired >/dev/null 2>&1
	code=$?
	set -e
	[ "$code" -eq "$1" ] || fail "retired $2 exited $code, want $1"
}
retired_code 1 "with the seed, unretired"
set +e
COMPOSE_PROJECT_NAME=cardapp-none ./install.sh retired >/dev/null 2>&1
code=$?
set -e
[ "$code" -eq 9 ] || fail "retired without phoenixd's volume exited $code, want 9"
# ~/card-app gone, the volume still there: it can't look, so it isn't "no seed".
mv .env .env.kept
retired_code 1 "without .env"
mv .env.kept .env
docker compose run --rm --no-deps -T --entrypoint rm phoenixd -f /phoenix/.phoenix/seed.dat
retired_code 9 "without seed.dat"

echo "PASS"
