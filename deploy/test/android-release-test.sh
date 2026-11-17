#!/bin/sh
# deploy/release/android-release.sh --check, on a throwaway clone of this repository: its "origin" is a bare
# repository on this computer (GitHub's URL is mapped to it by url.insteadOf, so the script's own check of the URL
# still sees GitHub's), and gh is a stand-in on PATH. Nothing reaches GitHub and nothing is built. Checked: a clean
# main says ready; each reason not to release is refused, by name: extra arguments, an app/.env file, a version
# that isn't X.Y.Z, changes in the checkout, HEAD not origin/main, the tag here or on origin, a release (or draft)
# of that tag, releases that can't be listed, no push permission, another origin.
# Run from the repo root: sh deploy/test/android-release-test.sh (make test runs it). It tests what is committed.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
t=$(mktemp -d)
trap 'rm -rf "${t:?}"' EXIT
trap 'exit 130' INT TERM HUP
fail() { echo "android-release-test: FAIL: $*" >&2; exit 1; }

git init -q --bare "$t/origin.git"
# No tags: the repository's own (v0.9.0 and on) would refuse the version a clean main is checked at.
git clone -q --no-tags "$root" "$t/repo"
cd "$t/repo"
git push -q "$t/origin.git" HEAD:refs/heads/main
git remote set-url origin https://github.com/boltcard/karto.git
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.$t/origin.git.insteadOf" GIT_CONFIG_VALUE_0=https://github.com/boltcard/karto.git
version=$(node -p "require('./app/app.json').expo.version")
tag=v$version

# The stand-in gh: push permission from GH_PUSH, the releases' tags from GH_TAGS, a failing list with GH_FAIL.
mkdir "$t/bin"
cat >"$t/bin/gh" <<'EOF'
#!/bin/sh
case "$*" in
"api repos/boltcard/karto --jq .permissions.push") echo "${GH_PUSH:-true}" ;;
"api repos/boltcard/karto/releases --paginate --jq .[].tag_name") [ -z "${GH_FAIL:-}" ] || exit 1; printf '%s\n' "${GH_TAGS:-}" ;;
*) echo "gh stand-in: not expected: $*" >&2; exit 9 ;;
esac
EOF
chmod +x "$t/bin/gh"
PATH=$t/bin:$PATH
export PATH

check() { sh deploy/release/android-release.sh "$@" >"$t/log" 2>&1; }
refused() { # refused <what> <words it must say> [arguments]
	what=$1 words=$2
	shift 2
	if check "$@"; then fail "$what: it said ready: $(cat "$t/log")"; fi
	grep -qF "$words" "$t/log" || fail "$what: not refused for that reason: $(cat "$t/log")"
	echo "android-release-test: refuses $what"
}

check --check || fail "a clean main was refused: $(cat "$t/log")"
grep -q 'android-release: ready' "$t/log" || fail "a clean main didn't say ready: $(cat "$t/log")"
grep -q "release $tag " "$t/log" || fail "it didn't name the release: $(cat "$t/log")"
echo "android-release-test: a clean main is ready"

refused "extra arguments" "usage:" --check --local
refused "an unknown argument" "usage:" --bogus
touch app/.env.local
refused "an app/.env file" "app/.env.local is there" --check
rm app/.env.local
cp app/app.json "$t/app.json"
sed -i "s/\"version\": \"$version\"/\"version\": \"0.9\"/" app/app.json
refused "a version that isn't X.Y.Z" "is not X.Y.Z" --check
cp "$t/app.json" app/app.json
touch stray-file
refused "a file git doesn't know" "the checkout has changes" --check
rm stray-file
git -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m "not on origin"
refused "HEAD that isn't origin/main" "HEAD is not origin/main" --check
git reset -q --hard HEAD~1
git tag "$tag"
refused "the tag here" "the tag $tag is already here" --check
git tag -d "$tag" >/dev/null
git push -q "$t/origin.git" "HEAD:refs/tags/$tag"
refused "the tag on origin" "the tag $tag is already on GitHub" --check
git push -q "$t/origin.git" ":refs/tags/$tag"
# The stand-in's settings for one check each, in a subshell: a function's prefix assignments aren't reliably exported.
(GH_TAGS="v0.0.1
$tag" && export GH_TAGS && refused "a release or draft of the tag" "a release $tag is already on GitHub" --check) || exit 1
(GH_FAIL=1 && export GH_FAIL && refused "releases that can't be listed" "could not list" --check) || exit 1
(GH_PUSH=false && export GH_PUSH && refused "no push permission" "gh cannot push" --check) || exit 1
git remote set-url origin https://github.com/someone/karto.git
refused "another origin" "origin is not github.com/boltcard/karto" --check
git remote set-url origin https://github.com/boltcard/karto.git

check --check || fail "main was refused once all was as it was: $(cat "$t/log")"
echo PASS
