// Lets Karto Wallet see one other app on the phone, Karto PoS (Android 11's package visibility): the wallet asks
// Android who signed it before handing it a pairing code (src/wallet/posLaunch.ts). Karto PoS's own build leaves
// this plugin out (variant.js).
const { withAndroidManifest } = require('expo/config-plugins');

const POS_PACKAGE = require('../variant').idOf('pos');

/** The manifest with Karto PoS's package among its <queries>, once. */
function addPosQuery(manifest) {
  const queries = manifest.queries ?? [];
  const has = queries.some((q) => (q.package ?? []).some((p) => p.$?.['android:name'] === POS_PACKAGE));
  return has ? manifest : { ...manifest, queries: [...queries, { package: [{ $: { 'android:name': POS_PACKAGE } }] }] };
}

module.exports = function withPosQuery(config) {
  return withAndroidManifest(config, (c) => {
    c.modResults.manifest = addPosQuery(c.modResults.manifest);
    return c;
  });
};
module.exports.addPosQuery = addPosQuery;
