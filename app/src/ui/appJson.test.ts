import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Plugin = string | [string, Record<string, unknown>];
type Expo = {
  name: string; slug: string; scheme: string; userInterfaceStyle: string; icon: string;
  android: { package: string; adaptiveIcon: Record<string, string> };
  plugins: Plugin[];
};

/** app/ */
const APP = new URL('../../', import.meta.url);
const expo = (JSON.parse(readFileSync(new URL('app.json', APP), 'utf8')) as { expo: Expo }).expo;
const plugin = (name: string) => expo.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
const file = (path: string) => readFileSync(new URL(path, APP));
/** A PNG's width and height, from its IHDR chunk. */
const pngSize = (path: string) => {
  const b = file(path);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

/** Inter 4.1's static files (extras/ttf/ in the release's zip), by SHA-256. */
const INTER: Record<string, string> = {
  './assets/fonts/Inter-Regular.ttf': '40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82',
  './assets/fonts/Inter-SemiBold.ttf': '78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3',
  './assets/fonts/Inter-Bold.ttf': '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f',
};

// The name, following the phone, Inter, the splash and the icon.
describe('app.json', () => {
  // The app is Karto Wallet, and says so on its screens; under its icon it stays "Karto"
  // (a Pixel 8 Pro's launcher cut "Karto Wallet" short to "Karto Wal…").
  it('is Karto under its icon, and keeps every name an installed app and the phone scripts rely on', () => {
    expect(expo.name).toBe('Karto');
    expect(expo.slug).toBe('card-app');
    expect(expo.scheme).toBe('karto');
    expect(expo.android.package).toBe('tech.whitewolf.karto.dev');
  });

  it('follows the phone between light and dark', () => {
    expect(expo.userInterfaceStyle).toBe('automatic');
    expect(plugin('expo-system-ui')).toBe('expo-system-ui');
  });

  it("bundles Inter's three weights as one family, by the font plugin's object form", () => {
    expect(plugin('expo-font')).toEqual([
      'expo-font',
      {
        // The iPhone takes the files as they are: the family and the weights are read from the files themselves.
        ios: { fonts: ['./assets/fonts/Inter-Regular.ttf', './assets/fonts/Inter-SemiBold.ttf', './assets/fonts/Inter-Bold.ttf'] },
        android: {
          fonts: [
            {
              fontFamily: 'Inter',
              fontDefinitions: [
                { path: './assets/fonts/Inter-Regular.ttf', weight: 400 },
                { path: './assets/fonts/Inter-SemiBold.ttf', weight: 600 },
                { path: './assets/fonts/Inter-Bold.ttf', weight: 700 },
              ],
            },
          ],
        },
      },
    ]);
    for (const [path, sha] of Object.entries(INTER)) expect(createHash('sha256').update(file(path)).digest('hex')).toBe(sha);
    expect(existsSync(new URL('assets/fonts/LICENSE.txt', APP))).toBe(true);
  });

  it("shows the splash on the charcoal, the icon's card as its image", () => {
    expect(plugin('expo-splash-screen')).toEqual(['expo-splash-screen', { backgroundColor: '#24292f', image: './assets/splash-icon.png', imageWidth: 200 }]);
  });

  it('draws the adaptive icon on the charcoal, with no background image', () => {
    expect(expo.android.adaptiveIcon).toEqual({
      backgroundColor: '#24292f',
      foregroundImage: './assets/android-icon-foreground.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    });
    expect(expo.icon).toBe('./assets/icon.png');
  });

  it('has every icon and splash image, at 1024 by 1024', () => {
    for (const p of ['./assets/icon.png', './assets/android-icon-foreground.png', './assets/android-icon-monochrome.png', './assets/splash-icon.png']) {
      expect(pngSize(p)).toEqual([1024, 1024]);
    }
  });
});
