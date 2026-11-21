import { describe, expect, it } from 'vitest';
import { buildLabel, bundleFromManifest, bundleSha, loadBuildInfo, loadManifest } from './bundle';

describe('bundleFromManifest', () => {
  it('streams every file from the APK assets under deploy/', () => {
    const files = bundleFromManifest([
      { path: 'install.sh', mode: 0o755, size: 10, sha256: 'aa' },
      { path: 'bin/cardd', mode: 0o755, size: 11_088_034, sha256: 'bb' },
    ]);
    expect(files).toEqual([
      { path: 'install.sh', mode: 0o755, sha256: 'aa', asset: 'deploy/install.sh', size: 10 },
      { path: 'bin/cardd', mode: 0o755, sha256: 'bb', asset: 'deploy/bin/cardd', size: 11_088_034 },
    ]);
  });
  it('refuses a build without the cardd binary', () => {
    expect(() => bundleFromManifest([{ path: 'install.sh', mode: 0o755, size: 1, sha256: 'aa' }])).toThrow('without the cardd binary');
  });
});

describe('bundleSha', () => {
  const a = { path: 'install.sh', mode: 0o755, size: 10, sha256: 'aa' };
  const b = { path: 'bin/cardd', mode: 0o755, size: 11, sha256: 'bb' };
  it('is the sha256 of the sha256sum lines, sorted by path', () => {
    // printf 'bb  bin/cardd\naa  install.sh\n' | sha256sum
    expect(bundleSha([a, b])).toBe('d30aaedd373ca5539d7aa80da967bd1f750a6099b19a6147e7890307abdc2621');
    expect(bundleSha([b, a])).toBe(bundleSha([a, b]));
  });
  it('changes when any file does', () => {
    expect(bundleSha([a, { ...b, sha256: 'bc' }])).not.toBe(bundleSha([a, b]));
    expect(bundleSha([a, { ...b, path: 'bin/carde' }])).not.toBe(bundleSha([a, b]));
  });
});

// The list of files and hashes comes from the APK's own assets, the same build step that packs
// the files: a JS bundle built earlier (expo run:android bundles before Gradle) can't go stale.
describe('loadManifest', () => {
  const entry = { path: 'bin/cardd', mode: 0o755, size: 2, sha256: 'bb'.repeat(32) };
  const native = (text: string) => ({ readAssetText: async (path: string) => (path === 'manifest.json' ? text : '') });

  it('reads the manifest packed in the APK', async () => {
    expect(await loadManifest(native(JSON.stringify([entry])))).toEqual([entry]);
  });

  it('refuses a manifest that is not a list of files with hashes', async () => {
    await expect(loadManifest(native('{"path":"x"}'))).rejects.toThrow('manifest');
    await expect(loadManifest(native(JSON.stringify([{ ...entry, sha256: 'zz' }])))).rejects.toThrow('manifest');
  });
});

// How to tell the latest app is installed: every build of a version has the same number.
describe('the build label', () => {
  const native = (files: Record<string, string>) => ({
    readAssetText: async (path: string) => (path in files ? files[path] : Promise.reject(new Error(`no asset ${path}`))),
  });

  it('reads the commit and build time packed in the APK', async () => {
    const b = await loadBuildInfo(native({ 'build.json': '{"commit":"4722797","builtAt":1791364500}' }));
    expect(b).toEqual({ commit: '4722797', builtAt: 1_791_364_500 });
    expect(buildLabel(b, 1_791_364_500 + 3600, 60)).toBe('Karto Wallet 4722797, built today at 10:15');
    expect(buildLabel({ commit: '4722797-dirty', builtAt: 1_791_364_500 }, 1_791_364_500 + 2 * 86_400, 0)).toBe('Karto Wallet 4722797-dirty, built 7 Oct at 09:15');
  });

  it('says so when the APK has none, or a malformed one', async () => {
    expect(await loadBuildInfo(native({}))).toBeNull();
    expect(await loadBuildInfo(native({ 'build.json': '{"commit":4}' }))).toBeNull();
    expect(buildLabel(null)).toBe('Karto Wallet build unknown');
  });
});
