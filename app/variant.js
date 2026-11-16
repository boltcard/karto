// The two apps this project builds: Karto Wallet, which app.json
// describes, and Karto PoS, which is app.json with its own name, link scheme, package, icon, screens and plugins.
// One setting chooses: APP_VARIANT (wallet when unset). CommonJS: app.config.js and the tests both load it.
const VARIANTS = ['wallet', 'pos'];

/**
 * The two apps' identifiers, one for both platforms: the publisher's reversed domain (whitewolf.tech), then the app.
 * A release (KARTO_RELEASE=1: deploy/release/android-release.sh, and the stores' builds later) carries them as they
 * are; every other build carries DEV after them, and installs beside a release. app.json repeats the wallet's .dev
 * one (Expo reads that file as it is), and a test holds the two the same.
 */
const IDS = { wallet: 'tech.whitewolf.karto', pos: 'tech.whitewolf.kartopos' };
const DEV = '.dev';

/** KARTO_RELEASE: '1' for a release, unset (or empty) for any other build. */
function checkRelease(release) {
  const r = release || '';
  if (r !== '' && r !== '1') throw new Error(`KARTO_RELEASE is "${r}": it must be 1 or unset`);
  return r === '1';
}

/** The identifier a build of the variant carries (wallet when unset): the store's for a release, else with DEV. */
const idOf = (variant, release) => IDS[variant || 'wallet'] + (checkRelease(release) ? '' : DEV);

/**
 * Android's versionCode, from the version (X.Y.Z, each part a plain number below 1000): X*1000000 + Y*1000 + Z, so
 * it rises whenever the version does and only one number is changed for a release.
 */
function versionCode(version) {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(version || '');
  if (!m) throw new Error(`version is "${version}": it must be X.Y.Z, each part a number below 1000`);
  const code = Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3]);
  if (code < 1) throw new Error('version 0.0.0 has no versionCode: Android needs 1 or more');
  return code;
}

/**
 * The plugins Karto PoS leaves out: it carries no server files, runs no background job, sees no app but Karto Wallet,
 * is never a card, gets no alerts (its till shows Paid), and installs from Android 7 up, where the wallet needs
 * Android 9 (withAndroid9).
 */
const WALLET_ONLY = ['./plugins/withDeployAssets', './plugins/withPosQuery', './plugins/withPhoneCard', './plugins/withAlerts', './plugins/withAndroid9', 'expo-background-task'];

const nameOf = (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin);

/** app.json's `expo` for the variant (a release's identifiers when release is '1'); the one given is not changed. */
function forVariant(expo, variant, release) {
  const v = variant || 'wallet';
  if (!VARIANTS.includes(v)) throw new Error(`APP_VARIANT is "${v}": it must be wallet or pos`);
  if (v === 'wallet') return expo;
  const plugins = expo.plugins
    .filter((p) => !WALLET_ONLY.includes(nameOf(p)))
    .map((p) => {
      // The router's root decides which screens are in the bundle: only src/pos-app's.
      // No sitemap, as the wallet has none: the router's own _sitemap screen can be opened by a link, and on a phone it throws.
      if (nameOf(p) === 'expo-router') return ['expo-router', { ...p[1], root: 'src/pos-app' }];
      if (nameOf(p) === 'expo-splash-screen') return ['expo-splash-screen', { ...p[1], image: './assets/pos/splash-icon.png' }];
      // On an iPhone the till asks for no Face ID: false deletes the stock line the plugin would write.
      if (nameOf(p) === 'expo-secure-store') return ['expo-secure-store', { faceIDPermission: false }];
      return p;
    })
    // Its links act (a pairing link pairs the phone), so each opens the app once. It sees Karto Wallet, to hear of
    // the wallet's updates, which can turn its reader mode off. UnifiedPush's connector, which the shared
    // card-native module brings, is taken out of its manifest: it gets no alerts.
    // Nor does expo-local-authentication's, which Expo applies to every build unnamed: named here, it is told false.
    .concat(['./plugins/withLinkOnce', './plugins/withWalletQuery', './plugins/withNoPush', ['expo-local-authentication', { faceIDPermission: false }]]);
  return {
    ...expo,
    name: 'Karto PoS',
    slug: 'karto-pos',
    scheme: 'kartopos',
    icon: './assets/pos/icon.png',
    android: {
      ...expo.android,
      package: idOf('pos', release),
      adaptiveIcon: {
        ...expo.android.adaptiveIcon,
        // The wallet's charcoal behind another drawing: the card held to a till.
        foregroundImage: './assets/pos/android-icon-foreground.png',
        monochromeImage: './assets/pos/android-icon-monochrome.png',
      },
      // The Paid buzz. NFC and the camera are the card-native module's own, in both apps.
      permissions: ['android.permission.VIBRATE'],
    },
    // Its own iPhone app, under the same identifier as on Android. It reads cards and scans the wallet's pairing
    // code; it asks for no Face ID, so it carries no such line.
    ios: {
      ...expo.ios,
      bundleIdentifier: idOf('pos', release),
      infoPlist: {
        NFCReaderUsageDescription: 'Karto PoS reads Bolt Cards to charge them.',
        NSCameraUsageDescription: 'Karto PoS uses the camera to scan the pairing code Karto Wallet shows.',
        'com.apple.developer.nfc.readersession.iso7816.select-identifiers': expo.ios.infoPlist['com.apple.developer.nfc.readersession.iso7816.select-identifiers'],
      },
    },
    plugins,
  };
}

/**
 * The store a build is for, a setting beside APP_VARIANT:
 * KARTO_STORE unset is the Google-free build; play adds UnifiedPush's embedded FCM distributor, which the card-native
 * module's build.gradle reads for itself. Karto PoS gets no alerts and is built Google-free only.
 */
function checkStore(variant, store, release) {
  const s = store || '';
  if (s !== '' && s !== 'play') throw new Error(`KARTO_STORE is "${s}": it must be play or unset`);
  if (s === 'play' && (variant || 'wallet') !== 'wallet') throw new Error('KARTO_STORE=play is for Karto Wallet: Karto PoS is built Google-free only');
  // A release is Google-free: Play's build comes with a Play listing.
  if (s === 'play' && checkRelease(release)) throw new Error('KARTO_RELEASE=1 is Google-free: it is not built with KARTO_STORE=play');
}

module.exports = { forVariant, VARIANTS, checkStore, checkRelease, IDS, DEV, idOf, versionCode };
