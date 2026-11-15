#!/bin/sh
# The native module's check on a real iPhone: the diagnostics app's checks, against a throwaway OpenSSH server in a container on this computer,
# reached over the local network. No card, no money, no real server.
#
#   sh deploy/test/iphone-diag.sh line          prints HOST:PORT:USER:HOSTKEYBLOB, where the server will be: the
#                                               line the workflow is given as "diag:" to build the app with
#   sh deploy/test/iphone-diag.sh server PUBKEY starts the server, letting in the one key in the file PUBKEY (the
#                                               Karto-Diagnostics-login.pub that comes with the signed apps)
#   sh deploy/test/iphone-diag.sh run IPA       installs that app on the iPhone, starts it, reads its checks' lines
#                                               from the phone's log, and judges them
#   sh deploy/test/iphone-diag.sh again         starts it again without installing (after "Allow" on the phone's
#                                               question about the local network, which the first start meets)
#   sh deploy/test/iphone-diag.sh stop          removes the server
#
# Needs Docker, go-ios (`ios`) with its tunnel running (`ios tunnel start --userspace`), pymobiledevice3, and
# the iPhone plugged in, trusted and unlocked. The server's host key is kept between starts (in ~/.cache), so an
# app built for it stays good.
#
# What the server exposes, and for how long. An iPhone cannot reach this computer's loopback as Android's check
# does through adb, so the server listens on this computer's address on the local network. It lets in one key
# only: the one the build made for that diagnostics app (deploy/test/diag-login-key.sh), whose seed is in the
# app and nowhere else. Not the test phrase's key, which is in this repository. The container holds nothing
# besides: the login user has no sudo, nothing of this computer is mounted in it but its own host key, its memory
# and processes are capped, and it is removed by itself an hour after it starts. Stop it sooner with `stop`.
set -eu
name=cardapp-sshd-iphone-test
port=12225
keep="$HOME/.cache/card-app/iphone-diag"
bundle=tech.whitewolf.karto.dev
# The server's image by its digest, not by a tag that can come to mean another image: linuxserver's
# openssh-server as of 2026-09-20. It listens on the local network: what runs in it is what was looked at.
image=lscr.io/linuxserver/openssh-server@sha256:946fa26105e0ec212fdf821b9ddc59aab65f2c2d07c02b25ff0f5001fc332ff0
# The checks' lines as read from the phone: a file of this user's own, never one in a shared folder.
out=${IPHONE_DIAG_OUT:-$keep/phone.log}
# How long the server lives, in seconds.
life=${IPHONE_DIAG_LIFE:-3600}

# This computer's address on the local network: the one it would reach the internet from.
lan() {
	ip route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p'
}

# The server's host key, made here once: the image makes its own only into a folder that is not there yet, and
# this one must be the same at every start.
host_key() {
	mkdir -p "$keep/ssh_host_keys"
	[ -s "$keep/ssh_host_keys/ssh_host_ed25519_key" ] ||
		ssh-keygen -q -t ed25519 -N '' -C cardapp-iphone-diag -f "$keep/ssh_host_keys/ssh_host_ed25519_key"
	cut -d' ' -f2 "$keep/ssh_host_keys/ssh_host_ed25519_key.pub"
}

line() {
	host=$(lan)
	[ -n "$host" ] || {
		echo "iphone-diag.sh: this computer has no address on a network" >&2
		exit 1
	}
	echo "$host:$port:debian:$(host_key)"
}

# server PUBKEY: the file's one line is the only key let in.
server() {
	pub=$(cat "$1")
	printf '%s\n' "$pub" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+$' && [ "$(printf '%s\n' "$pub" | wc -l)" -eq 1 ] || {
		echo "iphone-diag.sh: $1 is not one ssh-ed25519 public key" >&2
		exit 1
	}
	where=$(line)
	host=${where%%:*}
	blob=${where##*:}
	docker rm -f "$name" >/dev/null 2>&1 || true
	docker run -d --rm --name "$name" -p "$host:$port:2222" -e PUBLIC_KEY="$pub" -e USER_NAME=debian \
		-e PUID="$(id -u)" -e PGID="$(id -g)" -v "$keep/ssh_host_keys:/config/ssh_host_keys" \
		--memory 256m --pids-limit 256 --cpus 1 \
		"$image" >/dev/null
	# Gone by itself after an hour: a clock inside the container ends it, and --rm removes it. The clock goes
	# with the container, so `stop` leaves nothing behind.
	docker exec -d "$name" sh -c "sleep $life; kill -TERM 1"
	echo "iphone-diag.sh: the test server is reachable at $host:$port from the local network for $((life / 60)) minutes (stop it sooner with: stop)" >&2
	# Up when it answers from the network with that key.
	seen=
	for _ in $(seq 1 30); do
		seen=$(ssh-keyscan -T 2 -p "$port" -t ed25519 "$host" 2>/dev/null | cut -d' ' -f3)
		[ "$seen" = "$blob" ] && break
		sleep 1
	done
	[ "$seen" = "$blob" ] || {
		echo "iphone-diag.sh: the test server did not come up at $host:$port with its host key" >&2
		exit 1
	}
	echo "$where"
}

# Starts the app, reads the phone's log until the checks are done (three minutes at most), and judges.
start_and_judge() {
	mkdir -p "$keep"
	# The one tool that shows a release build's lines; they come as 'CARDAPP-DIAG', '{…}'. Only the checks' own
	# lines are kept, not the phone's whole log, in a file nobody else can read.
	(
		umask 077
		: >"$out"
	)
	pymobiledevice3 syslog live --match CARDAPP-DIAG >>"$out" 2>/dev/null &
	log=$!
	trap 'kill "$log" 2>/dev/null || true' EXIT
	sleep 2
	ios kill "$bundle" >/dev/null 2>&1 || true
	ios launch "$bundle" >/dev/null
	waited=0
	until grep -q 'CARDAPP-DIAG-DONE' "$out" || [ "$waited" -ge 180 ]; do
		sleep 3
		waited=$((waited + 3))
	done
	sleep 1
	kill "$log" 2>/dev/null || true
	lines=$(grep -o 'CARDAPP-DIAG.*' "$out" || true)
	if [ -z "$lines" ]; then
		echo "FAIL: no CARDAPP-DIAG line in the phone's log after $waited s (is the tunnel running, the phone unlocked?)"
		exit 1
	fi
	echo "$lines"
	bad=0
	echo "$lines" | grep -q 'CARDAPP-DIAG-DONE.*"fail":0' || {
		echo "FAIL: a check failed (if the SSH ones did, allow the local network on the phone and run: again)"
		bad=1
	}
	# The check prints where the key is and passes either way: on a phone it must be the Secure Enclave.
	if echo "$lines" | grep '"name":"device-key' | grep -vq 'StrongBox: true'; then
		echo "FAIL: the phone's key is not in the Secure Enclave"
		bad=1
	fi
	echo "$lines" | grep -q '"name":"device-key-after-ssh","ok":true' || bad=1
	echo "$lines" | grep -q '"name":"nfc-sheet","ok":true' || {
		echo "FAIL: the card reader's sheet was not checked, or did not pass"
		bad=1
	}
	echo "$lines" | grep -q '"name":"ssh-upload-bundle","ok":true' || bad=1
	[ "$bad" = 0 ] || exit 1
	# What the app uploaded is what the app carries: the server program, byte for byte.
	docker exec "$name" sh -c 'sha256sum /config/card-app/bin/cardd' 2>/dev/null ||
		echo "(the server is gone, or keeps the upload elsewhere: the app's own check of it passed above)"
	echo PASS
}

case "${1:-}" in
line) line ;;
server) server "${2:?usage: iphone-diag.sh server PUBKEY}" ;;
run)
	ipa=${2:?usage: iphone-diag.sh run IPA}
	ios install --path "$ipa"
	start_and_judge
	;;
again) start_and_judge ;;
stop) docker rm -f "$name" >/dev/null 2>&1 || true ;;
*)
	sed -n '2,25p' "$0"
	exit 2
	;;
esac
