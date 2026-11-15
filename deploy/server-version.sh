#!/bin/sh
# The version stamped into cardd (make cardd-linux): the last commit that changed the
# server's own code (server/), with -dirty when that code has uncommitted changes.
# Not the repository's latest commit: that made a different cardd, and so a different
# bundle hash, at every commit, and the app offered "Update server" after every build
# of the app though the server hadn't changed. deploy/'s files that go to the server
# (install.sh, compose.yaml, ...) each have their own hash in the bundle, so a change
# to one still offers the update.
# Usage: sh deploy/server-version.sh [repo root]   (prints one line)
set -eu
root=${1:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$root"
# Outside a repository, or before the server has a commit: the build goes on, labelled unknown.
commit=$(git log -1 --format=%h -- server 2>/dev/null || true)
[ -n "$commit" ] || { echo unknown; exit 0; }
if [ -n "$(git status --porcelain -- server 2>/dev/null)" ]; then
	echo "$commit-dirty"
else
	echo "$commit"
fi
