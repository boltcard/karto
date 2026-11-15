#!/bin/sh
# install.sh system, and its four commands (first-boot, swap, docker, docker-setup), must be safe to re-run ("Update server" runs them again). It
# runs over SSH in a non-login shell, where /usr/sbin (swapon, mkswap) is not
# on PATH. Runs it with sudo stubbed to only log, swapon absent from PATH, and
# the swap file and /proc/swaps redirected (CARD_APP_SWAPFILE, CARD_APP_SWAPS).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
mkdir "$t/bin"
cat >"$t/bin/sudo" <<'EOF'
#!/bin/sh
echo "sudo $*" >>"$CARD_APP_TEST_LOG"
case "$1" in tee) cat >/dev/null ;; esac
EOF
printf '#!/bin/sh\nexit 0\n' >"$t/bin/docker"
chmod +x "$t/bin/sudo" "$t/bin/docker"

run() { # $1: what /proc/swaps lists; $2: whether the swap file exists
	: >"$t/log"
	printf 'Filename Type Size Used Priority\n%s' "$1" >"$t/swaps"
	rm -f "$t/swapfile"
	[ "$2" = exists ] && : >"$t/swapfile"
	env PATH="$t/bin:/usr/bin:/bin" CARD_APP_TEST_LOG="$t/log" CARD_APP_SWAPS="$t/swaps" CARD_APP_SWAPFILE="$t/swapfile" \
		sh "$root/deploy/install.sh" system </dev/null >/dev/null 2>"$t/err" || { cat "$t/err" >&2; return 1; }
}
fail() { echo "FAIL: $*" >&2; cat "$t/log" >&2; exit 1; }

run "$t/swapfile file 1048572 0 -2" exists || fail "re-run with swap on"
grep -qE 'fallocate|mkswap|swapon' "$t/log" && fail "re-run with swap on touched the swap file"

run "" missing || fail "first run"
grep -q "fallocate -l 1G $t/swapfile" "$t/log" || fail "first run made no swap file"
# Made under another name and moved into place only once it is a swap file, so a
# run that dies halfway can't leave a file that every later run skips and swapon rejects.
grep -q "mkswap -q $t/swapfile.new" "$t/log" || fail "the swap file was not made under a temporary name"
grep -q "mv $t/swapfile.new $t/swapfile" "$t/log" || fail "the finished swap file was not moved into place"
grep -q "swapon $t/swapfile" "$t/log" || fail "first run did not turn swap on"

run "" exists || fail "after a reboot without swap"
grep -qE 'fallocate|mkswap' "$t/log" && fail "an existing swap file was made again"
grep -q "swapon $t/swapfile" "$t/log" || fail "an existing swap file was not turned on"

# system is four commands. Each runs on its own, and the four in order
# log what system logs (Update server runs them again: they must be safe to re-run).
four() { # same arguments as run; runs the four commands in order into one log
	: >"$t/log"
	printf 'Filename Type Size Used Priority\n%s' "$1" >"$t/swaps"
	rm -f "$t/swapfile"
	[ "$2" = exists ] && : >"$t/swapfile"
	for c in first-boot swap docker docker-setup; do
		env PATH="$t/bin:/usr/bin:/bin" CARD_APP_TEST_LOG="$t/log" CARD_APP_SWAPS="$t/swaps" CARD_APP_SWAPFILE="$t/swapfile" \
			sh "$root/deploy/install.sh" "$c" </dev/null >/dev/null 2>"$t/err" || { cat "$t/err" >&2; return 1; }
	done
}
run "" missing || fail "system, for the comparison"
cp "$t/log" "$t/system.log"
four "" missing || fail "the four commands"
cmp -s "$t/log" "$t/system.log" || { diff "$t/system.log" "$t/log" >&2; fail "the four commands don't do what system does"; }
four "$t/swapfile file 1048572 0 -2" exists || fail "the four again, with swap on"
grep -qE 'fallocate|mkswap|swapon' "$t/log" && fail "the four again touched the swap file"

# install.sh docker on a VM without Docker installs it (no function may hide the docker command).
mkdir "$t/nodocker"
for b in cat dirname dpkg; do ln -s "$(command -v "$b")" "$t/nodocker/$b"; done
ln -s "$t/bin/sudo" "$t/nodocker/sudo"
: >"$t/log"
env PATH="$t/nodocker" CARD_APP_TEST_LOG="$t/log" /bin/sh "$root/deploy/install.sh" docker </dev/null >/dev/null 2>"$t/err" || { cat "$t/err" >&2; fail "install.sh docker without Docker"; }
grep -q "apt-get -o DPkg::Lock::Timeout=600 update -qq" "$t/log" || fail "install.sh docker ran no apt-get update"
grep -q "curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc" "$t/log" || fail "install.sh docker fetched no key"
grep -q "apt-get -o DPkg::Lock::Timeout=600 install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin" "$t/log" || fail "install.sh docker installed no Docker"

echo PASS
