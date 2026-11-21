// The deploy bundle inside the APK (scripts/deploy-assets.mjs) as BundleFiles.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { whenText } from '../money/format';
import type { BundleFile } from '../onboarding/install';

export type ManifestEntry = { path: string; mode: number; size: number; sha256: string };

/** Every file is streamed from the APK's assets, under deploy/. */
export function bundleFromManifest(manifest: ManifestEntry[]): BundleFile[] {
  if (!manifest.some((f) => f.path === 'bin/cardd')) throw new Error('the app was built without the cardd binary');
  return manifest.map((f) => ({ path: f.path, mode: f.mode, sha256: f.sha256, asset: `deploy/${f.path}`, size: f.size }));
}

/**
 * One hash for the whole bundle: sha256 of its `sha256sum` lines, sorted by
 * path. Recorded on the server at install (meta bundle.sha256), so the app can
 * tell when it carries a different server and offer "Update server".
 */
export function bundleSha(manifest: Pick<ManifestEntry, 'path' | 'sha256'>[]): string {
  const lines = [...manifest]
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
    .map((f) => `${f.sha256}  ${f.path}\n`)
    .join('');
  return bytesToHex(sha256(utf8ToBytes(lines)));
}

const isEntry = (e: unknown): e is ManifestEntry => {
  const f = e as ManifestEntry;
  return !!f && typeof f.path === 'string' && Number.isInteger(f.mode) && Number.isInteger(f.size) && /^[0-9a-f]{64}$/.test(f.sha256);
};

/**
 * The bundle's manifest, read from the APK's assets: written by the same build step
 * that packs the files, so it can't disagree with them (a manifest compiled into the
 * JS could: expo run:android bundles the JS before Gradle remakes the assets).
 */
export async function loadManifest(native: { readAssetText(path: string): Promise<string> }): Promise<ManifestEntry[]> {
  const parsed: unknown = JSON.parse(await native.readAssetText('manifest.json'));
  if (!Array.isArray(parsed) || !parsed.every(isEntry)) throw new Error('the server bundle manifest in the APK is malformed');
  return parsed;
}

/** The app's own build (scripts/deploy-assets.mjs writes build.json): its commit, as `git describe`, and when (unix seconds). */
export type BuildInfo = { commit: string; builtAt: number };

/**
 * The build packed in the APK, for the server page: every build of a version has the same number, so
 * this is how the person tells the latest app is installed. Null when the APK has none or a malformed one.
 */
export async function loadBuildInfo(native: { readAssetText(path: string): Promise<string> }): Promise<BuildInfo | null> {
  try {
    const b = JSON.parse(await native.readAssetText('build.json')) as Partial<BuildInfo> | null;
    if (!b || typeof b.commit !== 'string' || !b.commit || !Number.isSafeInteger(b.builtAt) || b.builtAt! <= 0) return null;
    return { commit: b.commit, builtAt: b.builtAt! };
  } catch {
    return null;
  }
}

/** Settings' last line: the app's commit and build time, in the phone's time zone (minutes east of UTC). */
export const buildLabel = (b: BuildInfo | null, nowS = Date.now() / 1000, offsetMin = -new Date(nowS * 1000).getTimezoneOffset()) =>
  b ? `Karto Wallet ${b.commit}, built ${whenText(b.builtAt, nowS, offsetMin)}` : 'Karto Wallet build unknown';
