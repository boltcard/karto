// Karto PoS's build label: the app's commit and when it was built, which the build puts into the
// bundle (deploy/test/release-apk.sh: EXPO_PUBLIC_BUILD_COMMIT and EXPO_PUBLIC_BUILD_TIME). It carries no server
// files, so it has none of Karto Wallet's build.json.
import { whenText } from '../money/words';

/**
 * "Karto PoS 1.0.2 (8571926), built today at 10:11". commit and builtAt (unix seconds, as text) are the build's own;
 * version is app.json's (left out when the config has none).
 */
export function posBuildLabel(
  commit: string | undefined,
  builtAt: string | undefined,
  version: string | null | undefined,
  nowS = Date.now() / 1000,
  offsetMin = -new Date(nowS * 1000).getTimezoneOffset(),
): string {
  if (!commit) return version ? `Karto PoS ${version}, build unknown` : 'Karto PoS build unknown';
  const name = `Karto PoS ${version ? `${version} (${commit})` : commit}`;
  const at = Number(builtAt);
  return builtAt && Number.isFinite(at) && at > 0 ? `${name}, built ${whenText(at, nowS, offsetMin)}` : name;
}

/** This build's label, with this app's version. */
export const BUILD_LABEL = (version: string | null | undefined) => posBuildLabel(process.env.EXPO_PUBLIC_BUILD_COMMIT, process.env.EXPO_PUBLIC_BUILD_TIME, version);
