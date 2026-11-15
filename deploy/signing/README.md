# deploy/signing/

How the two Android apps, Karto Wallet (`app.cardapp`) and Karto PoS
(`app.cardapp.pos`), are signed, and what you can build without the project's
private key.

## Why the apps are signed twice

Gradle signs a release APK with the React Native template's debug key
(`androiddebugkey`, password `android`). That key is in every React Native
project, so it proves nothing:

- Android lets an APK install over an app, keeping the app's data, when both
  are signed by the same key. With the debug key alone, anyone who could get an
  APK onto the phone could replace Karto Wallet with their own build and read
  what the wallet keeps, the recovery phrase among it.
- Karto Wallet hands a pairing code to Karto PoS on the same phone only if that
  app is signed as the wallet is. Against a key everyone has, that check would
  pass for anyone's app.

So every APK that goes to a phone is signed again with a key only the project
holds. The apps were first installed with the debug key, so the new key arrives
by Android's key rotation (APK Signature Scheme v3, Android 9 and later): a
*lineage* in which the debug key vouches for the project's key. An APK signed
this way installs over a debug-key build with its data kept, and after that
Android refuses any APK without the project's key
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`), including one whose own lineage starts
from the same public debug key.

Android 7 and 8 know no key rotation and judge an APK by the older scheme's
signer, which is still the debug key. For that reason Karto Wallet installs on
Android 9 or later only (`app/plugins/withAndroid9.js`). Karto PoS keeps
Android 7 as its floor, so an old phone can still be a till; on Android 7 or 8
a debug-key APK could replace it and take over its pairing with the shop.

## What is in this folder

| File | What it is |
|---|---|
| `old.keystore` | The React Native template's debug key (alias `androiddebugkey`, store and key password `android`, certificate SHA-256 `fac61745…033b9c`). Public: it is in every React Native project. A copy is kept here so signing does not depend on whichever file Expo's prebuild writes. |
| `lineage.bin` | The signing lineage: the debug key's certificate, the project's certificate, and the debug key's signature over the second. Not secret. In it the debug key keeps one capability, installed data, so an update over a debug-key build keeps the app's data. |
| `signer.sha256` | The SHA-256 of the project's signing certificate. `sign-apk.sh` refuses to produce an APK whose signer is any other. |
| `make-key.sh` | Makes a signing key, its lineage and its `signer.sha256`, once. |
| `sign-apk.sh` | Signs a release APK with the debug key and the project's key. |
| `keyring.py` | Reads and stores the key's password in the desktop's login keyring. |

The private key is not here and never will be: whoever signs keeps it outside
the repository. The scripts expect an EC P-256 key (alias `karto`) in a
PKCS #12 keystore, by default `~/.config/karto/signing/karto-android.p12`
(`KARTO_KEYSTORE` names another file), with its password in the desktop's login
keyring (the Secret Service; attributes `service=karto-android-signing`,
`account=karto`). `.gitignore` keeps `*.p12`, `*.jks` and every keystore but
`old.keystore` out of the repository.

## `sign-apk.sh <in.apk> <out.apk>`

Signs Gradle's release APK with two signers: the debug key for APK Signature
Scheme v2 (what Android 7 and 8 read), and the project's key for scheme v3 with
the lineage, for every Android that knows rotation (`--rotation-min-sdk-version
28`; apksigner's default would leave Android 9 to 12 to the debug key). Schemes
v1 and v4 are off. The password goes to `apksigner` on standard input, never on
a command line or in the environment.

It then verifies its own work: the result must verify under scheme v3 and its
one signer must be the certificate in `signer.sha256`. Only then does the
output file appear.

It stops, leaving no output file, when:

- the input APK, `apksigner`, `old.keystore`, `lineage.bin` or `signer.sha256`
  is missing, or `signer.sha256` does not hold a SHA-256;
- there is no keystore, or its password cannot be read (no keyring entry, a
  locked keyring, no `python3-secretstorage`);
- `old.keystore` is not the first key of the lineage;
- `apksigner` fails (a wrong password, a lineage that is not these keys');
- the signed APK does not verify, is not signed by scheme v3, or its signer is
  not the pinned one.

It never falls back to signing with the debug key alone.

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
32-character password, stores the password in the login keyring, makes the
lineage from `old.keystore` to the new key, writes `lineage.bin` and
`signer.sha256`, and signs a small test APK with `sign-apk.sh` to prove the
chain. It then prints the keystore's path, the password and the fingerprint,
and ends only when you type the fingerprint's last four characters as your word
that the file and password are backed up. Without that backup, apps signed with
the key can never be updated again.

It refuses, making nothing, when `old.keystore` is missing, when the system's
Python has no `secretstorage`, or when any of these already exists: the
keystore, a signing password in the keyring, `lineage.bin`, `signer.sha256`. In
this repository the last two exist, so here it always refuses: the project's
key was made once and is restored from its backup, not made again. If it cannot
finish, it removes what it made.

The lineage it writes leaves the debug key two capabilities, installed data and
permission. The second is needed for the first update over a debug-key build:
every app built with AndroidX declares a signature permission of its own, and
Android refuses an update whose old signer may not share it
(`INSTALL_FAILED_DUPLICATE_PERMISSION`). The committed `lineage.bin` has had
that capability removed since, with
`apksigner lineage --set-permission false`, which needs only the public debug
key.

To restore a key from its backup on a new computer: put the file back where
the scripts look for it (above), then run
`/usr/bin/python3 deploy/signing/keyring.py set` and give the password at its
prompt.

## What the wallet's check does

Karto Wallet's **Karto PoS is on this phone** starts the app named
`app.cardapp.pos` with a pairing link only when that app is signed with exactly
the certificates the wallet itself is signed with now
(`app/modules/card-native/android/.../Signers.kt`, `app/src/wallet/posLaunch.ts`).
Otherwise it says the app is not signed as the wallet is and hands over
nothing; the pairing code on the screen can still be scanned.

Android's own `PackageManager.checkSignatures` is not used. From Android 11,
when two apps' signers differ and either has a signing history, it compares the
*oldest* certificate of the history, which for these apps is the public debug
key: it would call a stranger's debug-key app a match.

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
environment, so you can keep your own lineage outside the repository. This
needs Linux with a login keyring, `python3-secretstorage`, a JDK (`keytool`)
and the Android SDK (`ANDROID_HOME`, or `~/Android/Sdk`) with build-tools and a
platform:

```sh
mkdir -p ~/karto-signing
cp deploy/signing/old.keystore ~/karto-signing/
export KARTO_SIGNING_DIR=~/karto-signing
export KARTO_KEYSTORE=~/karto-signing/my-key.p12
sh deploy/signing/make-key.sh
```

With the two variables still set, `make phone-install` and `make pos-install`
build, sign with your key and install on the one phone connected over adb.
`CARDAPP_BUILD_ONLY=1 sh deploy/test/release-apk.sh` builds and signs without a
phone. A fork that wants its key to be the repository's default deletes
`lineage.bin` and `signer.sha256`, runs `make-key.sh` without the variables,
and commits the two files it writes.

## Tests

`deploy/test/sign-apk-test.sh` and `deploy/test/make-key-test.sh` run both
scripts with throwaway keys in a temporary folder and a file standing in for
the keyring; they never touch a real key. `make test` runs them, and they skip
themselves where there is no Android SDK. `SignersTest.kt` covers the
certificate comparison (`make native-test`).
`deploy/test/signing-proof.sh` offers a real phone the APKs Android must
refuse.
