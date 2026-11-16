// Lets Karto PoS see one other app on the phone, Karto Wallet (Android 11's package visibility): Android tells an
// app that another was installed, updated or removed only when it can see it, and an update of the wallet under
// the till turned the till's reader mode off (the card-native module turns it on again on that news).
// Only Karto PoS's build has this plugin (variant.js); the wallet sees Karto PoS through withPosQuery.
const { withAndroidManifest } = require('expo/config-plugins');

const WALLET_PACKAGE = require('../variant').idOf('wallet');

/** The manifest with Karto Wallet's package among its <queries>, once. */
function addWalletQuery(manifest) {
  const queries = manifest.queries ?? [];
  const has = queries.some((q) => (q.package ?? []).some((p) => p.$?.['android:name'] === WALLET_PACKAGE));
  return has ? manifest : { ...manifest, queries: [...queries, { package: [{ $: { 'android:name': WALLET_PACKAGE } }] }] };
}

module.exports = function withWalletQuery(config) {
  return withAndroidManifest(config, (c) => {
    c.modResults.manifest = addWalletQuery(c.modResults.manifest);
    return c;
  });
};
module.exports.addWalletQuery = addWalletQuery;
