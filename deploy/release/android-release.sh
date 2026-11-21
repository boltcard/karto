#!/bin/sh
# Makes an Android release of Karto Wallet and Karto PoS as a DRAFT release on GitHub, for a person to look at
# and publish. Run on the computer that holds the project's signing key (deploy/signing/README.md), from a clean
# checkout of main as it is on GitHub:
#   sh deploy/release/android-release.sh           build, check, and make the draft
#   sh deploy/release/android-release.sh --check   only say whether a release can be made now
#   sh deploy/release/android-release.sh --local   build and check from this checkout as it is, in .release/local/,
#                                                  for trying a change or an update on a test phone: never published
#
# The version is app.json's (X.Y.Z; Android's versionCode follows it, app/variant.js), the tag v<version>. Four
# APKs, each built, signed and checked by deploy/test/release-apk.sh with KARTO_RELEASE=1 (the store identifiers,
# tech.whitewolf.karto and tech.whitewolf.kartopos), Google-free: each app for arm64-v8a (nearly every phone) and
# for armeabi-v7a (older ones). Each is checked again here: its package, version, ABI, its one signer (the
# certificate in deploy/signing/signer.sha256 as committed), its alignment, and the other app it may see. Then
# SHA256SUMS and the notes, all in .release/v<version>/, and the draft, made only once all of that has passed.
# Nothing is pushed: GitHub makes the tag, at this commit, when the draft is published.
#
# The draft is a full release: once published it is GitHub's latest, and every app installed from these APKs says
# so within an hour, or at once on opening Settings / This PoS (app/src/appUpdate). To publish a build for testers
# alone, tick "Set as a pre-release" when publishing the draft: the apps and Obtainium's default leave pre-releases
# alone.
#
# A release installs beside the .dev builds, as another app. To prove that a release updates over the one before:
# install the draft's arm64-v8a wallet on a test phone, raise app.json's version by hand (not committed), run
# --local, install its wallet over the first with adb install -r (the data kept), and put app.json back.
set -eu
REPO=boltcard/karto
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
# shellcheck source=/dev/null # checked on its own
. "$root/deploy/test/android-env.sh"
t0=$(date +%s)
step() { echo "[$(date +%H:%M:%S) +$(($(date +%s) - t0))s] $*"; }
stop() { echo "android-release: $*" >&2; exit 1; }
check_only=
is_local=
[ $# -le 1 ] || stop "usage: android-release.sh [--check | --local]"
case "${1:-}" in
'') ;;
--check) check_only=1 ;;
--local) is_local=1 ;;
*) stop "usage: android-release.sh [--check | --local]" ;;
esac

step "what may be released"
# Only what is committed goes into a release: no settings of the shell this runs in, and no .env file, which Expo
# would put into the bundle (a diagnostics build's among them), nor another key or pin for the signing.
for f in app/.env*; do [ ! -e "$f" ] || stop "$f is there: Expo would build it into the bundle. Move it away first"; done
for v in $(env | sed -n 's/^\(EXPO_PUBLIC_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
# CI among them: with it set, Expo keeps Metro's cache between bundles, and an EXPO_PUBLIC_ value inlined into an
# earlier build's bundle (KARTO_RELEASE's, APP_VARIANT's) could come back in this one.
unset CI KARTO_SIGNING_DIR KARTO_KEYSTORE KARTO_PASS_CMD KARTO_STORE CARDAPP_FULL_BUILD CARDAPP_KEEP_APKS APP_VARIANT KARTO_RELEASE CARDAPP_ABI
# And ccache's (deploy/test/release-apk.sh compiles the native modules through it): a release's own is set below.
for v in $(env | sed -n 's/^\(CCACHE_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
sha=$(git rev-parse HEAD)
version=$(node -p "require('./app/app.json').expo.version")
code=$(node -p "require('./app/variant.js').versionCode('$version')") || stop "app.json's version $version is not X.Y.Z"
tag=v$version
if [ -z "$is_local" ]; then
	# As written in .git/config (get-url would apply a url.insteadOf).
	case "$(git config --get remote.origin.url)" in
	"https://github.com/$REPO" | "https://github.com/$REPO.git" | "git@github.com:$REPO" | "git@github.com:$REPO.git" | "ssh://git@github.com/$REPO" | "ssh://git@github.com/$REPO.git") ;;
	*) stop "origin is not github.com/$REPO" ;;
	esac
	[ "$(gh api "repos/$REPO" --jq .permissions.push 2>/dev/null)" = true ] || stop "gh cannot push to $REPO (gh auth status)"
	git fetch -q origin main
	[ -z "$(git status --porcelain)" ] || stop "the checkout has changes or files git doesn't know: commit or move them first"
	[ "$sha" = "$(git rev-parse origin/main)" ] || stop "HEAD is not origin/main: a release is made from main as it is on GitHub"
	[ -z "$(git tag -l "$tag")" ] || stop "the tag $tag is already here: raise app.json's version"
	[ -z "$(git ls-remote --tags origin "refs/tags/$tag")" ] || stop "the tag $tag is already on GitHub: raise app.json's version"
	# Every release's tag, drafts' too: a failed call stops here, never reads as "none".
	releases=$(gh api "repos/$REPO/releases" --paginate --jq '.[].tag_name') || stop "could not list $REPO's releases"
	! printf '%s\n' "$releases" | grep -qxF "$tag" || stop "a release $tag is already on GitHub (a draft too): delete it or raise app.json's version"
fi
pin=$(git show HEAD:deploy/signing/signer.sha256 | tr -d ': \t\r\n' | tr 'A-F' 'a-f')
[ ${#pin} -eq 64 ] || stop "deploy/signing/signer.sha256 does not hold a SHA-256"
echo "release $tag (versionCode $code) of $sha, signed by ${pin%"${pin#????????????????}"}…"
[ -z "$check_only" ] || { echo "android-release: ready"; exit 0; }

if [ -n "$is_local" ]; then
	out=$root/.release/local
else
	out=$root/.release/$tag
	# A release compiles through a ccache of its own, filled by releases alone, each from main as it is on GitHub:
	# never by a development build of a branch or a pull request, whose objects would otherwise go into a release's
	# libraries. ccache then reads its settings from this folder's ccache.conf, not the person's, and no remote
	# store (one named in /etc/ccache.conf would be shared with every other build). --local builds use ccache's
	# default folder.
	export CCACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/karto-release-ccache" CCACHE_REMOTE_STORAGE=
fi
tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
rm -rf "${out:?}"
mkdir -p "$out"

step "npm ci (the packages as package-lock.json says)"
(cd app && nice -n 19 ionice -c3 npm ci --no-audit --no-fund --loglevel=error)
# Karto PoS's build label: the commit and its time, the same in both of its APKs.
EXPO_PUBLIC_BUILD_COMMIT=$(git rev-parse --short HEAD)
EXPO_PUBLIC_BUILD_TIME=$(git log -1 --format=%ct)
export EXPO_PUBLIC_BUILD_COMMIT EXPO_PUBLIC_BUILD_TIME

for app in wallet pos; do
	# Each app's native project made afresh, once: no android/ of a build before this release is used (Gradle's
	# build cache still is, by its inputs' hashes).
	rm -f app/android/.prebuild-inputs
	for abi in arm64-v8a armeabi-v7a; do
		step "Karto $app for $abi: build, sign, check (deploy/test/release-apk.sh)"
		APP_VARIANT=$app KARTO_RELEASE=1 CARDAPP_BUILD_ONLY=1 CARDAPP_ABI=$abi sh deploy/test/release-apk.sh
		cp app/android/app/build/outputs/apk/release/app-release-signed.apk "$out/karto-$app-$tag-$abi.apk"
	done
done

step "each APK checked again"
idof() { node -p "require('./app/variant.js').idOf('$1', '1')"; }
for app in wallet pos; do
	pkg=$(idof "$app")
	other=$(idof "$([ "$app" = wallet ] && echo pos || echo wallet)")
	floor=$([ "$app" = wallet ] && echo 28 || echo 24)
	for abi in arm64-v8a armeabi-v7a; do
		f=$out/karto-$app-$tag-$abi.apk
		badging=$("$tools/aapt2" dump badging "$f")
		printf '%s\n' "$badging" | grep -qF "package: name='$pkg' versionCode='$code' versionName='$version' " || stop "$f: not $pkg $version ($code): $(printf '%s\n' "$badging" | head -1)"
		[ "$(printf '%s\n' "$badging" | sed -n "s/^native-code: //p")" = "'$abi'" ] || stop "$f: native code is not $abi's alone"
		[ "$(printf '%s\n' "$badging" | sed -n "s/^minSdkVersion://p")" = "'$floor'" ] || stop "$f: its Android floor is not API $floor"
		verified=$("$tools/apksigner" verify -v --print-certs --min-sdk-version 24 "$f") || stop "$f does not verify"
		printf '%s\n' "$verified" | grep -qxF 'Verified using v2 scheme (APK Signature Scheme v2): true' || stop "$f: not signed by scheme v2"
		printf '%s\n' "$verified" | grep -qxF 'Verified using v3 scheme (APK Signature Scheme v3): true' || stop "$f: not signed by scheme v3"
		[ "$(printf '%s\n' "$verified" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: //p')" = "$pin" ] || stop "$f: its signer is not the project's"
		"$tools/zipalign" -c 4 "$f" || stop "$f is not aligned"
		# The other app of the release, which this one may see, and never a .dev one.
		manifest=$("$tools/aapt2" dump xmltree --file AndroidManifest.xml "$f")
		printf '%s\n' "$manifest" | grep -qF "android:name(0x01010003)=\"$other\" " || stop "$f: does not see $other"
		! printf '%s\n' "$manifest" | grep -qF "$other.dev" || stop "$f: names $other.dev, a development build"
		echo "$f: $pkg $version ($code), $abi, signed by the project's key"
	done
done

step "SHA256SUMS and the notes"
(cd "$out" && sha256sum ./*.apk | sed 's| \./| |' >SHA256SUMS)
fingerprint=$(echo "$pin" | sed 's/../&:/g; s/:$//' | tr 'a-f' 'A-F')
if [ -n "$is_local" ]; then
	printf '**A local build, never a release:** from the checkout as it was, not checked against GitHub.\n\n' >"$out/notes.md"
else
	: >"$out/notes.md"
fi
cat >>"$out/notes.md" <<EOF
Karto Wallet and Karto PoS handle real bitcoin. Use amounts you can afford to lose.

| File | App | Android | Phones |
|---|---|---|---|
| \`karto-wallet-$tag-arm64-v8a.apk\` | Karto Wallet (\`$(idof wallet)\`) | 9 or later | nearly every phone of the last eight years |
| \`karto-wallet-$tag-armeabi-v7a.apk\` | Karto Wallet | 9 or later | older 32-bit phones |
| \`karto-pos-$tag-arm64-v8a.apk\` | Karto PoS (\`$(idof pos)\`) | 7 or later | nearly every phone |
| \`karto-pos-$tag-armeabi-v7a.apk\` | Karto PoS | 7 or later | older 32-bit phones |

Version $version (versionCode $code), built from $sha. Google-free: no Google Play services. Alerts with the app closed need the ntfy app (UnifiedPush).

**Check what you downloaded.** Every APK is signed by the project's key alone. \`apksigner verify --print-certs <file>.apk\` must show one signer, with

\`\`\`
Signer #1 certificate SHA-256 digest: $pin
\`\`\`

(the same certificate as \`$fingerprint\`, as keytool and Android's settings write it), and \`sha256sum -c SHA256SUMS\` checks the files. An app signed by any other key can't update these, and these can't update it.

Updates: each app says on its main screen when a newer release is here (it asks GitHub once an hour, and each time Settings or This PoS opens). Install the next release's APK over this one, or with Obtainium add this repository and filter the APKs by \`karto-wallet\` or \`karto-pos\`, since one release holds both apps.
EOF

if [ -n "$is_local" ]; then
	step "done: $out (a local build: never to be published)"
	exit 0
fi

step "nothing changed while it built"
[ -z "$(git status --porcelain)" ] || stop "the checkout changed during the build: no draft made"
[ "$(git rev-parse HEAD)" = "$sha" ] || stop "HEAD moved during the build: no draft made"

step "the draft release on GitHub"
url=$(gh release create "$tag" -R "$REPO" --draft --target "$sha" --title "Karto $tag" --notes-file "$out/notes.md" \
	"$out/karto-wallet-$tag-arm64-v8a.apk" "$out/karto-wallet-$tag-armeabi-v7a.apk" \
	"$out/karto-pos-$tag-arm64-v8a.apk" "$out/karto-pos-$tag-armeabi-v7a.apk" "$out/SHA256SUMS")
step "done"
echo "The draft: $url"
echo "Nothing is public until a person publishes it there; GitHub then makes the tag $tag at $sha."
