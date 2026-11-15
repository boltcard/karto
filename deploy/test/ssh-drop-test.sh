#!/bin/sh
# What a cut connection does to a step of the install, against a real OpenSSH server in a container: started
# plainly it is killed at its next write; started through the app's own command (app/src/onboarding/stepCommand.ts)
# it runs to its end, one at a time, and only for the latest start. The tests are the app's
# (src/onboarding/stepCommand.sshd.test.ts); this starts the server for them. Needs Docker and app/node_modules.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
name=cardapp-sshd-drop-test
port=12224
tmp=$(mktemp -d)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf -- "${tmp:?}"' EXIT
ssh-keygen -q -t ed25519 -N '' -f "$tmp/key"
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p "127.0.0.1:$port:2222" -e PUBLIC_KEY="$(cat "$tmp/key.pub")" -e USER_NAME=debian \
	lscr.io/linuxserver/openssh-server:latest >/dev/null
for _ in $(seq 1 30); do
	docker exec "$name" test -s /config/ssh_host_keys/ssh_host_ed25519_key.pub 2>/dev/null && break
	sleep 1
done
sleep 3
cd "$root/app"
CARD_SSH_DROP_TEST="127.0.0.1:$port:debian:$tmp/key" npx vitest run src/onboarding/stepCommand.sshd.test.ts
echo PASS
