import { afterEach, describe, expect, it, vi } from 'vitest';

// deploy/test/release-apk.sh puts KARTO_STORE into the
// bundle as EXPO_PUBLIC_KARTO_STORE, which Metro inlines; the module is read afresh for each value.
async function isPlayBuildWith(store: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (store !== undefined) vi.stubEnv('EXPO_PUBLIC_KARTO_STORE', store);
  return (await import('./store')).isPlayBuild;
}

describe('isPlayBuild', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is true on the Play build alone', async () => {
    expect(await isPlayBuildWith('play')).toBe(true);
    expect(await isPlayBuildWith('')).toBe(false);
    expect(await isPlayBuildWith(undefined)).toBe(false);
  });
});
