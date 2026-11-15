// Takes UnifiedPush's connector out of Karto PoS's manifest:
// the connector is the card-native module's, so it is in both apps' code, and its own manifest would give the till
// an exported receiver a distributor could send to, its service and activity, the wake lock and the distributor
// queries. Karto PoS gets no alerts (withAlerts is the wallet's alone), so each is marked tools:node="remove" and
// Gradle's manifest merger drops it. The names are the connector 3.3.5 AAR's manifest's. Karto PoS's build alone
// (variant.js). WAKE_LOCK goes for every library that asks for it: nothing in the till holds one (the Paid sound
// sets no wake mode, and it schedules no work).
const { withAndroidManifest } = require('expo/config-plugins');

const TOOLS = 'http://schemas.android.com/tools';
const INTERNAL = 'org.unifiedpush.android.connector.internal';
const RECEIVER = `${INTERNAL}.MessagingReceiverImpl`;
const SERVICE = `${INTERNAL}.RaiseToForegroundService`;
const ACTIVITY = `${INTERNAL}.LinkActivity`;
const WAKE_LOCK = 'android.permission.WAKE_LOCK';
const DISTRIBUTOR = ['LINK', 'REGISTER', 'UNREGISTER'].map((a) => `org.unifiedpush.android.distributor.${a}`);

const removed = (name) => ({ $: { 'android:name': name, 'tools:node': 'remove' } });
const named = (list, name) => (list ?? []).some((x) => x.$?.['android:name'] === name);
const withRemoved = (list, name) => (named(list, name) ? (list ?? []) : [...(list ?? []), removed(name)]);
const removesDistributor = (q) => (q.intent ?? []).some((i) => i.$?.['tools:node'] === 'remove' && named(i.action, DISTRIBUTOR[0]));

/** The manifest with each of the connector's entries marked for removal, once. The one given is not changed. */
function removePush(manifest) {
  const [application, ...rest] = manifest.application ?? [];
  if (!application) throw new Error('withNoPush: the manifest has no <application> to remove the connector from');
  // In the first <queries>: Gradle merges a library's <queries> into the app's first, and a removal in another of
  // the app's is not applied to it (seen in Karto PoS's merged manifest).
  const [first, ...others] = manifest.queries ?? [];
  const intents = DISTRIBUTOR.map((action) => ({ $: { 'tools:node': 'remove' }, action: [{ $: { 'android:name': action } }] }));
  const queries = first && removesDistributor(first) ? [first, ...others] : [{ ...first, intent: [...(first?.intent ?? []), ...intents] }, ...others];
  return {
    ...manifest,
    $: { ...manifest.$, 'xmlns:tools': TOOLS },
    'uses-permission': withRemoved(manifest['uses-permission'], WAKE_LOCK),
    queries,
    application: [
      {
        ...application,
        receiver: withRemoved(application.receiver, RECEIVER),
        service: withRemoved(application.service, SERVICE),
        activity: withRemoved(application.activity, ACTIVITY),
      },
      ...rest,
    ],
  };
}

module.exports = function withNoPush(config) {
  return withAndroidManifest(config, (c) => {
    c.modResults.manifest = removePush(c.modResults.manifest);
    return c;
  });
};
module.exports.removePush = removePush;
