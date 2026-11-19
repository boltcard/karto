// Every link from outside Karto PoS passes here before the router sees it (Expo Router's native intent; not a
// screen). Only the pairing link reaches a screen: pos/links.ts systemPath.
import { systemPath } from '../pos/links';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    return systemPath(path, initial);
  } catch {
    // A throw here would close the app: the start when the link starts it, else nothing.
    return initial ? '/' : null;
  }
}
