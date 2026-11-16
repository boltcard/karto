// Declares the phone's card service in Karto Wallet's manifest:
// the service that answers a till as a Bolt Card while the pay screen shows, the feature it uses (not required, so
// a phone without it still installs the app), and the buzz the pay screen gives when a payment shows. The service's
// code and its resource are the card-native module's, in both apps; Karto PoS's own build leaves this plugin out
// (variant.js), so it never declares the service and can never be a card.
const { withAndroidManifest } = require('expo/config-plugins');

const SERVICE = 'tech.whitewolf.karto.cardnative.PhoneCardService';
const HCE = 'android.hardware.nfc.hce';
const VIBRATE = 'android.permission.VIBRATE';

const named = (list, name) => (list ?? []).some((x) => x.$?.['android:name'] === name);
const withOne = (list, name, entry) => (named(list, name) ? (list ?? []) : [...(list ?? []), entry]);

/** The manifest with the service, the feature and the permission, each once. The one given is not changed. */
function addPhoneCard(manifest) {
  const [application, ...rest] = manifest.application ?? [];
  if (!application) throw new Error('withPhoneCard: the manifest has no <application> to declare the service in');
  const service = {
    // Android's NFC service alone may bind it.
    $: { 'android:name': SERVICE, 'android:exported': 'true', 'android:permission': 'android.permission.BIND_NFC_SERVICE' },
    'intent-filter': [{ action: [{ $: { 'android:name': 'android.nfc.cardemulation.action.HOST_APDU_SERVICE' } }] }],
    'meta-data': [{ $: { 'android:name': 'android.nfc.cardemulation.host_apdu_service', 'android:resource': '@xml/phone_card_apdu' } }],
  };
  return {
    ...manifest,
    'uses-feature': withOne(manifest['uses-feature'], HCE, { $: { 'android:name': HCE, 'android:required': 'false' } }),
    'uses-permission': withOne(manifest['uses-permission'], VIBRATE, { $: { 'android:name': VIBRATE } }),
    application: [{ ...application, service: withOne(application.service, SERVICE, service) }, ...rest],
  };
}

module.exports = function withPhoneCard(config) {
  return withAndroidManifest(config, (c) => {
    c.modResults.manifest = addPhoneCard(c.modResults.manifest);
    return c;
  });
};
module.exports.addPhoneCard = addPhoneCard;
