#!/bin/sh
# Runs the tests of the iPhone module's plain Swift (app/modules/card-native/swift/CardKit) on Linux, in the
# swift Docker image, its SSH layer against a throwaway OpenSSH server that trusts the test phrase's SSH key.
# Needs Docker only. Its container and port are its own, apart from sshd-test.sh's (Android's).
# Arguments go to `swift test`: sh deploy/test/ios-swift-test.sh --filter CardLogicTests
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
name=cardapp-sshd-swift-test
port=12223
# Both images by their digests, not by a tag that can come to mean another image: swift:6.3-noble as of
# 2026-10-02, and linuxserver's openssh-server as of 2026-09-20.
image=swift@sha256:cd45c27b3abc42310c33cfaf3008b18156cbdc9187834c9617e8f43a26d2675c
sshd=lscr.io/linuxserver/openssh-server@sha256:946fa26105e0ec212fdf821b9ddc59aab65f2c2d07c02b25ff0f5001fc332ff0
pkg=app/modules/card-native/swift/CardKit
pub=$(sed -n 's/.*"sshAuthorizedKey": "\([^"]*\)".*/\1/p' "$root/testvectors/vectors.json")
docker rm -f "$name" >/dev/null 2>&1 || true
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -p "127.0.0.1:$port:2222" -e PUBLIC_KEY="$pub" -e USER_NAME=debian \
	"$sshd" >/dev/null
for _ in $(seq 1 30); do
	docker exec "$name" test -s /config/ssh_host_keys/ssh_host_ed25519_key.pub 2>/dev/null && break
	sleep 1
done
sleep 2
blob=$(docker exec "$name" cut -d' ' -f2 /config/ssh_host_keys/ssh_host_ed25519_key.pub)
# As this user, so .build is not root's; HOME inside .build so SwiftPM's caches survive between runs.
mkdir -p "$root/$pkg/.build/home"
docker run --rm --network host --user "$(id -u):$(id -g)" \
	-v "$root:/repo" -w "/repo/$pkg" -e HOME="/repo/$pkg/.build/home" \
	-e CARD_SSH_TEST="127.0.0.1:$port:debian:$blob" \
	"$image" nice -n 19 ionice -c3 swift test "$@"
echo PASS
