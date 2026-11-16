import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KARTO_POS } from '../wallet/posLaunch';

type Plugin = string | [string, Record<string, unknown>];
type Expo = {
  name: string; slug: string; scheme: string; icon: string;
  android: { package: string; adaptiveIcon: Record<string, string>; permissions?: string[]; blockedPermissions?: string[] };
  ios: { bundleIdentifier: string; supportsTablet: boolean; infoPlist: Record<string, unknown>; entitlements: Record<string, unknown> };
  plugins: Plugin[];
};

/** app/ */
const APP = new URL('../../', import.meta.url);
const require = createRequire(import.meta.url);
const { forVariant, VARIANTS, checkStore, IDS, idOf } = require('../../variant.js') as {
  forVariant: (expo: Expo, variant?: string) => Expo; VARIANTS: string[]; checkStore: (variant?: string, store?: string) => void;
  IDS: Record<'wallet' | 'pos', string>; idOf: (variant?: string) => string;
};
const appConfig = require('../../app.config.js') as (o: { config: Expo }) => Expo;
const json = () => (JSON.parse(readFileSync(new URL('app.json', APP), 'utf8')) as { expo: Expo }).expo;
const names = (e: Expo) => e.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
const plugin = (e: Expo, name: string) => e.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);

// One setting, APP_VARIANT, chooses the app.
describe('app.config.js', () => {
  it("leaves Karto Wallet's config as app.json has it, with no setting and with wallet", () => {
    expect(forVariant(json(), undefined)).toEqual(json());
    expect(forVariant(json(), '')).toEqual(json());
    expect(forVariant(json(), 'wallet')).toEqual(json());
    expect(VARIANTS).toEqual(['wallet', 'pos']);
  });

  it("names both apps by the publisher's identifiers, with .dev on every build made now, the same on both platforms", () => {
    expect(IDS).toEqual({ wallet: 'tech.whitewolf.karto', pos: 'tech.whitewolf.kartopos' });
    expect([idOf(), idOf('wallet'), idOf('pos')]).toEqual(['tech.whitewolf.karto.dev', 'tech.whitewolf.karto.dev', 'tech.whitewolf.kartopos.dev']);
    // app.json repeats the wallet's, which Expo reads as it is.
    expect([json().android.package, json().ios.bundleIdentifier]).toEqual([idOf('wallet'), idOf('wallet')]);
    const pos = forVariant(json(), 'pos');
    expect([pos.android.package, pos.ios.bundleIdentifier]).toEqual([idOf('pos'), idOf('pos')]);
    // The wallet starts Karto PoS by this name and Expo puts its MainActivity in the package of that name.
    expect(KARTO_POS).toEqual({ packageName: idOf('pos'), className: `${idOf('pos')}.MainActivity` });
  });

  it('refuses a setting that names no app', () => {
    expect(() => forVariant(json(), 'till')).toThrow('APP_VARIANT is "till": it must be wallet or pos');
  });

  it("gives Karto PoS its own name, link scheme, package and slug, so it installs beside Karto Wallet", () => {
    const pos = forVariant(json(), 'pos');
    expect([pos.name, pos.slug, pos.scheme, pos.android.package]).toEqual(['Karto PoS', 'karto-pos', 'kartopos', 'tech.whitewolf.kartopos.dev']);
    expect(pos.android.package).not.toBe(json().android.package);
  });

  it('gives it its own icon and splash files, which exist', () => {
    const pos = forVariant(json(), 'pos');
    const files = [pos.icon, pos.android.adaptiveIcon.foregroundImage, pos.android.adaptiveIcon.monochromeImage, (plugin(pos, 'expo-splash-screen') as [string, { image: string }])[1].image];
    for (const f of files) {
      expect(f).toMatch(/^\.\/assets\/pos\//);
      expect(readFileSync(new URL(f, APP)).subarray(1, 4).toString()).toBe('PNG');
    }
    // The launcher's icon is told from Karto Wallet's by its drawing (the card held to a till), on the same charcoal.
    expect(pos.android.adaptiveIcon.backgroundColor).toBe('#24292f');
    expect(json().android.adaptiveIcon.backgroundColor).toBe('#24292f');
    expect(pos.android.adaptiveIcon.foregroundImage).not.toBe(json().android.adaptiveIcon.foregroundImage);
    // Everything else of the splash is the wallet's.
    expect(plugin(pos, 'expo-splash-screen')).toEqual(['expo-splash-screen', { backgroundColor: '#24292f', image: './assets/pos/splash-icon.png', imageWidth: 200 }]);
  });

  it("takes its screens from src/pos-app, the router's root", () => {
    // No sitemap: the router's own _sitemap screen is in every build unless it is turned off, any app can open it by
    // a link, and on a phone it throws (found on the Pixel 8 Pro: kartopos://_sitemap closed Karto PoS).
    expect(plugin(forVariant(json(), 'pos'), 'expo-router')).toEqual(['expo-router', { root: 'src/pos-app', sitemap: false }]);
    // The wallet has no sitemap either: karto://_sitemap closed it the same way (seen on the Pixel 8 Pro).
    expect(plugin(json(), 'expo-router')).toEqual(['expo-router', { sitemap: false }]);
  });

  // With the sitemap go the router's other made-up routes, its "unmatched route" page among them: each app has its own.
  it('gives each app a screen of its own for a link to no screen', () => {
    expect(existsSync(new URL('src/app/+not-found.tsx', APP))).toBe(true);
    expect(existsSync(new URL('src/pos-app/+not-found.tsx', APP))).toBe(true);
  });

  it("leaves out the server files' plugin and the background task's, and keeps the rest in order", () => {
    const pos = forVariant(json(), 'pos');
    const walletOnly = ['./plugins/withDeployAssets', 'expo-background-task', './plugins/withPosQuery', './plugins/withPhoneCard', './plugins/withAlerts', './plugins/withAndroid9'];
    expect(names(pos)).toEqual([...names(json()).filter((n) => !walletOnly.includes(n)), './plugins/withLinkOnce', './plugins/withWalletQuery', './plugins/withNoPush', 'expo-local-authentication']);
    // Its links act, so each opens the app once; the wallet's only open a screen, behind its own guard.
    expect(names(json())).not.toContain('./plugins/withLinkOnce');
    // It sees Karto Wallet, and so hears of the wallet's updates, which can turn off its reader mode.
    expect(names(json())).not.toContain('./plugins/withWalletQuery');
    // It gets no alerts, so UnifiedPush's connector is taken out of its manifest; the wallet's keeps it.
    expect(names(json())).not.toContain('./plugins/withNoPush');
    expect(names(json())).toContain('./plugins/withPosQuery');
    // Android 9 up for the wallet only: an old phone can still be a till.
    expect(names(json())).toContain('./plugins/withAndroid9');
    expect(names(pos)).not.toContain('./plugins/withAndroid9');
    expect(names(pos)).not.toContain('./plugins/withDeployAssets');
    expect(names(pos)).not.toContain('expo-background-task');
  });

  // Builds of either app leave no Gradle daemon holding memory for hours.
  it("gives both apps' Gradle daemons a minute's idle timeout", () => {
    expect(names(json())).toContain('./plugins/withGradleDaemon');
    expect(names(forVariant(json(), 'pos'))).toContain('./plugins/withGradleDaemon');
  });

  // Only Karto Wallet's build declares the service that answers a
  // till as a card (and the buzz its pay screen gives); Karto PoS can never be one.
  it("declares the phone's card service in Karto Wallet's build alone", () => {
    expect(names(json())).toContain('./plugins/withPhoneCard');
    expect(names(forVariant(json(), 'pos'))).not.toContain('./plugins/withPhoneCard');
    expect(readFileSync(new URL('plugins/withPhoneCard.js', APP), 'utf8')).toContain('tech.whitewolf.karto.cardnative.PhoneCardService');
    // The module's own manifest, which is merged into both apps, names no service.
    expect(readFileSync(new URL('modules/card-native/android/src/main/AndroidManifest.xml', APP), 'utf8')).not.toMatch(/<service|nfc\.hce/);
  });

  // Alerts are Karto Wallet's; Karto PoS's till already
  // shows Paid, and a sale buzzes the owner's wallet.
  it("declares the alerts' service in Karto Wallet's build alone", () => {
    expect(names(json())).toContain('./plugins/withAlerts');
    expect(names(forVariant(json(), 'pos'))).not.toContain('./plugins/withAlerts');
    expect(readFileSync(new URL('plugins/withAlerts.js', APP), 'utf8')).toContain('tech.whitewolf.karto.cardnative.AlertService');
  });

  it('may vibrate, and blocks the storage permissions as the wallet does', () => {
    const pos = forVariant(json(), 'pos');
    expect(pos.android.permissions).toEqual(['android.permission.VIBRATE']);
    expect(pos.android.blockedPermissions).toEqual(json().android.blockedPermissions);
  });

  // The till's own iPhone app, beside Karto Wallet.
  it('gives Karto PoS its own iPhone identifier and lines, and no Face ID line', () => {
    const pos = forVariant(json(), 'pos');
    expect(pos.ios.bundleIdentifier).toBe('tech.whitewolf.kartopos.dev');
    expect(pos.ios.infoPlist.NFCReaderUsageDescription).toBe('Karto PoS reads Bolt Cards to charge them.');
    expect(pos.ios.infoPlist.NSCameraUsageDescription).toBe('Karto PoS uses the camera to scan the pairing code Karto Wallet shows.');
    expect(pos.ios.infoPlist['com.apple.developer.nfc.readersession.iso7816.select-identifiers']).toEqual(['D2760000850101']);
    expect('NSFaceIDUsageDescription' in pos.ios.infoPlist).toBe(false);
    expect(pos.ios.entitlements).toEqual({ 'com.apple.developer.nfc.readersession.formats': ['TAG'] });
    expect(pos.ios.supportsTablet).toBe(false);
  });

  // expo-local-authentication and expo-secure-store each write a stock Face ID line unless told false, which deletes
  // it (@expo/config-plugins applyPermissions); Expo applies the first to every build even when app.json doesn't name it.
  it("tells the two Face ID plugins the till has no Face ID line; the wallet's keep their way", () => {
    const pos = forVariant(json(), 'pos');
    expect(plugin(pos, 'expo-secure-store')).toEqual(['expo-secure-store', { faceIDPermission: false }]);
    expect(plugin(pos, 'expo-local-authentication')).toEqual(['expo-local-authentication', { faceIDPermission: false }]);
    expect(plugin(json(), 'expo-secure-store')).toBe('expo-secure-store');
    expect(plugin(json(), 'expo-local-authentication')).toBeUndefined();
  });

  it("leaves the wallet's iOS section as app.json has it", () => {
    forVariant(json(), 'pos');
    expect(forVariant(json(), 'wallet').ios).toEqual(json().ios);
    expect(json().ios.bundleIdentifier).toBe('tech.whitewolf.karto.dev');
  });

  it("doesn't change the config it was given", () => {
    const given = json();
    forVariant(given, 'pos');
    expect(given).toEqual(json());
  });
});

// A build setting beside APP_VARIANT, KARTO_STORE=play, adds
// UnifiedPush's embedded FCM distributor to Karto Wallet (the card-native module's build.gradle); unset, the build is
// Google-free. It changes no config, so android/ needn't be made afresh for it (deploy/test/prebuild.sh).
describe('KARTO_STORE', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is unset or play, for Karto Wallet', () => {
    for (const variant of [undefined, '', 'wallet']) {
      expect(() => checkStore(variant, undefined)).not.toThrow();
      expect(() => checkStore(variant, '')).not.toThrow();
      expect(() => checkStore(variant, 'play')).not.toThrow();
    }
    expect(() => checkStore('pos', undefined)).not.toThrow();
  });

  it('refuses a store it has no build for', () => {
    expect(() => checkStore('wallet', 'fdroid')).toThrow('KARTO_STORE is "fdroid": it must be play or unset');
  });

  it('refuses the Play build of Karto PoS, which is built Google-free only', () => {
    expect(() => checkStore('pos', 'play')).toThrow('KARTO_STORE=play is for Karto Wallet: Karto PoS is built Google-free only');
  });

  it('is checked by app.config.js, and changes nothing in the config', () => {
    vi.stubEnv('APP_VARIANT', 'pos');
    vi.stubEnv('KARTO_STORE', 'play');
    expect(() => appConfig({ config: json() })).toThrow('Karto PoS is built Google-free only');
    vi.stubEnv('APP_VARIANT', 'wallet');
    const play = appConfig({ config: json() });
    vi.stubEnv('KARTO_STORE', '');
    expect(play).toEqual(appConfig({ config: json() }));
  });
});
