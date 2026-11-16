// Declares the alerts' service in Karto Wallet's manifest: the
// service UnifiedPush's connector hands new endpoints and decrypted alerts to, the permission Android 13 asks for
// before a notification shows, and ntfy among the apps the wallet sees, to open it and to ask whether it is exempt
// from battery saving. The service's code is the card-native module's, in both apps; Karto PoS's own build
// leaves this plugin out (variant.js), so it never gets alerts.
const { withAndroidManifest } = require('expo/config-plugins');

const SERVICE = 'tech.whitewolf.karto.cardnative.AlertService';
const NOTIFY = 'android.permission.POST_NOTIFICATIONS';
const NTFY = 'io.heckel.ntfy';

const named = (list, name) => (list ?? []).some((x) => x.$?.['android:name'] === name);
const withOne = (list, name, entry) => (named(list, name) ? (list ?? []) : [...(list ?? []), entry]);

/** The manifest with the service, the permission and ntfy's package among its <queries>, each once. The one given is not changed. */
function addAlerts(manifest) {
  const [application, ...rest] = manifest.application ?? [];
  if (!application) throw new Error('withAlerts: the manifest has no <application> to declare the service in');
  const service = {
    // Not exported: the connector binds it from inside the app (its PushService's own instructions).
    $: { 'android:name': SERVICE, 'android:exported': 'false' },
    'intent-filter': [{ action: [{ $: { 'android:name': 'org.unifiedpush.android.connector.PUSH_EVENT' } }] }],
  };
  const queries = manifest.queries ?? [];
  const seesNtfy = queries.some((q) => named(q.package, NTFY));
  return {
    ...manifest,
    'uses-permission': withOne(manifest['uses-permission'], NOTIFY, { $: { 'android:name': NOTIFY } }),
    queries: seesNtfy ? queries : [...queries, { package: [{ $: { 'android:name': NTFY } }] }],
    application: [{ ...application, service: withOne(application.service, SERVICE, service) }, ...rest],
  };
}

module.exports = function withAlerts(config) {
  return withAndroidManifest(config, (c) => {
    c.modResults.manifest = addAlerts(c.modResults.manifest);
    return c;
  });
};
module.exports.addAlerts = addAlerts;
