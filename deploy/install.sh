#!/bin/sh
# Installs and starts the Karto server stack. The app uploads this directory to
# ~/card-app on the VM and runs each step over SSH, in this order:
#
#   install.sh first-boot        wait for cloud-init to finish
#   install.sh swap              a 1 GiB swap file
#   install.sh docker            Docker and its compose plugin (sudo)
#   install.sh docker-setup      log caps, the docker group, weekly image prune (sudo)
#                                (install.sh system runs these four in order)
#   install.sh prepare HOST      write .env (ntfy's token kept), build cardd:local, create volumes
#   install.sh wipe              rebuild in place: keep only the seed, issuer key
#   install.sh seed              stdin: phoenixd's 12 words -> seed.dat
#   install.sh issuer-key        stdin: 32 hex chars -> cardd's issuer.key
#   install.sh restore DEVICE VMID HOST IPV4 [FROM [final]]
#                                rebuild: stdin: the database, base64; final:
#                                it is the old server's final snapshot
#   install.sh restore-fresh DEVICE VMID HOST IPV4
#                                rebuild from the phrase: an empty one
#   install.sh up                start everything and wait until healthy
#
# and on the server a rebuild replaces:
#
#   install.sh final-snapshot    a snapshot now; prints {"version":N,"created":T}
#   install.sh retire NEWVM      stop and remove everything; mark it replaced by NEWVM
#   install.sh retired           print the marker, or exit 1 if there is none
#                                (9 if there is no phoenixd seed here at all)
#
# and once, before a rebuild relies on it:
#
#   install.sh recovery-check [MINUTES]   does a phoenixd without its database
#                                get its channel back from ACINQ? prints JSON
#   install.sh recovery-check result      the last check's JSON, once it has ended
#
# Every step can be re-run. seed and issuer-key never replace a different
# value (both exit 3 if one is there): funds and every programmed card depend
# on them. restore exits 6 for a backup from a newer cardd and 7 if a database
# it didn't restore is there. up exits 4 if the seed has not been written, and
# 8 on a retired server. retired exits 9 on a server that can't run phoenixd
# on the phrase's seed: never installed, or re-installed through LNVPS.
#
# recovery-check's codes are its own: 0 the channel came back; 9 it didn't
# come back as it was (the JSON says which database is kept); 10 refused,
# touching nothing (no Normal channel, a payment in progress, a retired
# server); 11 a check (or up, retire or wipe) is running; 1 it stopped on an
# error, or found a database set aside it can't account for. up, retire and
# wipe exit 11 while a check runs, and up first finishes a check a reboot cut
# short.
set -eu
cd "$(dirname "$0")"

# The docker group only applies to new logins, so fall back to sudo.
if docker info >/dev/null 2>&1; then DOCKER=docker; else DOCKER="sudo docker"; fi
compose() { $DOCKER compose "$@"; }

# A new VM's cloud-init may still be running apt when we log in: wait for it,
# and give apt-get up to 10 minutes for the dpkg lock (unattended-upgrades).
apt_get() { sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 "$@"; }

# The system's part of an install: four commands, so the app can tick each
# and time it. Each is safe to re-run. No function here may be named docker: command -v
# docker and docker info would find it and Docker would never be installed.
wait_boot() {
	if command -v cloud-init >/dev/null; then
		# Exit 1 or 2 means cloud-init finished with errors; it has still finished.
		cloud-init status --wait >/dev/null || true
	fi
}

add_swap() {
	# 1 GiB swap: the containers' memory limits add up to more than the VM's RAM.
	# Read /proc/swaps, not swapon: over SSH /usr/sbin is not on PATH. A swap
	# file in use can't be made again ("Text file busy"), so only make a missing one.
	swapfile=${CARD_APP_SWAPFILE:-/swapfile}
	if ! grep -q "^$swapfile " "${CARD_APP_SWAPS:-/proc/swaps}"; then
		if [ ! -f "$swapfile" ]; then
			# Made aside and moved in once it is a swap file: a run that dies halfway
			# leaves only "$swapfile.new", which the next run makes again.
			sudo rm -f "$swapfile.new"
			sudo fallocate -l 1G "$swapfile.new"
			sudo chmod 600 "$swapfile.new"
			sudo mkswap -q "$swapfile.new"
			sudo mv "$swapfile.new" "$swapfile"
		fi
		sudo swapon "$swapfile"
	fi
	grep -q "^$swapfile " /etc/fstab || echo "$swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
}

install_docker() {
	if ! command -v docker >/dev/null; then
		apt_get update -qq
		apt_get install -y -qq ca-certificates curl >/dev/null
		sudo install -m 0755 -d /etc/apt/keyrings
		sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
		sudo chmod a+r /etc/apt/keyrings/docker.asc
		# shellcheck disable=SC1091 # os-release exists on the VM, not here
		echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
			sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
		apt_get update -qq
		apt_get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
	fi
}

setup_docker() {
	sudo usermod -aG docker "$(id -un)"
	# Cap container logs at 3 x 10 MB (Docker keeps them forever by default).
	want='{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}'
	if [ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$want" ]; then
		echo "$want" | sudo tee /etc/docker/daemon.json >/dev/null
		sudo systemctl restart docker
	fi
	sudo tee /etc/systemd/system/docker-image-prune.service >/dev/null <<'UNIT'
[Unit]
Description=Remove Docker images no container uses
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker image prune --all --force
UNIT
	sudo tee /etc/systemd/system/docker-image-prune.timer >/dev/null <<'UNIT'
[Unit]
Description=Weekly Docker image cleanup

[Timer]
OnCalendar=weekly
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
	sudo systemctl daemon-reload
	sudo systemctl enable --now docker-image-prune.timer >/dev/null 2>&1
}

system() {
	wait_boot
	add_swap
	install_docker
	setup_docker
}

prepare() {
	host=${1:?usage: install.sh prepare HOST}
	ipv6_network
	write_env "$host"
	ctx=$(mktemp -d)
	trap 'rm -rf "$ctx"' EXIT
	# install, not cp: an SFTP upload may have dropped the exec bit.
	install -m 0755 bin/cardd "$ctx/cardd"
	cp /etc/ssl/certs/ca-certificates.crt "$ctx/"
	mkdir "$ctx/data"
	# docker build makes a new image ID even from identical inputs, which
	# would make compose recreate cardd, so build only when the inputs change.
	sum=$(cat "$ctx/cardd" "$ctx/ca-certificates.crt" Dockerfile.cardd | sha256sum | cut -d' ' -f1)
	if [ "$($DOCKER image inspect -f '{{index .Config.Labels "card-app.inputs"}}' cardd:local 2>/dev/null)" != "$sum" ]; then
		$DOCKER build -q --label "card-app.inputs=$sum" -t cardd:local -f Dockerfile.cardd "$ctx" >/dev/null
	fi
	# --no-recreate: a running stack is only ever replaced by `up`.
	compose create --quiet-pull --no-recreate
}

# A server installed before compose.yaml gave the stack's network IPv6 runs
# on one without it. Docker can't
# change a network in place: the first compose command with the new
# compose.yaml (a run or create below) fails with "network ... has active
# endpoints", and up wouldn't move the containers whose images are the same.
# So that stack is taken down first (never -v: the volumes stay), once; up
# brings it back on the new network. Named as need_seed names the project:
# compose config needs .env, which a fresh install doesn't have yet.
ipv6_network() {
	net="${COMPOSE_PROJECT_NAME:-card-app}_default"
	if [ "$($DOCKER network inspect -f '{{.EnableIPv6}}' "$net" 2>/dev/null)" = false ]; then
		echo "install.sh prepare: the stack's network has no IPv6; taking the stack down to make it again" >&2
		compose down --timeout 60
	fi
}

# .env: the hostname, and cardd's ntfy token and its user's password hash,
# made once and kept on every re-run (Update server runs
# prepare again), so ntfy and cardd keep agreeing. Both are single-quoted:
# compose would read the hash's $2a$10$... as variables, and ntfy exits on
# a mangled hash. The password itself is random and kept nowhere: cardd
# posts with the token.
write_env() {
	token=$(env_value NTFY_CARDD_TOKEN)
	hash=$(env_value NTFY_CARDD_HASH)
	[ -n "$token" ] || token=tk_$(random_chars 29)
	put_env "$1" "$token" "$hash"
	[ -z "$hash" ] || return 0
	# ntfy's own bcrypt (cost 10), from its image, which asks twice on stdin;
	# compose needs the .env above to run it.
	pw=$(random_chars 32)
	hash=$(printf '%s\n%s\n' "$pw" "$pw" | compose run --rm --no-deps -T --quiet-pull ntfy user hash 2>.env.err) || true
	# The whole bcrypt shape, as the stack test reads it: $2a$10$ and 53 more.
	# shellcheck disable=SC2016 # a regular expression, not a variable
	if [ "${#hash}" -ne 60 ] || ! printf '%s\n' "$hash" | grep -Eqx '\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}'; then
		echo "install.sh prepare: ntfy made no password hash: $(cat .env.err)" >&2
		exit 1
	fi
	rm -f .env.err
	put_env "$1" "$token" "$hash"
}

# 0600: the token lets anyone post to the phones' topics.
put_env() {
	(umask 077 && printf "CARDD_HOST=%s\nNTFY_CARDD_TOKEN='%s'\nNTFY_CARDD_HASH='%s'\n" "$1" "$2" "$3" >.env.new)
	chmod 600 .env.new
	mv .env.new .env
}

# The value of NAME in .env, without its single quotes; empty if there is none.
env_value() {
	[ -f .env ] || return 0
	sed -n "s/^$1='\\(.*\\)'\$/\\1/p" .env
}

random_chars() {
	LC_ALL=C tr -dc a-z0-9 </dev/urandom | head -c "$1"
}

seed() {
	words=$(tr -s ' \t\n' '   ' | sed 's/^ //; s/ $//')
	if ! printf '%s' "$words" | grep -Eq '^[a-z]+( [a-z]+){11}$'; then
		echo "install.sh seed: expected 12 lower-case words on stdin" >&2
		exit 2
	fi
	# shellcheck disable=SC2016 # the script runs inside the container
	printf '%s' "$words" | compose run --rm --no-deps -T --entrypoint sh phoenixd -c '
		f=/phoenix/.phoenix/seed.dat
		new=$(cat)
		if [ -f "$f" ]; then
			[ "$(cat "$f")" = "$new" ] && exit 0
			echo "install.sh seed: phoenixd already has a different seed; refusing to replace it" >&2
			exit 3
		fi
		umask 077
		printf "%s" "$new" >"$f.tmp" && mv "$f.tmp" "$f"'
}

issuer_key() {
	compose run --rm --no-deps -T cardd keyfile write -path /data/issuer.key
}

# DEVICE is the restoring phone's public key (hex), which cardd re-activates;
# VMID, HOST and IPV4 are the new VM's, which cardd writes before it first
# starts, so its first snapshot names this VM.
restore() {
	check_device "${1:-}"
	check_vm "${2:-}" "${3:-}" "${4:-}"
	from=${5:-}
	case $from in *[!0-9A-Za-z._-]*)
		echo "install.sh restore: FROM is a backup's name, such as <install id>-<version>-<created>" >&2
		exit 2
		;;
	esac
	case ${6:-} in
	'') final= ;;
	final) final=-final ;;
	*)
		echo "install.sh restore: the word after FROM is final or nothing" >&2
		exit 2
		;;
	esac
	# The phone's SSH stdin is text. cardd's exit code (6 or 7) is ours.
	base64 -d | compose run --rm --no-deps -T cardd restore -db /data/cardd.db -device "$1" \
		-vm-id "$2" -vm-host "$3" -vm-ipv4 "$4" ${from:+-from "$from"} $final
}

restore_fresh() {
	check_device "${1:-}"
	check_vm "${2:-}" "${3:-}" "${4:-}"
	compose run --rm --no-deps -T cardd restore -db /data/cardd.db -device "$1" \
		-vm-id "$2" -vm-host "$3" -vm-ipv4 "$4" -fresh </dev/null
}

check_device() {
	case $1 in '' | *[!0-9A-Fa-f]*)
		echo "install.sh: DEVICE is the phone's public key in hex" >&2
		exit 2
		;;
	esac
}

# VMID HOST IPV4: the new VM as LNVPS names it, such as 1004 vm-1004.lnvps.cloud 45.67.89.171.
check_vm() {
	case $1 in '' | *[!0-9]*) vm_usage ;; esac
	case $2 in '' | *[!a-z0-9.-]*) vm_usage ;; esac
	case $3 in '' | *[!0-9.]*) vm_usage ;; esac
}

vm_usage() {
	echo "usage: install.sh restore DEVICE VMID HOST IPV4 [FROM [final]] | restore-fresh DEVICE VMID HOST IPV4 (the new VM's id, hostname and IPv4 address)" >&2
	exit 2
}

final_snapshot() {
	./cardd-ctl backup now
}

# A server a rebuild replaced must never run phoenixd again: two on one seed
# can close the channel. Stopped isn't enough (LNVPS starts its VMs when a
# host boots, and Docker then restarts stopped containers), so the containers
# go, and a marker in phoenixd's volume, beside the seed, makes up refuse.
retire() {
	vm=${1:-}
	case $vm in '' | *[!0-9]*)
		echo "usage: install.sh retire NEWVM (the id of the VM that replaces this one)" >&2
		exit 2
		;;
	esac
	lock_out_check retire
	# Gracefully: phoenixd hands ACINQ its last channel state as it stops.
	compose down --timeout 60
	# shellcheck disable=SC2016 # the script runs inside the container
	printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$vm" | compose run --rm --no-deps -T --entrypoint sh phoenixd -c '
		f=/phoenix/.phoenix/RETIRED
		cat >"$f.tmp" && mv "$f.tmp" "$f"'
	# cardd saved the unpaid cap's state (payers' addresses) as it stopped,
	# for a next start that never comes here.
	vol=$(cardd_volume)
	if [ -n "$vol" ]; then
		compose run --rm --no-deps -T --user 65532:65532 -v "$vol:/data" --entrypoint rm phoenixd \
			-f /data/unpaid-cap.json /data/unpaid-cap.json.tmp
	fi
	echo retired
}

# cardd's volume, by the project's own name (a volume given to compose run is
# a global name), or nothing when there is none. cardd's image has no shell,
# so phoenixd's image deletes cardd's files in it.
cardd_volume() {
	project=$(compose config | sed -n 's/^name: //p' | head -n 1)
	[ -n "$project" ] || return 0
	if $DOCKER volume inspect "${project}_cardd_data" >/dev/null 2>&1; then
		echo "${project}_cardd_data"
	fi
}

# The marker, "<UTC time> <new VM id>", or nothing.
marker() {
	compose run --rm --no-deps -T --entrypoint sh phoenixd -c 'cat /phoenix/.phoenix/RETIRED 2>/dev/null || true'
}

no_seed() {
	echo "install.sh: no phoenixd seed here ($1)" >&2
	exit 9
}

# Exits 9 unless phoenixd's seed is here: no Docker, no phoenixd volume, or no
# seed.dat in it. Anything it can't tell (Docker not answering, or the volume
# there without the stack's files to look in it) exits otherwise, so it is
# never taken for a server without a seed.
need_seed() {
	command -v docker >/dev/null || no_seed "no Docker"
	# By the project's fixed name (compose.yaml's, or the test's): ~/card-app may be gone.
	vol="${COMPOSE_PROJECT_NAME:-card-app}_phoenix_data"
	vols=$($DOCKER volume ls -q)
	printf '%s\n' "$vols" | grep -qx "$vol" || no_seed "no volume $vol"
	if [ ! -f .env ] || [ ! -f compose.yaml ]; then
		echo "install.sh: phoenixd's volume is here, but not the stack's files to look in it" >&2
		exit 1
	fi
	seed=$(compose run --rm --no-deps -T --entrypoint sh phoenixd -c 'if [ -s /phoenix/.phoenix/seed.dat ]; then echo yes; else echo no; fi')
	[ "$seed" != no ] || no_seed "no seed.dat"
}

retired() {
	need_seed
	m=$(marker)
	[ -n "$m" ] || exit 1
	echo "$m"
}

# An in-place rebuild starts from the seed and issuer key alone. Run after
# prepare, which installs Docker and writes .env.
wipe() {
	lock_out_check wipe
	compose down --timeout 60
	vol=$(cardd_volume)
	if [ -z "$vol" ]; then
		echo "install.sh wipe: no cardd volume; run prepare first" >&2
		exit 1
	fi
	compose run --rm --no-deps -T --user 65532:65532 -v "$vol:/data" --entrypoint rm phoenixd \
		-rf /data/cardd.db /data/cardd.db-wal /data/cardd.db-shm /data/backups /data/rates.json \
		/data/unpaid-cap.json /data/unpaid-cap.json.tmp
	# Everything of phoenixd's but its seed, the marker included.
	compose run --rm --no-deps -T --entrypoint find phoenixd /phoenix/.phoenix \
		-mindepth 1 -maxdepth 1 ! -name seed.dat -exec rm -rf {} +
	# A recovery check's directories went with it.
	rm -f recovery-check.state
}

up() {
	lock_out_check up
	m=$(marker)
	if [ -n "$m" ]; then
		echo "install.sh up: this server was retired (replaced by VM ${m##* })" >&2
		exit 8
	fi
	# phoenixd makes its own random seed if it starts without one, and funds
	# under that seed could not be recovered from the phrase.
	if ! compose run --rm --no-deps -T --entrypoint test phoenixd -s /phoenix/.phoenix/seed.dat; then
		echo "install.sh up: no phoenixd seed yet; run install.sh seed first" >&2
		exit 4
	fi
	if recovery_pending; then recovery_up; fi
	compose up -d --wait --quiet-pull
}

# The recovery check: a phoenixd started from the
# seed alone must get its channel back from ACINQ (peer storage) before any
# rebuild relies on that. This server keeps its seed and phoenix.conf; only
# phoenixd's database is set aside, inside its volume, and it comes back if
# no channel does: a channel that never came up made no updates, so the
# set-aside database is still the current one. Nothing in phoenixd's volume
# is ever deleted: the database the check made goes to new-<time>/, an
# original that can't be put back any more to stale-<time>/.
recovery_check() {
	if [ "${1:-}" = result ] && [ $# -eq 1 ]; then recovery_result; fi
	minutes=${1:-15}
	case $minutes in 0* | *[!0-9]*) minutes= ;; esac
	if [ $# -gt 1 ] || [ -z "$minutes" ]; then
		echo "usage: install.sh recovery-check [MINUTES] (how long to wait for the channel, 15 by default) | recovery-check result" >&2
		exit 2
	fi
	# One check at a time, never beside up, retire or wipe. The detached part inherits the lock.
	exec 9>recovery-check.lock
	flock -n 9 || recovery_busy
	m=$(marker)
	[ -z "$m" ] || recovery_refuse "this server was retired (replaced by VM ${m##* })"
	# A check a reboot or a kill cut short is finished first, by the same rules.
	if recovery_pending; then recovery_detach resume; fi
	phoenix_read
	# CARD_APP_RECOVERY_TEST: the stack test's phoenixd has no channel, but the failure paths are worth proving.
	if [ -z "${CARD_APP_RECOVERY_TEST:-}" ] && ! has_normal; then
		recovery_refuse "no Normal channel to check (phoenixd: $seen)"
	fi
	# A payment that ended against the new database would make the books drift.
	if ! holds=$(compose exec -T cardd /cardd ledger holds 2>/dev/null); then
		recovery_refuse "cardd didn't answer cardd ledger holds, so a payment may be in progress (is cardd running, and updated?)"
	fi
	[ -z "$holds" ] || recovery_refuse "a payment is in progress (cardd ledger holds): try again once it has settled"
	recovery_detach "$minutes" "$balance" "$side" "$chans"
}

recovery_refuse() {
	echo "install.sh recovery-check: $1" >&2
	exit 10
}

recovery_busy() {
	if [ -f recovery-check.state ]; then
		echo "install.sh recovery-check: a check is running (from $(sed -n 2p recovery-check.state), $(sed -n 1p recovery-check.state)): install.sh recovery-check result prints its result once it ends" >&2
	else
		echo "install.sh recovery-check: another install.sh step (up, retire or wipe) is running" >&2
	fi
	exit 11
}

# up, retire and wipe never run beside a recovery check, which stops and starts phoenixd itself.
lock_out_check() {
	exec 9>recovery-check.lock
	if ! flock -n 9; then
		echo "install.sh $1: a recovery check is running (install.sh recovery-check result prints its result once it ends)" >&2
		exit 11
	fi
}

# The rest runs in its own session, logging to a file, so a dropped SSH
# session can't stop it half done. Its result is ours.
recovery_detach() {
	rm -f recovery-check.out
	echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) recovery-check $1" >>recovery-check.log
	setsid -w sh ./install.sh recovery-run "$@" </dev/null >/dev/null 2>>recovery-check.log &
	wait $! || true
	if [ ! -s recovery-check.out ]; then
		echo "install.sh recovery-check: the check stopped without a result: see ~/card-app/recovery-check.log" >&2
		exit 1
	fi
	recovery_print
}

# The last check's JSON line, and its exit code as ours.
recovery_print() {
	sed -n 2p recovery-check.out
	exit "$(sed -n 1p recovery-check.out)"
}

# install.sh recovery-check result: the last check's result, once it has ended (11 while it runs).
recovery_result() {
	exec 9>recovery-check.lock
	flock -n 9 || recovery_busy
	if [ -f recovery-check.state ]; then
		echo "install.sh recovery-check: the check from $(sed -n 2p recovery-check.state) was cut short: install.sh recovery-check or up finishes it" >&2
		exit 1
	fi
	if [ ! -s recovery-check.out ]; then
		echo "install.sh recovery-check: no check has ended here" >&2
		exit 1
	fi
	recovery_print
}

# Whether a check was cut short (a reboot, a kill): its state file is here. A
# database set aside without one can't be finished safely by rule: refused.
recovery_pending() {
	[ ! -f recovery-check.state ] || return 0
	asides=$(in_phoenix 'ls -d aside-* 2>/dev/null || true' | tr '\n' ' ')
	[ -n "$asides" ] || return 1
	echo "install.sh: phoenixd's database is set aside in ${asides% } with no record of the check: see deploy/README.md" >&2
	exit 1
}

# The check's state, beside this script: its phase, written before the step
# it names, and what finishing it needs (the time it started, the balance,
# its JSON and the channel ids before). Phases: stopping, moving, aside,
# started (phoenixd runs without its database), normal (its channel came back
# there), clearing and returning (putting the original back), back or kept.
# Non-zero, with the state and $phase as they were, if it can't be written
# (a full disk): every caller stops there.
state() {
	printf '%s\n' "$1" "$at" "$want" "$before" "$chans0" >recovery-check.state.tmp &&
		mv recovery-check.state.tmp recovery-check.state && sync && phase=$1
}

state_load() {
	at=$(sed -n 2p recovery-check.state)
	want=$(sed -n 3p recovery-check.state)
	before=$(sed -n 4p recovery-check.state)
	chans0=$(sed -n 5p recovery-check.state)
	case $at in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *)
		echo "install.sh: recovery-check.state is damaged: see deploy/README.md" >&2
		exit 1
		;;
	esac
	case $want in '' | *[!0-9]*) want=0 ;; esac
	phase=$(sed -n 1p recovery-check.state)
	aside=aside-$at
}

# phoenixd's channel states ($states, e.g. "Normal","Offline"), their ids
# ($chans), its balance in sat ($balance, empty if it didn't answer), all as
# JSON ($side), and for people ($seen).
phoenix_read() {
	info=$(compose exec -T phoenixd /phoenix/phoenix-cli getinfo 2>/dev/null | tr -d ' \t\r\n')
	# phoenix-cli exits 0 even when phoenixd doesn't answer.
	balance=$(compose exec -T phoenixd /phoenix/phoenix-cli getbalance 2>/dev/null | tr -d ' \t\r\n' |
		sed -n 's/^{"balanceSat":\([0-9]*\),.*/\1/p')
	case $info in *'"nodeId":'*) ;; *) balance= ;; esac
	states=$(printf '%s' "$info" | grep -o '"state":"[A-Za-z]*"' | sed 's/^"state"://' | paste -sd, -)
	chans=$(printf '%s' "$info" | grep -o '"channelId":"[0-9A-Fa-f]*"' | sed 's/^"channelId"://' | sort | paste -sd, -)
	side="{\"balanceSat\":${balance:-0},\"channels\":[$states],\"channelIds\":[$chans]}"
	if [ -n "$balance" ]; then
		seen="$(printf '%s' "${states:-no channels}" | tr -d '"'), $balance sat"
	else
		seen="not answering"
	fi
}

has_normal() {
	[ -n "$balance" ] || return 1
	case ",$states," in *',"Normal",'*) return 0 ;; esac
	return 1
}

phoenixd_running() { [ -n "$(compose ps -q --status running phoenixd)" ]; }

# A command in phoenixd's volume, from a one-off container of its image.
in_phoenix() {
	compose run --rm --no-deps -T --entrypoint sh phoenixd -c "cd /phoenix/.phoenix && $1"
}

# phoenixd's database and logs: all but the seed, phoenix.conf, the marker and the checks' directories.
DB_FILES='find . -mindepth 1 -maxdepth 1 ! -name seed.dat ! -name phoenix.conf ! -name RETIRED ! -name "aside-*" ! -name "stale-*" ! -name "new-*"'

log() { echo "$(date -u +%H:%M:%S) $*" >&2; }

# recovery-check's detached part (see recovery_check), with "resume" or
# MINUTES WANT BEFORE CHANS: the balance before, its JSON and the channel ids.
# stderr is recovery-check.log.
recovery_run() {
	t0=$(date +%s)
	phase='' minutes='' note='' why='' seen='' got='' got_side='' got_chans='' resumed=''
	# A damaged state stops here, before anything is touched.
	if [ "$1" = resume ]; then state_load; fi
	trap recovery_abort EXIT
	# A signal (the VM shutting down) runs it too.
	trap 'exit 1' HUP INT TERM
	if [ "$1" = resume ]; then
		resumed=1 note="the check from $at was interrupted; finishing it: "
		log "finishing the check from $at (it stopped at $phase)"
		recovery_settle
		recovery_outcome
		recovery_end
	fi
	minutes=$1 want=$2 before=$3 chans0=$4
	at=$(date -u +%Y%m%dT%H%M%SZ)
	aside=aside-$at
	state stopping
	log "stopping cardd and phoenixd"
	# Gracefully: phoenixd hands ACINQ its last channel state as it stops.
	compose stop --timeout 60 cardd phoenixd
	# A payment that began since the first look kept its hold as cardd stopped.
	holds=$(compose run --rm --no-deps -T cardd ledger holds)
	if [ -n "$holds" ]; then
		state back
		code=10 reason="a payment started as the check began (cardd ledger holds): nothing was changed"
		recovery_end
	fi
	state moving
	log "moving phoenixd's database into $aside"
	in_phoenix "mkdir $aside && $DB_FILES -exec mv {} $aside/ \; && [ -z \"\$($DB_FILES)\" ]"
	state aside
	not_retired
	state started
	log "starting phoenixd without it; waiting up to $minutes min for a Normal channel"
	compose up -d phoenixd
	recovery_wait $((minutes * 60))
	recovery_settle
	recovery_outcome
	recovery_end
}

# Reads phoenixd every 10 s for up to SECONDS, until its channel is Normal
# with the balance and the channel from before.
recovery_wait() {
	deadline=$(($(date +%s) + $1))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		sleep 10
		phoenix_read
		log "phoenixd: $seen"
		has_normal || continue
		saw_normal || return 1
		if same; then return 0; fi
	done
	return 0
}

# phoenixd's new database is in step with ACINQ from here on: the set-aside
# one may be behind it, so it is never put back.
saw_normal() {
	[ "$phase" = normal ] || state normal || return 1
	got=$balance got_side=$side got_chans=$chans
}

# The same channel, with the same balance (to 1 sat).
same() {
	[ -n "$got" ] || return 1
	d=$((got - want))
	[ "$d" -ge -1 ] && [ "$d" -le 1 ] && [ "$got_chans" = "$chans0" ]
}

# Brings phoenixd's volume to one database: the new one kept (phase kept)
# or the original put back (phase back). Non-zero if it can't.
recovery_settle() {
	not_retired || return 1
	case $phase in
	stopping)
		why="nothing had moved yet"
		state back || return 1
		;;
	moving | aside)
		why="phoenixd never started without its database"
		put_back || return 1
		;;
	started | normal)
		if [ -n "$resumed" ]; then
			# phoenixd may have stopped, or restarted with the VM, since: look again.
			if ! phoenixd_running; then compose up -d phoenixd || return 1; fi
			recovery_answer || return 1
		fi
		if [ "$phase" = started ]; then
			# The last look, just before phoenixd stops: a channel that came back since the last one is kept.
			phoenix_read
			log "phoenixd: $seen (the last look)"
			if has_normal; then saw_normal || return 1; fi
		fi
		if [ "$phase" = normal ]; then
			keep || return 1
		else
			why="no Normal channel${minutes:+ within $minutes min} (phoenixd: $seen)"
			put_back || return 1
		fi
		;;
	clearing | returning) put_back || return 1 ;;
	back | kept) ;;
	*)
		log "unknown phase '$phase'"
		return 1
		;;
	esac
}

# Waits up to 2 minutes for phoenixd to answer, noting a Normal channel.
recovery_answer() {
	i=0
	phoenix_read
	while [ -z "$balance" ] && [ "$i" -lt 12 ]; do
		sleep 10
		phoenix_read
		i=$((i + 1))
	done
	log "phoenixd: $seen"
	if has_normal; then saw_normal || return 1; fi
	return 0
}

# The original database back: the check's files moved out to new-<at>/,
# then the set-aside ones moved back exactly as they were. Each step acts
# only while aside-<at>/ is there, checks it emptied its source, and is done
# again from its phase if it was cut short.
put_back() {
	[ -n "$at" ] || return 1
	log "putting phoenixd's original database back"
	compose stop --timeout 60 phoenixd || return 1
	if [ "$phase" = started ] || [ "$phase" = clearing ]; then
		state clearing || return 1
		in_phoenix "if [ -d $aside ]; then mkdir -p new-$at && $DB_FILES -exec mv {} new-$at/ \; && [ -z \"\$($DB_FILES)\" ]; fi" || return 1
	fi
	state returning || return 1
	# -n: never over a file of the same name; that file stays in aside-<at>/ and the check fails.
	in_phoenix "if [ -d $aside ]; then find $aside -mindepth 1 -maxdepth 1 -exec mv -n {} . \; && [ -z \"\$(ls -A $aside)\" ] && rmdir $aside; fi" || return 1
	state back || return 1
}

# The new database kept; the original renamed stale-<at>/, never to be put back.
keep() {
	[ -n "$at" ] || return 1
	log "the channel is back on the new database; the old one goes to stale-$at"
	in_phoenix "if [ -d $aside ]; then mv -T $aside stale-$at; fi" || return 1
	state kept || return 1
}

# On a retired server nothing starts again (two phoenixd on one seed can
# close the channel), and phoenixd's files stay where they are. Non-zero if
# it can't tell.
not_retired() {
	m=$(marker) || return 1
	[ -n "$m" ] || return 0
	trap - EXIT
	compose stop --timeout 60 cardd phoenixd || true
	code=1 reason="this server was retired (replaced by VM ${m##* }) during the check: nothing was started, and phoenixd's database is left as it is (at $phase: see deploy/README.md)"
	recovery_record
	exit 1
}

# The check's exit code and reason, once phoenixd's database is settled.
recovery_outcome() {
	code=9
	if [ "$phase" = back ]; then
		reason="$note${why:+$why: }the original database is back"
		return 0
	fi
	kept="the new database is kept, the old one is in stale-$at"
	if [ -z "$got" ]; then
		reason="${note}a Normal channel came back before the check was cut short: $kept"
	elif same; then
		code=0 reason="${note}the channel is back"
	elif [ "$got_chans" != "$chans0" ]; then
		reason="${note}another channel came back ($(echo "$got_chans" | tr -d '"'), not $(echo "$chans0" | tr -d '"')): $kept"
	else
		reason="${note}the channel came back with $got sat, not $want: $kept"
	fi
}

# Everything started again, then the result.
recovery_end() {
	if [ "${CARD_APP_RECOVERY_TEST:-}" = abort ]; then
		log "CARD_APP_RECOVERY_TEST=abort: the last start fails"
		exit 1
	fi
	not_retired
	compose up -d --wait
	trap - EXIT
	recovery_record
	rm -f recovery-check.state
	exit "$code"
}

# The result in recovery-check.out: the exit code, then the JSON line.
recovery_record() {
	after=
	if [ "$phase" = kept ] && [ -n "$got_side" ]; then after=",\"after\":$got_side"; fi
	s=$(($(date +%s) - t0))
	if [ "$code" -eq 0 ]; then
		json=$(printf '{"ok":true,"before":%s%s,"at":"%s","seconds":%d}' "$before" "$after" "$at" "$s")
	else
		json=$(printf '{"ok":false,"reason":"%s","before":%s%s,"at":"%s","seconds":%d}' "$reason" "$before" "$after" "$at" "$s")
	fi
	log "$reason"
	printf '%s\n%s\n' "$code" "$json" >recovery-check.out.tmp
	mv recovery-check.out.tmp recovery-check.out
}

# Any other failure still leaves the server running on one database, or, if
# the database can't be settled, nothing started.
recovery_abort() {
	err=$?
	trap - EXIT
	# A second signal mustn't cut the putting back short.
	trap '' HUP INT TERM
	set +e
	log "stopped by an error (exit $err) at ${phase:-the start}"
	if [ -z "$phase" ] && [ -z "$resumed" ]; then
		# A new check whose first state couldn't be written: nothing was stopped or moved.
		code=1 reason="the check stopped on an error (exit $err) before it began: nothing was changed; see recovery-check.log"
		recovery_record
	elif recovery_settle; then
		recovery_outcome
		code=1 reason="the check stopped on an error (exit $err): see recovery-check.log; $reason"
		not_retired && compose up -d --wait
		recovery_record
		rm -f recovery-check.state
	else
		code=1 reason="the check stopped on an error (exit $err) and phoenixd's database couldn't be settled (at $phase): nothing was started; see recovery-check.log and deploy/README.md"
		recovery_record
	fi
	exit 1
}

# up's part: a check cut short is finished before anything starts, so cardd
# never runs on phoenixd's new database while the original is set aside.
recovery_up() {
	t0=$(date +%s)
	phase='' minutes='' why='' seen='' got='' got_side='' got_chans=''
	state_load
	resumed=1 note="the check from $at was interrupted; finishing it: "
	log "install.sh up: finishing the recovery check from $at (it stopped at $phase)"
	recovery_settle
	recovery_outcome
	recovery_record
	rm -f recovery-check.state
}

case "${1:-}" in
system) system ;;
first-boot) wait_boot ;;
swap) add_swap ;;
docker) install_docker ;;
docker-setup) setup_docker ;;
prepare) prepare "${2:-}" ;;
seed) seed ;;
issuer-key) issuer_key ;;
restore) restore "${2:-}" "${3:-}" "${4:-}" "${5:-}" "${6:-}" "${7:-}" ;;
restore-fresh) restore_fresh "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
up) up ;;
final-snapshot) final_snapshot ;;
retire) retire "${2:-}" ;;
retired) retired ;;
wipe) wipe ;;
recovery-check)
	shift
	recovery_check "$@"
	;;
# recovery-check's detached part.
recovery-run) recovery_run "$2" "${3:-}" "${4:-}" "${5:-}" ;;
*)
	echo "usage: install.sh system|first-boot|swap|docker|docker-setup|prepare HOST|wipe|seed|issuer-key|restore DEVICE VMID HOST IPV4 [FROM [final]]|restore-fresh DEVICE VMID HOST IPV4|up|final-snapshot|retire NEWVM|retired|recovery-check [MINUTES]|recovery-check result" >&2
	exit 2
	;;
esac
