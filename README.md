# Karto

Two phone apps and the server they run, for Bolt Cards (NTAG 424 DNA cards that pay over Lightning).

- **Karto Wallet** orders its own server from LNVPS (a VPS paid for in bitcoin), installs `cardd` on it over SSH,
  and manages Bolt Cards as a self-custodial wallet. On Android the phone itself can also be a Bolt Card.
- **Karto PoS** is a till. It is paired with a wallet's server and charges Bolt Cards.
- **`cardd`** is the Bolt Card server, written in Go. It runs on the person's own server beside phoenixd, which
  holds the Lightning channel.

Both apps are built from one Expo (React Native) project, for Android and iPhone. There is no central service: the
recovery phrase, the money and the cards' keys stay on the person's phone and server. Server orders carry the
project's LNVPS referral code (`LNVPS_REF_CODE` in `app/src/lnvps/client.ts`); a fork can change or remove it.

`card-app` was the project's working name. It stays where renaming would break existing servers: the server's
install folder (`~/card-app`) and its Docker project. The apps are published by White Wolf Technology
(whitewolf.tech): Karto Wallet is `tech.whitewolf.karto` and Karto PoS `tech.whitewolf.kartopos` on both platforms,
with `.dev` after them on every build that isn't a store's (`app/variant.js`). Their link schemes are `karto://` and
`kartopos://`.

## Layout

```
app/          the two apps (Expo, React Native); app/variant.js chooses which is built
server/       cardd, the Go Bolt Card server
deploy/       what the wallet uploads to the server (Docker stack, install script), signing, device test scripts
testvectors/  vectors shared by the Go and TypeScript tests
```

## Tests

You need Go 1.26 (`server/go.mod` names the exact version), Node 26 with npm, and `make`.

```sh
make test
```

It runs `go vet` and `go test` in `server/`, then `npm test` (vitest) and `npm run typecheck` in `app/`, installing
the app's packages with `npm ci` if they are missing. It also runs the tests of the signing and Play-services
scripts, which skip themselves where there is no Android SDK.

With Docker:

```sh
make deploy-test      # shellcheck, then the real phoenixd + cardd + Caddy + ntfy stack in a throwaway compose project
make native-test      # JVM tests of the Android native module (needs the Android SDK and a JDK)
make ios-swift-test   # the iPhone module's plain Swift, in a Swift image on Linux
```

The `Makefile` has a comment on every target, the ones that drive a real phone over adb among them.

## Building the apps

Android, on Linux, with the Android SDK, a JDK and Go:

```sh
cd app
npm ci
npx expo run:android
```

This is a debug-key build of Karto Wallet, for development and test money only.
[`deploy/signing/README.md`](deploy/signing/README.md) explains why, how to build Karto PoS, and how to sign
release builds with a key of your own (`make phone-install`, `make pos-install`).

The iPhone apps are built on GitHub's macOS runners by [`.github/workflows/ios.yml`](.github/workflows/ios.yml);
its header says what can be asked of it and which secrets signing needs. `make ios-prebuild-check` checks the
iPhone project's settings on Linux without compiling anything.

## The server

[`deploy/README.md`](deploy/README.md) explains the stack, each install step the wallet runs, **Update server**,
**Rebuild server** and what to do by hand when something goes wrong.

## Alerts

With the app closed, Karto Wallet's phone still shows a notification when money arrives (a till's sale among it), a
card is spent, a card's tap is refused by its rules, or the server's hosting is running out. `cardd` always sends
the same thing: a Web Push message, encrypted for the phone, to an address the phone gave it. Only that address
differs:

- **Android without Google (an APK, or a build from source):** the alert goes from your server to your own ntfy,
  which `deploy/` runs beside `cardd` (see [`deploy/README.md`](deploy/README.md)), and then to the ntfy app on
  your phone. No central service is involved.
- **Android built for the Play Store (`KARTO_STORE=play`):** the alert goes from your server straight to Google's
  push service, encrypted, and on to the phone. There is no relay and no Firebase project. If a UnifiedPush app
  such as ntfy is installed, Karto uses it instead.
- **iPhone:** alerts are not built yet.

What each hop can see: only the encrypted message, its size and when it was sent. Neither your ntfy nor Google can
read an amount, a card's name or the kind of alert. Google sees that a message came from your server's address.

Karto PoS gets no alerts: its till shows a sale as paid.

## Security

See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability.

## Licence

MIT. See [`LICENSE`](LICENSE).
