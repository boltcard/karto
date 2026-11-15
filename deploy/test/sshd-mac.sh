#!/bin/sh
# Starts the machine's own sshd a second time, on 127.0.0.1:12223, where there is no Docker for
# ios-swift-test.sh's server (a GitHub macOS runner): for the package's SSH tests and for the
# diagnostics build in the simulator (.github/workflows/ios.yml). It lets in the test phrase's SSH key as the user who
# runs this, and prints "host:port:user:hostKeyBlob" (the only line on stdout).
# For a throwaway machine only: it needs sudo without a password, and the tests write into that
# user's home (stdin.txt, card-app/).
# Usage: sh deploy/test/sshd-mac.sh DIR    (DIR must not exist yet: keys, config and sshd.log go there)
set -eu
dir=${1:?usage: sshd-mac.sh DIR}
root=$(cd "$(dirname "$0")/../.." && pwd)
port=12223
user=$(id -un)
pub=$(sed -n 's/.*"sshAuthorizedKey": "\([^"]*\)".*/\1/p' "$root/testvectors/vectors.json")
mkdir "$dir"
dir=$(cd "$dir" && pwd)
ssh-keygen -q -t ed25519 -N '' -C cardapp-test-host -f "$dir/host_key"
# A second key the system's own ssh can use, to check the server before anything of ours meets it.
ssh-keygen -q -t ed25519 -N '' -C cardapp-self-check -f "$dir/check_key"
printf '%s\n' "$pub" >"$dir/authorized_keys"
cat "$dir/check_key.pub" >>"$dir/authorized_keys"

# The app only ever talks to Linux servers, and it and its tests ask them for GNU's tools
# (`stat -c`, `chmod MODE -- FILE`): a Mac's own are BSD's and refuse both. On a Mac, GNU's
# (Homebrew's coreutils) go first on the PATH of this server's sessions, and nowhere else.
setenv=
if ! stat -c %a / >/dev/null 2>&1; then
	brew list coreutils >/dev/null 2>&1 || HOMEBREW_NO_AUTO_UPDATE=1 brew install coreutils >&2
	setenv="SetEnv PATH=$(brew --prefix coreutils)/libexec/gnubin:/usr/bin:/bin:/usr/sbin:/sbin"
fi

cat >"$dir/sshd_config" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $dir/host_key
PidFile $dir/sshd.pid
AuthorizedKeysFile $dir/authorized_keys
AllowUsers $user
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
MaxStartups 100
LogLevel VERBOSE
$setenv
EOF
sudo /usr/sbin/sshd -f "$dir/sshd_config" -E "$dir/sshd.log"

check() {
	ssh -p "$port" -i "$dir/check_key" -o BatchMode=yes -o StrictHostKeyChecking=no \
		-o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$user@127.0.0.1" "$@"
}
n=0
until check true 2>/dev/null; do
	n=$((n + 1))
	if [ "$n" -ge 15 ]; then
		echo "sshd-mac.sh: no login on 127.0.0.1:$port after 15 tries; its log:" >&2
		sudo cat "$dir/sshd.log" >&2 || true
		exit 1
	fi
	sleep 1
done
# What the tests lean on, shown once so a failure there can be told from a failure of ours.
# shellcheck disable=SC2016 # these expand on the server
check 'echo "sshd-mac.sh: logged in as $(id -un), home $(pwd), shell $0"; echo "stat -c: $(stat -c %a /etc/hosts 2>&1)"; echo "chmod MODE -- FILE: $(chmod u+rwx -- . 2>&1 && echo ok)"; echo "sha256sum: $(printf x | sha256sum 2>&1)"' >&2
check 'stat -c %a . >/dev/null 2>&1 && chmod u+rwx -- . 2>/dev/null' || {
	echo "sshd-mac.sh: this server's sessions do not have GNU's stat and chmod" >&2
	exit 1
}
echo "127.0.0.1:$port:$user:$(cut -d' ' -f2 "$dir/host_key.pub")"
