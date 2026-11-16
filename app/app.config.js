// Karto Wallet is app.json as it stands; APP_VARIANT=pos makes it Karto PoS (variant.js). KARTO_RELEASE=1 gives
// either app the store identifiers in place of the .dev ones. Android's versionCode follows app.json's version.
// KARTO_STORE is checked here and changes nothing in the config: Gradle reads it for itself.
const { forVariant, checkStore, idOf, versionCode } = require('./variant');

/** The identifiers and Android's versionCode, on either app's config. */
function withIdentity(config, variant, release) {
  const id = idOf(variant, release);
  return {
    ...config,
    android: { ...config.android, package: id, versionCode: versionCode(config.version) },
    ios: { ...config.ios, bundleIdentifier: id },
  };
}

// One more variant: the diagnostics app on an iPhone. A build made with EXPO_PUBLIC_DIAG_SSH
// starts at the diagnostics screen and talks to a throwaway SSH server on the local network
// (deploy/test/iphone-diag.sh), which iOS lets an app do only after asking with a line of the app's own. So that
// build carries the line, and a name of its own on the phone so it is never taken for the wallet; the wallet
// carries neither. The identifier is the wallet's: the ordinary build installs over it, and nothing of it is left.
// Android's diagnostics build reaches its server through adb and is not changed by this.
function withDiagnostics(config, env) {
  if (!env.EXPO_PUBLIC_DIAG_SSH) return config;
  return {
    ...config,
    ios: {
      ...config.ios,
      infoPlist: {
        ...config.ios.infoPlist,
        CFBundleDisplayName: 'Karto Diagnostics',
        NSLocalNetworkUsageDescription: 'Karto Diagnostics reaches a test server on this network.',
      },
    },
  };
}

module.exports = ({ config }) => {
  const { APP_VARIANT, KARTO_STORE, KARTO_RELEASE } = process.env;
  checkStore(APP_VARIANT, KARTO_STORE, KARTO_RELEASE);
  return withDiagnostics(withIdentity(forVariant(config, APP_VARIANT, KARTO_RELEASE), APP_VARIANT, KARTO_RELEASE), process.env);
};
module.exports.withDiagnostics = withDiagnostics;
module.exports.withIdentity = withIdentity;
