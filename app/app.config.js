// Karto Wallet is app.json as it stands; APP_VARIANT=pos makes it Karto PoS (variant.js). KARTO_STORE is checked
// here and changes nothing in the config: Gradle reads it for itself.
const { forVariant, checkStore } = require('./variant');

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
  checkStore(process.env.APP_VARIANT, process.env.KARTO_STORE);
  return withDiagnostics(forVariant(config, process.env.APP_VARIANT), process.env);
};
module.exports.withDiagnostics = withDiagnostics;
