// Settings → Alerts in words: how alerts stand on this
// phone and its server, as one status line, the steps that put it right, and whether a test alert can be sent. Pure:
// alerts.tsx reads the phone and the server, and register.ts does the work.
import { CarddError, type PushState } from '../cardd/client';
import type { RowTone } from '../ui/look';

/** ntfy's package: the UnifiedPush distributor the Google-free builds are set up for. */
export const NTFY = 'io.heckel.ntfy';

export type AlertsStatus = 'off' | 'on-ntfy' | 'on-play' | 'needs-distributor' | 'needs-ntfy-server' | 'needs-permission' | 'late-battery' | 'failing';

/** One of ntfy's steps: its number and words, with ntfy's store links (1) or the server's ntfy address to copy (2). */
export type Step = { n: number; text: string; links?: { label: string; url: string }[]; address?: string };

/** How alerts reach this phone: a distributor such as ntfy (ntfy: it is ntfy), or the Play build's own FCM. */
export type AlertsRoute = { distributor: string; transport: 'unifiedpush' | 'fcm'; ntfy: boolean };

/**
 * server: GET /api/v1/push's answer, null until it comes. distributors: the UnifiedPush distributors installed other
 * than this app's own; distributor: the one chosen; play: the Play build with its embedded distributor answering (a
 * Play build without Play Services is Google-free); ntfyExempt: whether Doze leaves ntfy alone, null without ntfy;
 * endpointOrigin: the origin of the endpoint the distributor last gave, null for none.
 */
export type AlertsInput = {
  server: PushState | null;
  distributors: string[];
  distributor: string | null;
  allowed: boolean;
  ntfyExempt: boolean | null;
  play: boolean;
  endpointOrigin: string | null;
};

/** note: the Play build's one line about Google, on its own path. tone: the Settings row's colour. */
export type AlertsView = { status: AlertsStatus; line: string; tone: RowTone; steps: Step[]; canTest: boolean; note: string | null };

const INSTALL: Step = {
  n: 1, text: 'Install ntfy',
  links: [{ label: 'F-Droid', url: `https://f-droid.org/packages/${NTFY}/` }, { label: 'Play Store', url: `https://play.google.com/store/apps/details?id=${NTFY}` }],
};
const BATTERY: Step = { n: 3, text: "In ntfy's App info: App battery usage → Unrestricted" };
/** ntfy hands a new registration to its Default server, which only the person can set. */
const serverStep = (address: string): Step => ({ n: 2, text: 'In ntfy: Settings → General → Default server, paste this address', address });

/**
 * The steps shown before a registration through ntfy: its default server, then its battery setting, left out where
 * ntfy is already exempt (exempt: ntfyExempt; null, not known, keeps it).
 */
export const ntfySteps = (address: string, exempt: boolean | null): Step[] => (exempt === true ? [serverStep(address)] : [serverStep(address), BATTERY]);

const PLAY_NOTE = "Alerts come through Google's push, encrypted: Google can't read them.";

/**
 * Which way alerts go: an installed distributor wins, the one chosen before if it is still there, else
 * ntfy, else the first; with none, the Play build's own; with neither, none.
 */
export function pickRoute(o: { distributors: string[]; distributor: string | null; play: boolean; embedded: string | null }): AlertsRoute | null {
  const { distributors: d, distributor: saved } = o;
  if (d.length > 0) {
    const distributor = saved && d.includes(saved) ? saved : d.includes(NTFY) ? NTFY : d[0];
    return { distributor, transport: 'unifiedpush', ntfy: distributor === NTFY };
  }
  return o.play && o.embedded ? { distributor: o.embedded, transport: 'fcm', ntfy: false } : null;
}

/** A URL's scheme, host and port, as cardd gives an endpoint's; null for no URL. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether two URLs or origins are the same origin, each normalised as URL does (a default port dropped, the host
 * lower-cased): cardd gives an endpoint's origin as the endpoint has it (https://host:443), the phone's URL.origin
 * doesn't. False when either is no http(s) URL.
 */
export function sameOrigin(a: string | null, b: string | null): boolean {
  const x = a === null ? null : originOf(a);
  return x !== null && b !== null && x === originOf(b);
}

export function alertsView(s: AlertsInput): AlertsView {
  // Only the way matters here, not the embedded distributor's package.
  const route = pickRoute({ ...s, embedded: s.play ? 'embedded' : null });
  const note = route?.transport === 'fcm' ? PLAY_NOTE : null;
  const ntfy = s.server?.ntfy ?? '';
  const ep = s.server?.endpoint ?? null;
  const said = (status: AlertsStatus, line: string, tone: RowTone, o: { steps?: Step[]; canTest?: boolean } = {}): AlertsView =>
    ({ status, line, tone, steps: o.steps ?? [], canTest: o.canTest ?? false, note });

  // On: the server has an endpoint and the phone still has the registration it came from.
  if (ep && s.endpointOrigin !== null) {
    if (!s.allowed) return said('needs-permission', "Allow notifications in Android's settings", 'warn');
    if (ep.failures > 0) return said('failing', `Last alert didn't arrive: ${ep.failure}`, 'error', { canTest: true });
    if (ep.transport === 'fcm') return said('on-play', 'On', 'ok', { canTest: true });
    if (route?.ntfy && s.ntfyExempt === false) {
      return said('late-battery', "Alerts may be late: ntfy isn't exempt from battery saving", 'warn', { steps: [BATTERY], canTest: true });
    }
    const viaOwnNtfy = sameOrigin(ep.origin, ntfy);
    return said('on-ntfy', viaOwnNtfy ? "On: through your server's ntfy" : 'On', 'ok', { canTest: true });
  }
  if (!route) return said('needs-distributor', 'Needs the ntfy app', 'warn', { steps: ntfy ? [INSTALL, ...ntfySteps(ntfy, s.ntfyExempt)] : [INSTALL, BATTERY] });
  // ntfy handed back an endpoint off the server's own ntfy (its default server is another): the step again.
  if (route.ntfy && ntfy !== '' && s.endpointOrigin !== null && !sameOrigin(s.endpointOrigin, ntfy)) {
    return said('needs-ntfy-server', "Set ntfy's server first", 'warn', { steps: ntfySteps(ntfy, s.ntfyExempt) });
  }
  return said('off', 'Off', 'none');
}

/** register's result in words, where the status line doesn't already say it; null for none. route: ntfy's or Google's. */
export function registerError(r: { ok: true } | { ok: false; why: string; detail?: string }, route: 'ntfy' | 'fcm'): string | null {
  if (r.ok) return null;
  if (r.why === 'server') return `Couldn't turn on alerts: ${r.detail ?? 'your server refused'}`;
  if (r.why !== 'timeout') return null;
  const why = r.detail ? ` (${r.detail})` : '';
  return route === 'fcm' ? `Google's push didn't answer${why}. Try again.` : `ntfy didn't answer${why}. Open ntfy, then try again.`;
}

/** A cardd from before the push API: its router answers /api/v1/push with a plain-text 404. */
export const noPushApi = (e: unknown) => e instanceof CarddError && e.status === 404 && e.code === 'bad_response';

/**
 * The Settings row's line: the status's, once the server has answered. view: null where the phone has no alerts;
 * error: the server's read failed.
 */
export function alertsRow(view: AlertsView | null, server: PushState | null, error: unknown): { line: string; tone: RowTone } {
  if (error !== null && error !== undefined) return noPushApi(error) ? { line: 'Needs a server update', tone: 'warn' } : { line: "Couldn't check alerts", tone: 'none' };
  if (!view || !server) return { line: 'Checking…', tone: 'none' };
  return { line: view.line, tone: view.tone };
}
