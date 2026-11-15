import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8')) as {
  expo: { android: { blockedPermissions?: string[] }; plugins: unknown[] };
};

// The release APK's manifest has neither storage permission.
// expo-file-system declares both (up to Android 12); the app only uses its own cache and files folders.
describe('app.json', () => {
  it('blocks the storage permissions a library declares', () => {
    expect(config.expo.android.blockedPermissions).toEqual(
      expect.arrayContaining(['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE']),
    );
  });

  it("doesn't block the camera, which the card camera and the QR scanner need", () => {
    expect(config.expo.android.blockedPermissions).not.toContain('android.permission.CAMERA');
  });
});
