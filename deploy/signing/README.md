# deploy/signing/

How the two Android apps, Karto Wallet (`tech.whitewolf.karto.dev`) and Karto
PoS (`tech.whitewolf.kartopos.dev`), are signed, and what you can build without
the project's private key.

## Why the apps are signed again

Gradle signs a release APK with the React Native template's debug key
(`androiddebugkey`, password `android`). That key is in every React Native
project, so it proves nothing:

- Android lets an APK install over an app, keeping the app's data, when both
  are signed by the same key. With the debug key, anyone who could get an APK
  onto the phone could replace Karto Wallet with their own build and read what
  the wallet keeps, the recovery phrase among it.
- Karto Wallet hands a pairing code to Karto PoS on the same phone only if that
  app is signed as the wallet is. Against a key everyone has, that check would
  pass for anyone's app.

So every APK that goes to a phone is signed again with a key only the project
holds, and with that key alone: by APK Signature Scheme v2, which Android 7 and
8 read, and by scheme v3, which Android 9 and later read. No other key was ever
these apps', so there is no signing lineage. Once an app is installed, Android
refuses any APK that is not signed with the project's key
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`), on every Android version either app
installs on: Android 9 and later for Karto Wallet, Android 7 and later for
Karto PoS.

## What is in this folder

| File | What it is |
|---|---|
| `signer.sha256` | The SHA-256 of the project's signing certificate. `sign-apk.sh` refuses to produce an APK whose signer is any other. |
| `make-key.sh` | Makes a signing key and its `signer.sha256`, once. |
| `sign-apk.sh` | Signs a release APK with the project's key. |
| `keyring.py` | Reads and stores the key's password in the desktop's login keyring. |

The private key is not here and never will be: whoever signs keeps it outside
the repository. The scripts expect an EC P-256 key (alias `karto`) in a
PKCS #12 keystore, by default `~/.config/karto/signing/karto-android.p12`
(`KARTO_KEYSTORE` names another file), with its password in the desktop's login
keyring (the Secret Service; attributes `service=karto-android-signing`,
`account=karto`). `.gitignore` keeps `*.p12`, `*.jks` and every keystore out of
the repository.

## `sign-apk.sh <in.apk> <out.apk>`

Signs Gradle's release APK with the project's key alone, by schemes v2 and v3.
Schemes v1 and v4 are off. The password goes to `apksigner` on standard input,
never on a command line or in the environment.

It then verifies its own work as Android 7 would read it
(`--min-sdk-version 24`): the result must verify under schemes v2 and v3, and
its one signer must be the certificate in `signer.sha256`. Only then does the
output file appear. (Verified against the APK's own floor, `apksigner` leaves
out of its report a scheme no Android from that floor reads, so the wallet's
v2 signature would not show.)

It stops, leaving no output file, when:

- the input APK, `apksigner` or `signer.sha256` is missing, or `signer.sha256`
  does not hold a SHA-256;
- there is no keystore, or its password cannot be read (no keyring entry, a
  locked keyring, no `python3-secretstorage`);
- `apksigner` fails (a wrong password);
- the signed APK does not verify, is not signed by schemes v2 and v3, or its
  signer is not the pinned one.

`deploy/test/release-apk.sh` is the one script that installs an APK on a phone,
and it installs only what `sign-apk.sh` produced. `make phone-install`,
`make pos-install`, `make phone-smoke`, `make pos-smoke`, `make phone-diag` and
the `make phone-*-probe` targets all go through it. So without a signing key
none of them installs anything.

## `make-key.sh`

Makes a new key, for whoever is setting up signing: run it yourself in a
terminal of your own, because it shows the key's password once, for your
backup.

It makes the keystore (directory `0700`, file `0600`) with a random
32-character password, stores the password in the login keyring, writes
`signer.sha256`, and signs a small test APK with `sign-apk.sh` to prove the
chain. It then prints the keystore's path, the password and the fingerprint,
and ends only when you type the fingerprint's last four characters as your word
that the file and password are backed up. Without that backup, apps signed with
the key can never be updated again.

It refuses, making nothing, when the system's Python has no `secretstorage`, or
when any of these already exists: the keystore, a signing password in the
keyring, `signer.sha256`. In this repository `signer.sha256` exists, so here it
always refuses: the project's key was made once and is restored from its
backup, not made again. If it cannot finish, it removes what it made.

To restore a key from its backup on a new computer: put the file back where
the scripts look for it (above), then run
`/usr/bin/python3 deploy/signing/keyring.py set` and give the password at its
prompt.

## What the wallet's check does

Karto Wallet's **Karto PoS is on this phone** starts the app named
`tech.whitewolf.kartopos.dev` with a pairing link only when that app is signed
with exactly the certificates the wallet itself is signed with now
(`app/modules/card-native/android/.../Signers.kt`, `app/src/wallet/posLaunch.ts`).
Otherwise it says the app is not signed as the wallet is and hands over
nothing; the pairing code on the screen can still be scanned.

Android's own `PackageManager.checkSignatures` is not used. From Android 11,
when two apps' signers differ and either has a signing history, it compares the
*oldest* certificate of the history, which anyone can make the public debug
key: it would call a stranger's app a match. Android reports an app's current
signers from Android 9, which is one reason Karto Wallet installs from 9 only
(`app/plugins/withAndroid9.js`).

The check compares the two apps with each other; no fingerprint is compiled
into the wallet. A wallet and a till that you build and sign with one key of
your own trust each other, and neither trusts the project's builds.

## Building without the project's key

You cannot produce an APK that installs over the project's own builds; that is
the point. On a phone that has no Karto app signed by the project, you have two
ways.

**A debug-key build, for development.** Expo's ordinary commands sign with the
debug key:

```sh
cd app
npm ci
npx expo run:android                    # Karto Wallet
```

The wallet's build runs `make app-deploy-assets` itself, so Go must be
installed. For Karto PoS set both `APP_VARIANT=pos` (the native project) and
`EXPO_PUBLIC_APP_VARIANT=pos` (the JavaScript bundle), and delete the generated
`app/android/` when changing from one app to the other: it is made for one app
at a time. A debug-key build has none of the protection described above: use
it with test money only. The project's own builds and tests all go through
`release-apk.sh`; this route is not part of them.

**A key of your own.** Both scripts take their folder and keystore from the
environment, so you can keep your own `signer.sha256` outside the repository.
This needs Linux with a login keyring, `python3-secretstorage`, a JDK
(`keytool`) and the Android SDK (`ANDROID_HOME`, or `~/Android/Sdk`) with
build-tools and a platform:

```sh
mkdir -p ~/karto-signing
export KARTO_SIGNING_DIR=~/karto-signing
export KARTO_KEYSTORE=~/karto-signing/my-key.p12
sh deploy/signing/make-key.sh
```

With the two variables still set, `make phone-install` and `make pos-install`
build, sign with your key and install on the one phone connected over adb.
`CARDAPP_BUILD_ONLY=1 sh deploy/test/release-apk.sh` builds and signs without a
phone. A fork that wants its key to be the repository's default deletes
`signer.sha256`, runs `make-key.sh` without the variables, and commits the file
it writes.

## Tests

`deploy/test/sign-apk-test.sh` and `deploy/test/make-key-test.sh` run both
scripts with throwaway keys in a temporary folder and a file standing in for
the keyring; they never touch a real key. `make test` runs them, and they skip
themselves where there is no Android SDK. `SignersTest.kt` covers the
certificate comparison (`make native-test`).
`deploy/test/signing-proof.sh` offers a test phone a debug-key APK of each app,
which Android must refuse, and plants a debug-key Karto PoS for the wallet to
turn away.
