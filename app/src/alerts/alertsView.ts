// Settings → Alerts in words: how alerts stand on this
// phone and its server, as one status line, whether a test alert can be sent, and, while they are off on the way
// through ntfy, the checklist that turns them on: install ntfy, point it at the server, let it off battery saving,
// turn on. Pure: alerts.tsx reads the phone and the server, and register.ts does the work.
import { CarddError, type PushState } from '../cardd/client';
import type { NtfyPasted } from '../store/store';
import type { RowTone } from '../ui/look';

/** ntfy's package: the UnifiedPush distributor the Google-free builds are set up for. */
export const NTFY = 'io.heckel.ntfy';

export type AlertsStatus = 'off' | 'on-ntfy' | 'on-play' | 'needs-distributor' | 'needs-ntfy-server' | 'needs-permission' | 'late-battery' | 'failing';

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
export type AlertsView = { status: AlertsStatus; line: string; tone: RowTone; canTest: boolean; note: string | null };

/** The statuses alerts are on in: the server has the phone's endpoint, whatever is wrong with it. */
export const isOn = (s: AlertsStatus) => s === 'on-ntfy' || s === 'on-play' || s === 'late-battery' || s === 'failing' || s === 'needs-permission';

/** The question at the end of set-up, asked once: then only Settings → Alerts. */
export const ASK = {
  title: 'Get alerts on this phone?',
  what: 'A notification when money arrives on your server, or when one of your cards is used.',
  ntfy: 'This copy of Karto Wallet is Google-free, so alerts come through ntfy, a free app that gets them straight from your own server. Setting it up takes about 2 minutes.',
  yes: 'Turn on alerts',
  later: 'Later',
  where: 'You can turn them on any time in Settings → Alerts.',
} as const;

/** Android's question, said before it comes. */
export const PERMISSION_AHEAD = 'Android will ask whether Karto Wallet may send notifications: choose Allow.';

export const ON_WORDS = { title: 'Alerts are on', text: "You'll get a notification when money arrives or a card is used, even with the app closed." } as const;

/** Set-up's Finish later: how far the person got, and where to carry on. */
export const notYet = (done: number, of: number) => ({
  title: "Alerts aren't on yet",
  text: `You've done ${done} of the ${of} steps. Pick up where you left off any time in Settings → Alerts.`,
});

/** The host (and port, other than the default) of an origin, or "another server" where it isn't a URL. */
const hostOf = (origin: string | null) => {
  const o = origin === null ? null : originOf(origin);
  return o ? new URL(o).host : 'another server';
};

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
  const said = (status: AlertsStatus, line: string, tone: RowTone, canTest = false): AlertsView => ({ status, line, tone, canTest, note });
  const otherServer = () => said('needs-ntfy-server', 'ntfy is set to another server', 'warn');

  // On: the server has an endpoint and the phone still has the registration it came from.
  if (ep && s.endpointOrigin !== null) {
    // The phone's registration went to another ntfy server (its default set back, say): alerts to the older one the
    // server has would stop when it next re-registers, so it isn't On.
    // Only an ntfy endpoint: Google's push in use stays On whatever is installed later.
    if (route?.ntfy && ep.transport !== 'fcm' && ntfy !== '' && !sameOrigin(s.endpointOrigin, ntfy)) return otherServer();
    if (!s.allowed) return said('needs-permission', "Allow notifications in Android's settings", 'warn');
    if (ep.failures > 0) return said('failing', `Last alert didn't arrive: ${ep.failure}`, 'error', true);
    if (ep.transport === 'fcm') return said('on-play', 'On', 'ok', true);
    if (route?.ntfy && s.ntfyExempt === false) return said('late-battery', "Alerts may be late: ntfy isn't exempt from battery saving", 'warn', true);
    const viaOwnNtfy = sameOrigin(ep.origin, ntfy);
    return said('on-ntfy', viaOwnNtfy ? "On: through your server's ntfy" : 'On', 'ok', true);
  }
  // Nothing has gone wrong before ntfy is installed: the checklist's first step says what to do.
  if (!route) return said('needs-distributor', 'Off', 'none');
  // ntfy handed back an endpoint off the server's own ntfy (its default server is another): the step again.
  if (route.ntfy && ntfy !== '' && s.endpointOrigin !== null && !sameOrigin(s.endpointOrigin, ntfy)) return otherServer();
  return said('off', 'Off', 'none');
}

/**
 * Whether alerts are turned on through the checklist: on the way through ntfy, or with no way yet on a Google-free
 * phone (ntfy is what it needs). The Play build with Google's push, and another distributor, turn on with one press.
 */
export function onChecklistPath(s: Pick<AlertsInput, 'distributors' | 'distributor' | 'play'>): boolean {
  const route = pickRoute({ ...s, embedded: s.play ? 'embedded' : null });
  return route ? route.ntfy : !s.play;
}

export type ChecklistKey = 'install' | 'server' | 'battery' | 'on';
/** done: ticked, with doneLine beside it. warn: why a step done before is to do again (ntfy on another server). */
export type ChecklistItem = { key: ChecklistKey; title: string; done: boolean; doneLine: string; warn: { title: string; text: string } | null };
/** current: the one step open, the first not done. done: how many are, of items.length. */
export type Checklist = { items: ChecklistItem[]; current: ChecklistKey; done: number };

export const CHECKLIST = {
  title: 'Set up alerts',
  intro: (of: number) => `${of} steps · about 2 minutes`,
  stepOf: (n: number, of: number) => `Step ${n} of ${of}`,
  install: {
    title: 'Install ntfy',
    text: "Free, from your app store. Come back here once it's installed: this step ticks itself.",
    button: 'Install ntfy',
    doneLine: 'Installed',
  },
  server: {
    title: 'Point ntfy at your server',
    text: "In ntfy, open Settings, then General, then Default server, and paste your server's address:",
    button: 'Copy address and open ntfy',
    pasted: "I've pasted it",
    doneLine: 'Pasted · checked when you turn on',
  },
  battery: {
    title: 'Let ntfy run in the background',
    why: "So Android doesn't hold alerts back to save battery.",
    button: "Open ntfy's battery setting",
    doneLine: 'Unrestricted',
    passed: "My phone doesn't have this setting",
    passedLine: 'Not set: alerts may come late',
  },
  on: { title: 'Turn on alerts', button: 'Turn on alerts' },
  later: 'Finish later',
  back: 'Back to the steps',
} as const;

/** Where ntfy's battery setting is, by Android's API level: what openBatterySettings opens on it. */
export const batteryHow = (api: number) =>
  api >= 31
    ? // Android 15 puts the choice behind the words of its Allow background usage switch (seen on the emulator).
      'On the page that opens, choose App battery usage, then Unrestricted. If you see Allow background usage, tap its words to find Unrestricted.'
    : // Where a phone lacks the list, ntfy's App info opens instead.
      "In the list that opens, choose All apps, then ntfy, then Don't optimise. If ntfy's App info opens instead, choose Battery.";

/** ntfy put the registration on another server: step 2 again. */
const otherServerWarn = (host: string) => ({
  title: `ntfy is still using ${host}`,
  text: "Its Default server isn't your server's address yet, so alerts would go the wrong way. Paste the address, then turn on again.",
});

/**
 * The checklist, from how alerts stand. endpoint: the phone's endpoint URL now (a secret: never logged), null for
 * none. pasted: the person's "I've pasted it", kept. batteryPassed: "My phone doesn't have this setting" pressed on
 * this page. Without the server's ntfy address there is no server step: three steps.
 *
 * ntfy's Default server can't be read, so step 2 is done when the phone's endpoint is on the server's ntfy, or the
 * person said so for this address while the phone still has the endpoint it had then: a registration since (every
 * one is fresh) put it wherever ntfy's default now is, and that endpoint says where.
 */
export function alertsChecklist(s: AlertsInput, o: { endpoint: string | null; pasted: NtfyPasted | null; batteryPassed: boolean }): Checklist {
  const ntfy = s.server?.ntfy ?? '';
  const W = CHECKLIST;
  const items: ChecklistItem[] = [{ key: 'install', title: W.install.title, done: s.distributors.includes(NTFY), doneLine: W.install.doneLine, warn: null }];
  if (ntfy !== '') {
    const onOwn = sameOrigin(o.endpoint, ntfy);
    const done = onOwn || (o.pasted !== null && o.pasted.address === ntfy && o.pasted.endpoint === o.endpoint);
    // Not done with an endpoint off the server's ntfy: ntfy put the last registration on its default, another server.
    const elsewhere = !onOwn && o.endpoint !== null;
    items.push({ key: 'server', title: W.server.title, done, doneLine: W.server.doneLine, warn: !done && elsewhere ? otherServerWarn(hostOf(o.endpoint)) : null });
  }
  const exempt = s.ntfyExempt === true;
  items.push({ key: 'battery', title: W.battery.title, done: exempt || o.batteryPassed, doneLine: exempt ? W.battery.doneLine : W.battery.passedLine, warn: null });
  items.push({ key: 'on', title: W.on.title, done: false, doneLine: '', warn: null });
  const current = items.find((i) => !i.done)!.key;
  return { items, current, done: items.filter((i) => i.done).length };
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
