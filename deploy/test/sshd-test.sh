#!/bin/sh
# Runs the card-native module's JVM tests, including SshSessionsTest against a
# throwaway OpenSSH server that trusts the test phrase's SSH key.
# Needs Docker and a prebuilt app/android (npx expo prebuild -p android).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
name=cardapp-sshd-test
pub=$(sed -n 's/.*"sshAuthorizedKey": "\([^"]*\)".*/\1/p' "$root/testvectors/vectors.json")
docker rm -f "$name" >/dev/null 2>&1 || true
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -p 127.0.0.1:12222:2222 -e PUBLIC_KEY="$pub" -e USER_NAME=debian \
	lscr.io/linuxserver/openssh-server:latest >/dev/null
for _ in $(seq 1 30); do
	docker exec "$name" test -s /config/ssh_host_keys/ssh_host_ed25519_key.pub 2>/dev/null && break
	sleep 1
done
sleep 2
blob=$(docker exec "$name" cut -d' ' -f2 /config/ssh_host_keys/ssh_host_ed25519_key.pub)
cd "$root/app/android"
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
CARD_SSH_TEST="127.0.0.1:12222:debian:$blob" ./gradlew :card-native:testDebugUnitTest --console=plain -q
echo PASS
