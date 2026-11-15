// Karto Wallet installs on Android 9 (API 28) or later. Below it Android checks the APK Signature Scheme v2
// signature, which the apps' signing lineage makes with its first key, the public debug key: there anyone could
// sign an update that installs over the wallet with its data, the phrase among it (deploy/signing).
// Karto PoS leaves this plugin out (variant.js) and keeps Expo's floor, Android 7, so an old
// phone can still be a till. Expo's Android build reads the floor from gradle.properties' android.minSdkVersion.
const { withGradleProperties } = require('expo/config-plugins');

const MIN_SDK = '28';

/** gradle.properties' entries with android.minSdkVersion set to 28, once. */
function setMinSdk(properties) {
  const rest = properties.filter((p) => !(p.type === 'property' && p.key === 'android.minSdkVersion'));
  return [...rest, { type: 'property', key: 'android.minSdkVersion', value: MIN_SDK }];
}

module.exports = function withAndroid9(config) {
  return withGradleProperties(config, (c) => {
    c.modResults = setMinSdk(c.modResults);
    return c;
  });
};
module.exports.setMinSdk = setMinSdk;
