// The two links Karto PoS takes, from a scan or from Karto Wallet on the same phone:
// kartopos://pair?host=<host>&code=<code> pairs the phone, kartopos://server?host=<host> tells a paired phone its
// server's new address. Both come from outside the app, so each part is checked here and nothing else is let in.

/** A link, read and checked. host is only ever used as https://<host>. */
export type PosLink = { kind: 'pair'; host: string; code: string } | { kind: 'server'; host: string };

/** What the scanner says of anything that isn't one of the two links. */
export const NOT_A_CODE = "That isn't a Karto PoS code.";

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

/**
 * A server's name: lowercase letters, digits, dots and hyphens, with at least one dot, in labels as DNS has them.
 * Nothing that could change where https://<host> goes: no port, path, user, space or upper case.
 */
export const validHost = (host: string): boolean => host.length <= 253 && HOST.test(host);

/** A pairing code as cardd makes one: 32 hex characters. */
export const validCode = (code: string): boolean => /^[0-9a-f]{32}$/.test(code);

/** A route's parameter as the router gives it: one value, more than one, or none. */
type Param = string | string[] | undefined;
const one = (p: Param): string | null => (typeof p === 'string' ? p : null);

/**
 * The link of a route's parameters (the router opens kartopos://pair?… as /pair with the link's parts), checked
 * as a scanned one is; null for one whose parts are missing, wrong, or given more than once: it is dropped.
 */
export function linkOf(kind: PosLink['kind'], params: { host?: Param; code?: Param }): PosLink | null {
  const host = one(params.host);
  if (host === null || !validHost(host)) return null;
  if (kind === 'server') return { kind, host };
  const code = one(params.code);
  return code !== null && validCode(code) ? { kind, host, code } : null;
}

/** A scanned code's text as a link, or null when it isn't one: only the two forms, each part once and nothing more. */
export function readLink(text: string): PosLink | null {
  const m = /^kartopos:\/\/(pair|server)\?([^#]*)$/.exec(text.trim());
  if (!m) return null;
  const kind = m[1] as PosLink['kind'];
  const parts: Record<string, string> = {};
  for (const pair of m[2].split('&')) {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (key in parts) return null;
    try {
      parts[key] = decodeURIComponent(eq < 0 ? '' : pair.slice(eq + 1));
    } catch {
      return null;
    }
  }
  const wanted = kind === 'pair' ? ['host', 'code'] : ['host'];
  if (Object.keys(parts).length !== wanted.length || !wanted.every((k) => k in parts)) return null;
  return linkOf(kind, parts);
}

/**
 * Where a link from outside the app takes it (the router's redirectSystemPath, pos-app/+native-intent.tsx). Any app
 * or web page can open a kartopos:// link, and the router would open whichever screen it names: This PoS, whose
 * Unpair acts, the till, the scanner. Only the pairing link is let through, as it came (the Pair screen checks its
 * parts). Any other opens the app at its start when it starts the app, as its icon does, and while the app is open
 * changes nothing: null leaves it where it is (a sale stays in front). path: the link as the system gave it, a
 * whole URL (kartopos://pair?…), or a path.
 */
export function systemPath(path: string, initial: boolean): string | null {
  const rest = path.replace(/^[a-z][a-z0-9+.-]*:/, '').replace(/^\/+/, '');
  const screen = /^[^?#]*/.exec(rest)?.[0];
  if (screen === 'pair') return path;
  return initial ? '/' : null;
}
