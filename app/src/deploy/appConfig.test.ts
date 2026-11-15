import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const appConfig = require('../../app.config.js') as ((o: { config: Expo }) => Expo) & { withDiagnostics: (config: Expo, env: Record<string, string | undefined>) => Expo };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { expo } = require('../../app.json') as { expo: Expo };

type Expo = {
  name: string;
  ios: { bundleIdentifier: string; supportsTablet: boolean; infoPlist: Record<string, unknown>; entitlements: Record<string, unknown> };
  android: { package: string };
  plugins: unknown[];
};

describe("the app's iPhone settings (app.json)", () => {
  it('names the development identifier, not a store\'s, and is not for tablets', () => {
    expect(expo.ios.bundleIdentifier).toBe('tech.whitewolf.karto.dev');
    expect(expo.ios.supportsTablet).toBe(false);
  });

  it('carries the card reader\'s line, its entitlement and the NTAG 424 DNA\'s application ID, and the Face ID line', () => {
    expect(expo.ios.infoPlist.NFCReaderUsageDescription).toBe('Karto Wallet reads and sets up your Bolt Cards.');
    expect(expo.ios.infoPlist['com.apple.developer.nfc.readersession.iso7816.select-identifiers']).toEqual(['D2760000850101']);
    expect(expo.ios.entitlements).toEqual({ 'com.apple.developer.nfc.readersession.formats': ['TAG'] });
    expect(expo.ios.infoPlist.NSFaceIDUsageDescription).toBe('Karto Wallet asks for Face ID before it shows your recovery phrase, wipes a card or changes your server.');
  });

  it("carries the camera's line, which iOS shows under its question", () => {
    expect(expo.ios.infoPlist.NSCameraUsageDescription).toBe('Karto Wallet uses the camera to scan a QR code you want to pay and to photograph your cards.');
  });

  // The exact list: no microphone and no photo library (the cameras record no sound and keep nothing on the
  // phone), and the test server on the local network is the diagnostics app's alone.
  it('asks for nothing else: no microphone, no photo library, no local network', () => {
    expect(Object.keys(expo.ios.infoPlist).sort()).toEqual([
      'NFCReaderUsageDescription', 'NSCameraUsageDescription', 'NSFaceIDUsageDescription', 'com.apple.developer.nfc.readersession.iso7816.select-identifiers',
    ]);
  });

  it('packs the three Inter files for the iPhone as it does for Android', () => {
    const font = expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-font') as [string, { ios: { fonts: string[] }; android: { fonts: { fontDefinitions: { path: string }[] }[] } }];
    expect(font[1].ios.fonts).toEqual(['./assets/fonts/Inter-Regular.ttf', './assets/fonts/Inter-SemiBold.ttf', './assets/fonts/Inter-Bold.ttf']);
    expect(font[1].android.fonts[0].fontDefinitions.map((d) => d.path)).toEqual(font[1].ios.fonts);
  });

  it('leaves Android as it was', () => {
    expect(expo.android.package).toBe('app.cardapp');
  });
});

describe('the diagnostics app (app.config.js)', () => {
  it('is the app as app.json has it when no diagnostics are asked for', () => {
    expect(appConfig.withDiagnostics(expo, {})).toEqual(expo);
    expect(appConfig.withDiagnostics(expo, { EXPO_PUBLIC_DIAG_SSH: '' })).toEqual(expo);
  });

  it('has its own name on an iPhone and the local-network line, and nothing else differs', () => {
    const diag = appConfig.withDiagnostics(expo, { EXPO_PUBLIC_DIAG_SSH: '192.168.1.10:12224:debian:AAAA:ab' });
    expect(diag.ios.infoPlist).toEqual({
      ...expo.ios.infoPlist,
      CFBundleDisplayName: 'Karto Diagnostics',
      NSLocalNetworkUsageDescription: 'Karto Diagnostics reaches a test server on this network.',
    });
    expect({ ...diag, ios: { ...diag.ios, infoPlist: expo.ios.infoPlist } }).toEqual(expo);
    // The wallet's own identifier, so the ordinary build installs over it.
    expect(diag.ios.bundleIdentifier).toBe(expo.ios.bundleIdentifier);
    // app.json's own object is not changed by it.
    expect(expo.ios.infoPlist.CFBundleDisplayName).toBeUndefined();
  });

  it('is what Expo is given', () => {
    expect(appConfig({ config: expo })).toEqual(appConfig.withDiagnostics(expo, process.env));
  });
});
