// The two apps this project builds: Karto Wallet, which app.json
// describes, and Karto PoS, which is app.json with its own name, link scheme, package, icon, screens and plugins.
// One setting chooses: APP_VARIANT (wallet when unset). CommonJS: app.config.js and the tests both load it.
const VARIANTS = ['wallet', 'pos'];

/**
 * The two apps' identifiers, one for both platforms: the publisher's reversed domain (whitewolf.tech), then the app.
 * These are the stores'. Every build made now is not a store's, so it carries DEV after them (idOf), and installs beside
 * a store's app. app.json repeats the wallet's (Expo reads that file as it is), and a test holds the two the same.
 */
const IDS = { wallet: 'tech.whitewolf.karto', pos: 'tech.whitewolf.kartopos' };
const DEV = '.dev';

/** The identifier a build of the variant carries now (wallet when unset). */
const idOf = (variant) => IDS[variant || 'wallet'] + DEV;

/**
 * The plugins Karto PoS leaves out: it carries no server files, runs no background job, sees no app but Karto Wallet,
 * is never a card, gets no alerts (its till shows Paid), and installs from Android 7 up, where the wallet needs
 * Android 9 (withAndroid9).
 */
const WALLET_ONLY = ['./plugins/withDeployAssets', './plugins/withPosQuery', './plugins/withPhoneCard', './plugins/withAlerts', './plugins/withAndroid9', 'expo-background-task'];

const nameOf = (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin);

/** app.json's `expo` for the variant; the one given is not changed. */
function forVariant(expo, variant) {
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
      package: idOf('pos'),
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
      bundleIdentifier: idOf('pos'),
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
function checkStore(variant, store) {
  const s = store || '';
  if (s !== '' && s !== 'play') throw new Error(`KARTO_STORE is "${s}": it must be play or unset`);
  if (s === 'play' && (variant || 'wallet') !== 'wallet') throw new Error('KARTO_STORE=play is for Karto Wallet: Karto PoS is built Google-free only');
}

module.exports = { forVariant, VARIANTS, checkStore, IDS, DEV, idOf };
