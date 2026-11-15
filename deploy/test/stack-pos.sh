#!/bin/sh
# The point of sale's stack check alone: brings the real stack up as
# stack-test.sh does (phoenixd, cardd, Caddy, under the same throwaway compose
# project), adds the test device, runs TestAStackPoSSale against it through
# Caddy, and removes the stack. For when stack-test.sh fails at a step before
# the point of sale's (its recovery-check steps wait on the real phoenixd's
# starts and stops, which don't always come in time). It is no substitute for
# stack-test.sh passing. Needs Docker and internet access; never beside
# stack-test.sh (the same project name and ports). Run from the repo root:
# make deploy-test-pos
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

echo "== up: the stack as stack-test.sh brings it up"
./install.sh prepare localhost
printf '%s\n' "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" | ./install.sh seed || fail "seed"
echo 866a12e42e31a09aa8ca4f25a02e999e | ./install.sh issuer-key || fail "issuer key"
./install.sh up || fail "compose up --wait"
pub() { curl -fsSk --resolve localhost:18443:127.0.0.1 "https://localhost:18443$1"; }
i=0
until pub '/lnurlp/pool/cb?amount=1000000' | grep -q '"pr":"lnbc'; do
	i=$((i + 1))
	[ "$i" -lt 12 ] || fail "cardd got no invoice from phoenixd within a minute"
	sleep 5
done
PUB=0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299
[ "$(./cardd-ctl device add -pubkey "$PUB" -name test)" = b18b86ce1389e46d ] || fail "device add"

echo "== the point of sale: a PoS phone paired by a code, a sale's invoice from phoenixd, the phone removed"
(cd "$root/server" && CARDD_STACK_URL=https://localhost:18443 go test -count=1 -run TestAStackPoSSale ./internal/api/) >/dev/null ||
	fail "a PoS phone couldn't be paired, or make a sale, through Caddy"
# An owner's line is as it always was; the removed PoS phone's says what it is.
./cardd-ctl device list | grep -qx "$(printf 'b18b86ce1389e46d\ttest\tactive')" || fail "the owner's line changed: $(./cardd-ctl device list)"
./cardd-ctl device list | grep -q "$(printf '\tStack till\trevoked [0-9TZ:-]*\tpos')\$" || fail "the PoS phone's line: $(./cardd-ctl device list)"

echo "PASS"
