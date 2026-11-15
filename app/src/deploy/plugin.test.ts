import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addDeployAssets } = require('../../plugins/withDeployAssets') as { addDeployAssets: (gradle: string) => string };

const OLD = 'android.sourceSets.main.assets.srcDirs += ["../../deploy-assets"] // withDeployAssets';

describe('withDeployAssets', () => {
  it('adds the assets dir and remakes the bundle before every build', () => {
    const out = addDeployAssets('android {\n}\n');
    expect(out).toContain('android.sourceSets.main.assets.srcDirs += ["../../deploy-assets"]');
    expect(out).toContain('commandLine "make", "app-deploy-assets"');
    expect(out).toContain('preBuild.dependsOn(cardAppDeployAssets)');
  });
  it('is idempotent', () => {
    const once = addDeployAssets('android {\n}\n');
    expect(addDeployAssets(once)).toBe(once);
  });
  // An android/ made by an older plugin already has the one-line version: replace it.
  it('upgrades the older one-line version', () => {
    const out = addDeployAssets(`android {\n}\n\n${OLD}\n`);
    expect(out).not.toContain(OLD);
    expect(out.match(/srcDirs \+=/g)).toHaveLength(1);
    expect(out).toContain('preBuild.dependsOn(cardAppDeployAssets)');
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addPosQuery } = require('../../plugins/withPosQuery') as { addPosQuery: (manifest: { queries?: unknown[] }) => { queries?: unknown[] } };

// Karto Wallet may see one other app, Karto PoS, so that it can check who signed it before handing it a pairing code.
describe('withPosQuery', () => {
  const POS = { package: [{ $: { 'android:name': 'app.cardapp.pos' } }] };
  it("lets the app see Karto PoS's package, beside what it could see already", () => {
    const https = { intent: [{ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }] }] };
    expect(addPosQuery({ queries: [https] }).queries).toEqual([https, POS]);
    expect(addPosQuery({}).queries).toEqual([POS]);
  });
  it('is idempotent', () => {
    const once = addPosQuery({});
    expect(addPosQuery(once).queries).toEqual([POS]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addWalletQuery } = require('../../plugins/withWalletQuery') as { addWalletQuery: (manifest: { queries?: unknown[] }) => { queries?: unknown[] } };

// Karto PoS may see one other app, Karto Wallet: Android tells an app of updates only to apps it can see, and the
// wallet's update under the till turned the till's reader mode off.
describe('withWalletQuery', () => {
  const WALLET = { package: [{ $: { 'android:name': 'app.cardapp' } }] };
  it("lets the app see Karto Wallet's package, beside what it could see already", () => {
    const https = { intent: [{ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }] }] };
    expect(addWalletQuery({ queries: [https] }).queries).toEqual([https, WALLET]);
    expect(addWalletQuery({}).queries).toEqual([WALLET]);
  });
  it('is idempotent', () => {
    expect(addWalletQuery(addWalletQuery({})).queries).toEqual([WALLET]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setMinSdk } = require('../../plugins/withAndroid9') as { setMinSdk: (properties: { type: string; key?: string; value?: string }[]) => { type: string; key?: string; value?: string }[] };

// Karto Wallet needs Android 9 (API 28) or later: below it Android checks the signature made with the public debug
// key, the first of the apps' signing lineage, so anyone could sign an update that installs over the wallet with its
// data. Karto PoS keeps Expo's floor (Android 7), so an old phone can be a till.
describe('withAndroid9', () => {
  const FLOOR = { type: 'property', key: 'android.minSdkVersion', value: '28' };
  it("sets Gradle's android.minSdkVersion to 28, beside the other properties", () => {
    const other = { type: 'property', key: 'hermesEnabled', value: 'true' };
    expect(setMinSdk([other])).toEqual([other, FLOOR]);
  });
  it('replaces one already there, once', () => {
    expect(setMinSdk([{ type: 'property', key: 'android.minSdkVersion', value: '24' }])).toEqual([FLOOR]);
    expect(setMinSdk(setMinSdk([]))).toEqual([FLOOR]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setIdleTimeout } = require('../../plugins/withGradleDaemon') as { setIdleTimeout: (properties: { type: string; key?: string; value?: string }[]) => { type: string; key?: string; value?: string }[] };

// Builds come hours apart, so a warm Gradle daemon (with its Kotlin daemon and workers, ~9 GB together) only held
// memory and filled the build machine's swap: every daemon quits after a minute idle.
describe('withGradleDaemon', () => {
  const TIMEOUT = { type: 'property', key: 'org.gradle.daemon.idletimeout', value: '60000' };
  it("sets Gradle's daemon idle timeout to a minute, beside the other properties", () => {
    const other = { type: 'property', key: 'hermesEnabled', value: 'true' };
    expect(setIdleTimeout([other])).toEqual([other, TIMEOUT]);
  });
  it('replaces one already there, once', () => {
    expect(setIdleTimeout([{ type: 'property', key: 'org.gradle.daemon.idletimeout', value: '10800000' }])).toEqual([TIMEOUT]);
    expect(setIdleTimeout(setIdleTimeout([]))).toEqual([TIMEOUT]);
  });
});

type Named = { $: Record<string, string> };
type Manifest = {
  'uses-feature'?: Named[];
  'uses-permission'?: Named[];
  queries?: { package?: Named[]; intent?: unknown[] }[];
  application?: ({ $?: Record<string, string>; service?: (Named & Record<string, unknown>)[]; activity?: Named[] })[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addPhoneCard } = require('../../plugins/withPhoneCard') as { addPhoneCard: (manifest: Manifest) => Manifest };

// Karto Wallet's manifest alone declares the service that answers
// a till, so Karto PoS can never be a card though the module's code is in both apps.
describe('withPhoneCard', () => {
  const SERVICE = {
    $: { 'android:name': 'app.cardapp.cardnative.PhoneCardService', 'android:exported': 'true', 'android:permission': 'android.permission.BIND_NFC_SERVICE' },
    'intent-filter': [{ action: [{ $: { 'android:name': 'android.nfc.cardemulation.action.HOST_APDU_SERVICE' } }] }],
    'meta-data': [{ $: { 'android:name': 'android.nfc.cardemulation.host_apdu_service', 'android:resource': '@xml/phone_card_apdu' } }],
  };
  const HCE = { $: { 'android:name': 'android.hardware.nfc.hce', 'android:required': 'false' } };
  const VIBRATE = { $: { 'android:name': 'android.permission.VIBRATE' } };

  it('declares the service behind the NFC permission, the feature as not required, and the buzz, beside what was there', () => {
    const camera = { $: { 'android:name': 'android.hardware.camera', 'android:required': 'false' } };
    const internet = { $: { 'android:name': 'android.permission.INTERNET' } };
    const other = { $: { 'android:name': 'expo.modules.Something' } };
    const main = { $: { 'android:name': '.MainActivity' } };
    const out = addPhoneCard({ 'uses-feature': [camera], 'uses-permission': [internet], application: [{ $: { 'android:name': '.MainApplication' }, service: [other], activity: [main] }] });
    expect(out['uses-feature']).toEqual([camera, HCE]);
    expect(out['uses-permission']).toEqual([internet, VIBRATE]);
    expect(out.application).toEqual([{ $: { 'android:name': '.MainApplication' }, service: [other, SERVICE], activity: [main] }]);
  });

  it('makes the lists a bare manifest lacks', () => {
    expect(addPhoneCard({ application: [{}] })).toEqual({ 'uses-feature': [HCE], 'uses-permission': [VIBRATE], application: [{ service: [SERVICE] }] });
  });

  it('is idempotent, and does not change the manifest it was given', () => {
    const given: Manifest = { application: [{ service: [] }] };
    const once = addPhoneCard(given);
    expect(addPhoneCard(once)).toEqual(once);
    expect(given).toEqual({ application: [{ service: [] }] });
  });

  it('fails the build, loudly, on a manifest with no application', () => {
    expect(() => addPhoneCard({})).toThrow(/withPhoneCard/);
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addAlerts } = require('../../plugins/withAlerts') as { addAlerts: (manifest: Manifest) => Manifest };

// Karto Wallet's manifest alone declares the service UnifiedPush's
// connector hands alerts to, the permission Android 13 asks before one shows, and ntfy among the apps it sees.
describe('withAlerts', () => {
  const SERVICE = {
    $: { 'android:name': 'app.cardapp.cardnative.AlertService', 'android:exported': 'false' },
    'intent-filter': [{ action: [{ $: { 'android:name': 'org.unifiedpush.android.connector.PUSH_EVENT' } }] }],
  };
  const NOTIFY = { $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } };
  const NTFY = { package: [{ $: { 'android:name': 'io.heckel.ntfy' } }] };

  it('declares the service, not exported, with the permission and ntfy, beside what was there', () => {
    const internet = { $: { 'android:name': 'android.permission.INTERNET' } };
    const pos = { package: [{ $: { 'android:name': 'app.cardapp.pos' } }] };
    const card = { $: { 'android:name': 'app.cardapp.cardnative.PhoneCardService' } };
    const main = { $: { 'android:name': '.MainActivity' } };
    const out = addAlerts({ 'uses-permission': [internet], queries: [pos], application: [{ $: { 'android:name': '.MainApplication' }, service: [card], activity: [main] }] });
    expect(out['uses-permission']).toEqual([internet, NOTIFY]);
    expect(out.queries).toEqual([pos, NTFY]);
    expect(out.application).toEqual([{ $: { 'android:name': '.MainApplication' }, service: [card, SERVICE], activity: [main] }]);
  });

  it('makes the lists a bare manifest lacks', () => {
    expect(addAlerts({ application: [{}] })).toEqual({ 'uses-permission': [NOTIFY], queries: [NTFY], application: [{ service: [SERVICE] }] });
  });

  it('is idempotent, and does not change the manifest it was given', () => {
    const given: Manifest = { application: [{ service: [] }] };
    const once = addAlerts(given);
    expect(addAlerts(once)).toEqual(once);
    expect(given).toEqual({ application: [{ service: [] }] });
  });

  it('fails the build, loudly, on a manifest with no application', () => {
    expect(() => addAlerts({})).toThrow(/withAlerts/);
  });
});

type PushManifest = Manifest & {
  $?: Record<string, string>;
  queries?: { package?: Named[]; intent?: (Named & { action?: Named[] })[] }[];
  application?: ({ $?: Record<string, string>; service?: Named[]; activity?: Named[]; receiver?: Named[] })[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { removePush } = require('../../plugins/withNoPush') as { removePush: (manifest: PushManifest) => PushManifest };

// Karto PoS gets no alerts, so the connector the shared card-native
// module brings is taken out of its manifest: its receiver, service, activity, wake lock and distributor queries.
describe('withNoPush', () => {
  const gone = (name: string) => ({ $: { 'android:name': name, 'tools:node': 'remove' } });
  const UP = 'org.unifiedpush.android.connector.internal.';
  const DISTRIBUTOR = ['LINK', 'REGISTER', 'UNREGISTER'].map((a) => ({ $: { 'tools:node': 'remove' }, action: [{ $: { 'android:name': `org.unifiedpush.android.distributor.${a}` } }] }));

  it("marks the connector's receiver, service, activity, the wake lock and the distributor queries for removal, beside what was there", () => {
    const internet = { $: { 'android:name': 'android.permission.INTERNET' } };
    const https = { $: {}, action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }] };
    const wallet = { package: [{ $: { 'android:name': 'app.cardapp' } }] };
    const main = { $: { 'android:name': '.MainActivity' } };
    const out = removePush({
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      'uses-permission': [internet],
      queries: [{ intent: [https] }, wallet],
      application: [{ $: { 'android:name': '.MainApplication' }, activity: [main] }],
    });
    expect(out.$).toEqual({ 'xmlns:android': 'http://schemas.android.com/apk/res/android', 'xmlns:tools': 'http://schemas.android.com/tools' });
    expect(out['uses-permission']).toEqual([internet, gone('android.permission.WAKE_LOCK')]);
    // In the first <queries>, which Gradle merges the connector's into: a removal in another isn't applied to it.
    expect(out.queries).toEqual([{ intent: [https, ...DISTRIBUTOR] }, wallet]);
    expect(out.application).toEqual([
      {
        $: { 'android:name': '.MainApplication' },
        receiver: [gone(`${UP}MessagingReceiverImpl`)],
        service: [gone(`${UP}RaiseToForegroundService`)],
        activity: [main, gone(`${UP}LinkActivity`)],
      },
    ]);
  });

  it('makes the <queries> a manifest lacks', () => {
    expect(removePush({ application: [{}] }).queries).toEqual([{ intent: DISTRIBUTOR }]);
  });

  it('is idempotent, and does not change the manifest it was given', () => {
    const given: PushManifest = { application: [{}] };
    const once = removePush(given);
    expect(removePush(once)).toEqual(once);
    expect(given).toEqual({ application: [{}] });
  });

  it('fails the build, loudly, on a manifest with no application', () => {
    expect(() => removePush({})).toThrow(/withNoPush/);
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { linkOnce } = require('../../plugins/withLinkOnce') as { linkOnce: (kotlin: string) => string };

// Karto PoS's links act (they pair the phone), so a link opens the app once: Android's copy of it is cleared when
// it remakes the activity, and a link that arrives while the app is starting replaces the one it started with.
describe('withLinkOnce', () => {
  const MAIN = `package app.cardapp.pos
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    SplashScreenManager.registerOnActivity(this)
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;
  it("clears a remade activity's link before React reads it, and keeps the newest link as the activity's", () => {
    const out = linkOnce(MAIN);
    expect(out).toContain('import android.content.Intent\n');
    const create = out.slice(out.indexOf('override fun onCreate'), out.indexOf('super.onCreate(null)'));
    expect(create).toContain('if (savedInstanceState != null || (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {');
    expect(create).toContain('intent = Intent(intent).setData(null)');
    expect(out).toMatch(/override fun onNewIntent\(intent: Intent\) \{\n\s+setIntent\(intent\)\n\s+super\.onNewIntent\(intent\)\n\s+\}/);
    expect(out).toContain('override fun getMainComponentName(): String = "main"');
  });
  it('is idempotent', () => {
    const once = linkOnce(MAIN);
    expect(linkOnce(once)).toBe(once);
  });
  it('fails the build, loudly, on a MainActivity it does not know', () => {
    expect(() => linkOnce('class MainActivity : ReactActivity() {}')).toThrow(/withLinkOnce/);
  });
});

// The iPhone app carries the same folder, copied into the app by a build step.
describe('withDeployAssets, the iPhone app', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const plugin = require('../../plugins/withDeployAssets') as {
    addDeployAssetsPhase: <P extends FakeProject>(project: P) => P;
    IOS_PHASE: string;
    IOS_SCRIPT: string;
  };
  type Phase = { comment: string; type: string; target: string; options: { shellPath: string; shellScript: string } };
  type FakeProject = {
    phases: Phase[];
    pbxItemByComment(comment: string, type: string): Phase | null;
    getFirstTarget(): { uuid: string };
    addBuildPhase(files: string[], type: string, comment: string, target: string, options: Phase['options']): void;
  };
  const fake = (): FakeProject => ({
    phases: [],
    pbxItemByComment(comment, type) {
      return this.phases.find((p) => p.comment === comment && p.type === type) ?? null;
    },
    getFirstTarget: () => ({ uuid: 'APP' }),
    addBuildPhase(_files, type, comment, target, options) {
      this.phases.push({ comment, type, target, options });
    },
  });

  it('adds one script phase to the app target', () => {
    const p = plugin.addDeployAssetsPhase(fake());
    expect(p.phases).toHaveLength(1);
    expect(p.phases[0]).toMatchObject({ comment: plugin.IOS_PHASE, type: 'PBXShellScriptBuildPhase', target: 'APP' });
    expect(p.phases[0].options.shellScript).toBe(plugin.IOS_SCRIPT);
  });
  it('is idempotent', () => {
    const p = plugin.addDeployAssetsPhase(plugin.addDeployAssetsPhase(fake()));
    expect(p.phases).toHaveLength(1);
  });
  // The folder is made on Linux and brought over: a build without it must stop, not ship an app with no server.
  it('stops the build when the bundle is missing, and never rebuilds it', () => {
    expect(plugin.IOS_SCRIPT).toContain('manifest.json" ]; then');
    expect(plugin.IOS_SCRIPT).toContain('exit 1');
    expect(plugin.IOS_SCRIPT).not.toMatch(/^\s*make /m);
  });
  it('copies into the app bundle as deploy-assets, with no file left executable', () => {
    expect(plugin.IOS_SCRIPT).toContain('${UNLOCALIZED_RESOURCES_FOLDER_PATH}/deploy-assets');
    expect(plugin.IOS_SCRIPT).toContain('chmod -R a-x,a+X');
  });
});
