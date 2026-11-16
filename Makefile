test:
	sh deploy/test/sign-apk-test.sh
	sh deploy/test/make-key-test.sh
	sh deploy/test/play-gms-test.sh
	cd server && go vet ./... && go test ./...
	cd app && ([ -d node_modules ] || npm ci) && npm test && npm run typecheck

# Linux binary the app uploads to the VM as ~/card-app/bin/cardd. Stamped with the server code's own last commit
# (deploy/server-version.sh) and built without Go's VCS stamp, so a commit that leaves server/ alone gives the same
# file, the same bundle hash, and no "Update server" offer.
cardd-linux:
	cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=$$(sh ../deploy/server-version.sh)" -o ../deploy/bin/cardd ./cmd/cardd

# Shellcheck, then the real phoenixd + cardd + Caddy + ntfy stack in Docker.
deploy-test:
	docker run --rm -v "$$PWD/deploy:/mnt:ro" koalaman/shellcheck:v0.11.0 /mnt/install.sh /mnt/cardd-ctl /mnt/server-version.sh /mnt/test/stack-test.sh /mnt/test/sshd-test.sh /mnt/test/phone-diag.sh /mnt/test/android-env.sh /mnt/test/no-gms.sh /mnt/test/play-gms.sh /mnt/test/play-gms-test.sh /mnt/test/phone-smoke.sh /mnt/test/phone-card-probe.sh /mnt/test/phone-backup-probe.sh /mnt/test/phone-recovery-check.sh /mnt/test/install-system-test.sh /mnt/test/recovery-check-test.sh /mnt/test/release-apk.sh /mnt/test/prebuild.sh /mnt/test/diag-wait.sh /mnt/test/phone-photo-probe.sh /mnt/test/phone-connection-probe.sh /mnt/test/stack-pos.sh /mnt/test/bundle-markers.sh /mnt/test/pos-smoke.sh /mnt/test/sign-apk-test.sh /mnt/test/make-key-test.sh /mnt/signing/sign-apk.sh /mnt/signing/make-key.sh /mnt/test/signing-proof.sh /mnt/test/ssh-drop-test.sh /mnt/test/ios-swift-test.sh /mnt/test/ios-prebuild-check.sh /mnt/test/sshd-mac.sh /mnt/test/iphone-diag.sh /mnt/test/diag-login-key.sh /mnt/release/android-release.sh
	sh deploy/test/install-system-test.sh
	sh deploy/test/recovery-check-test.sh
	sh deploy/test/stack-test.sh

# The point of sale's stack check alone (deploy/test/stack-pos.sh), for when stack-test.sh fails at a step before
# it; no substitute for deploy-test passing.
deploy-test-pos:
	sh deploy/test/stack-pos.sh

# The server bundle the app uploads (deploy/ plus the linux cardd), as APK assets.
app-deploy-assets: cardd-linux
	node app/scripts/deploy-assets.mjs

# What a cut connection does to an install step, started plainly and through the app's own command, against a
# throwaway OpenSSH server (Docker).
ssh-drop-test:
	sh deploy/test/ssh-drop-test.sh

# The iPhone module's plain Swift, on Linux: its tests in the swift Docker image, the SSH ones against a throwaway
# OpenSSH server. ARGS goes to swift test: make ios-swift-test ARGS='--filter CardLogicTests'
ios-swift-test:
	sh deploy/test/ios-swift-test.sh $(ARGS)

# The iPhone app's settings, as expo prebuild writes them into an Xcode project on Linux: the wallet's and the
# diagnostics app's. Nothing is compiled.
ios-prebuild-check:
	sh deploy/test/ios-prebuild-check.sh

# JVM tests of the card-native module, SSH ones against a throwaway OpenSSH server.
native-test: app-deploy-assets
	sh deploy/test/prebuild.sh
	sh deploy/test/sshd-test.sh

# The native layer on a real phone over adb (see deploy/test/phone-diag.sh).
phone-diag: app-deploy-assets
	sh deploy/test/phone-diag.sh

# The release app on the phone over adb, its data kept and the app not opened: the JS bundle made
# afresh at low priority (deploy/test/release-apk.sh). Puts the normal app back after a diagnostics build.
phone-install: app-deploy-assets
	sh deploy/test/release-apk.sh

# Karto PoS, the project's second app (app/variant.js), on the phone beside Karto Wallet: its data kept, not opened.
# It carries no server files, so it needs no app-deploy-assets.
pos-install:
	APP_VARIANT=pos sh deploy/test/release-apk.sh

# Karto PoS's release app on a real phone: its own data cleared (never the wallet's), then its first screens and
# the links any app can send it (deploy/test/pos-smoke.sh). Not for a phone that is somebody's till.
pos-smoke:
	sh deploy/test/pos-smoke.sh

# The release app on a real phone: no Play Services, then the first screens (deploy/test/phone-smoke.sh).
phone-smoke: app-deploy-assets
	sh deploy/test/phone-smoke.sh

# A read-only look at a real blank NTAG 424 DNA card on the phone (deploy/test/phone-card-probe.sh).
phone-card-probe: app-deploy-assets
	sh deploy/test/phone-card-probe.sh

# The app's age decryption and opening a database from memory, timed on the phone (deploy/test/phone-backup-probe.sh).
phone-backup-probe: app-deploy-assets
	sh deploy/test/phone-backup-probe.sh

# Card photos: no JPEG file in the app's cache or files, no EXIF in the camera's thumbnail or on the server, the photos in the newest snapshot (deploy/test/phone-photo-probe.sh).
phone-photo-probe: app-deploy-assets
	sh deploy/test/phone-photo-probe.sh

# The backup job's open of card-app.db, closed and collected five times over, leaves the app's own connection reading (deploy/test/phone-connection-probe.sh).
phone-connection-probe: app-deploy-assets
	sh deploy/test/phone-connection-probe.sh

# On the paired server, does phoenixd get its channel back from ACINQ without its database? (deploy/test/phone-recovery-check.sh)
# RESULT=1 only reads the last check's result (after the phone's session dropped).
phone-recovery-check: app-deploy-assets
	RESULT=$(RESULT) sh deploy/test/phone-recovery-check.sh

# Karto's icon and splash PNGs from their SVG sources (app/assets/icon/), with cairosvg 2.9.0 in a venv of its own (.venv-icons, not committed).
app-icons:
	[ -x .venv-icons/bin/python ] || (python3 -m venv .venv-icons && .venv-icons/bin/pip install -q cairosvg==2.9.0)
	.venv-icons/bin/python app/scripts/icons.py

.PHONY: test cardd-linux deploy-test deploy-test-pos app-deploy-assets native-test phone-install pos-install pos-smoke phone-diag phone-smoke phone-card-probe phone-backup-probe phone-recovery-check phone-photo-probe phone-connection-probe app-icons ssh-drop-test ios-swift-test ios-prebuild-check
