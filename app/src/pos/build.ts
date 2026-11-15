// Karto PoS's build label: the app's commit and when it was built, which the build puts into the
// bundle (deploy/test/release-apk.sh: EXPO_PUBLIC_BUILD_COMMIT and EXPO_PUBLIC_BUILD_TIME). It carries no server
// files, so it has none of Karto Wallet's build.json.
import { whenText } from '../money/words';

/** "Karto PoS 8571926, built today at 10:11". commit and builtAt (unix seconds, as text) are the build's own. */
export function posBuildLabel(commit: string | undefined, builtAt: string | undefined, nowS = Date.now() / 1000, offsetMin = -new Date(nowS * 1000).getTimezoneOffset()): string {
  if (!commit) return 'Karto PoS build unknown';
  const at = Number(builtAt);
  return builtAt && Number.isFinite(at) && at > 0 ? `Karto PoS ${commit}, built ${whenText(at, nowS, offsetMin)}` : `Karto PoS ${commit}`;
}

/** This build's label. */
export const BUILD_LABEL = () => posBuildLabel(process.env.EXPO_PUBLIC_BUILD_COMMIT, process.env.EXPO_PUBLIC_BUILD_TIME);
