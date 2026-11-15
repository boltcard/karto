// Turning alerts on: the permission, the distributor
// (an installed one such as ntfy first, else the Play build's own), for ntfy the server step, a fresh registration,
// the endpoint it gives (never one off the server's own ntfy), then cardd. And on each open, the check that the
// server still has the endpoint the phone has. The words are alertsView.ts's; the page is app/alerts.tsx.
import { CarddError, type CarddClient, type PushState } from '../cardd/client';
import type { AlertsNativeApi, PushEndpoint } from '../native/api';
import type { AppStore } from '../store/store';
import { NTFY, originOf, pickRoute, sameOrigin, type AlertsInput, type AlertsRoute } from './alertsView';

export type AlertsNative = Pick<
  AlertsNativeApi,
  'pushDistributors' | 'pushDistributor' | 'pushEmbeddedDistributor' | 'pushRegister' | 'pushUnregister' | 'pushEndpoint' | 'notificationsAllowed' | 'requestNotifications' | 'addListener'
>;

/** Android's module has the alerts' calls; an iPhone's doesn't yet. */
export const alertsSupported = <T extends Partial<AlertsNativeApi>>(native: T): native is T & AlertsNativeApi =>
  typeof native.pushDistributors === 'function' && typeof native.pushRegister === 'function';

/** The phone's side of how alerts stand, as alertsView takes it. play: the Play build (alerts/store.ts). */
export function readPhone(native: Omit<AlertsNativeApi, 'addListener'>, play: boolean): Omit<AlertsInput, 'server'> {
  const embedded = play ? native.pushEmbeddedDistributor() : null;
  const distributors = native.pushDistributors().filter((d) => d !== embedded);
  const ep = native.pushEndpoint();
  return {
    distributors,
    distributor: native.pushDistributor(),
    allowed: native.notificationsAllowed(),
    ntfyExempt: distributors.includes(NTFY) ? native.ignoringBatteryOptimizations(NTFY) : null,
    play: embedded !== null,
    endpointOrigin: ep ? originOf(ep.endpoint) : null,
  };
}

/** play: the Play build (alerts/store.ts). waitMs: how long a registration may take to give its endpoint (20 s). */
export type RegisterDeps = {
  native: AlertsNative;
  cardd: Pick<CarddClient, 'push' | 'setPush' | 'dropPush'>;
  store: Pick<AppStore, 'alertsSent' | 'saveAlertsSent'>;
  play: boolean;
  waitMs?: number;
};

/**
 * Why alerts didn't turn on: the permission refused; no distributor; an endpoint off the server's own ntfy (or
 * cardd's ntfy_sh); the server didn't take it (detail: what it said); or no endpoint came (timeout; detail: the
 * connector's reason when it gave one).
 */
export type RegisterResult = { ok: true } | { ok: false; why: 'permission' | 'no-distributor' | 'ntfy-sh' | 'server' | 'timeout'; detail?: string };

type Failed = Extract<RegisterResult, { ok: false }>;
const fail = (why: Failed['why'], detail?: string): Failed => ({ ok: false, why, ...(detail ? { detail } : {}) });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One piece of alerts' work at a time (running). Turn on and Turn off cancel a check in flight first, and wait for
 * it to end: its wait for an endpoint ends at once, and once cancelled it registers nothing and hands cardd nothing,
 * so a late check never turns alerts back on after Turn off. The check on open stays out of any work under way.
 */
let generation = 0;
let running: Promise<unknown> | null = null;
/** The waits for an endpoint under way: each ends at a cancel. */
const wakers = new Set<() => void>();
/** A piece of work that saw it was cancelled, and stopped. */
type Cancelled = 'cancelled';
/** Whether the work that was given it is still the current one. */
type Live = () => boolean;

/** Cancels the work in flight, and waits for it to end. */
async function cancel(): Promise<void> {
  generation++;
  for (const wake of [...wakers]) wake();
  await running?.catch(() => {});
}

function track<T>(work: (live: Live) => Promise<T>): Promise<T> {
  const gen = generation;
  const p = work(() => gen === generation);
  running = p;
  p.then(
    () => void (running === p && (running = null)),
    () => void (running === p && (running = null)),
  );
  return p;
}

/** Which way alerts go on this phone now. */
export function routeOf(native: Pick<AlertsNative, 'pushDistributors' | 'pushDistributor' | 'pushEmbeddedDistributor'>, play: boolean): AlertsRoute | null {
  const embedded = play ? native.pushEmbeddedDistributor() : null;
  return pickRoute({ distributors: native.pushDistributors().filter((d) => d !== embedded), distributor: native.pushDistributor(), play, embedded });
}

/**
 * Turns alerts on. ntfyStep: on the ntfy path, shows the server step with the server's ntfy address and resolves
 * once the person has done it (Done, turn on); without it no step is shown. ask: false asks no permission (the check
 * on open, which shows nothing).
 */
export async function register(deps: RegisterDeps, o: { ntfyStep?: (address: string) => Promise<void>; ask?: boolean } = {}): Promise<RegisterResult> {
  await cancel();
  // Cancelled only by Turn off (or another Turn on) while it runs: it then says it got no endpoint.
  const r = await track((live) => registerNow(deps, o, live));
  return r === 'cancelled' ? fail('timeout', 'cancelled') : r;
}

async function registerNow(deps: RegisterDeps, o: { ntfyStep?: (address: string) => Promise<void>; ask?: boolean }, live: Live): Promise<RegisterResult | Cancelled> {
  const { native } = deps;
  if (o.ask !== false && !native.notificationsAllowed() && !(await native.requestNotifications())) return fail('permission');
  const route = routeOf(native, deps.play);
  if (!route) return fail('no-distributor');
  let state: PushState;
  try {
    state = await deps.cardd.push();
  } catch (e) {
    return fail('server', message(e));
  }
  if (route.ntfy && state.ntfy && o.ntfyStep) await o.ntfyStep(state.ntfy);
  if (!live()) return 'cancelled';
  // Always a fresh registration: a new token and keys, so ntfy hands it to the default server it has now.
  const got = await endpointFrom(native, () => native.pushRegister(state.vapidPublicKey, route.distributor, true), deps.waitMs ?? 20_000);
  if (!live()) return 'cancelled';
  if ('why' in got) return got;
  return hand(deps, route, state, got, live);
}

/**
 * What a fresh registration waits past: a fallback distributor's temporary endpoint, and the "unregistered" its own
 * unregister of the old registration may bring (the module swallows that one too, CardNativeModule.kt).
 */
const NOT_THE_ANSWER = ['temporary', 'unregistered'];

/** The endpoint a fresh registration gives: from onPushEndpoint, within waitMs, past what isn't its answer. */
async function endpointFrom(native: AlertsNative, start: () => Promise<void>, waitMs: number): Promise<PushEndpoint | Failed> {
  const subs: { remove(): void }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake = () => {};
  try {
    const answer = new Promise<PushEndpoint | { failed: string } | null>((resolve) => {
      subs.push(native.addListener('onPushEndpoint', resolve));
      subs.push(native.addListener('onPushFailed', (e) => !NOT_THE_ANSWER.includes(e.reason) && resolve({ failed: e.reason })));
      timer = setTimeout(() => resolve(null), waitMs);
      wake = () => resolve(null);
      wakers.add(wake);
    });
    try {
      await start();
    } catch (e) {
      return (e as { code?: string }).code === 'ERR_NO_DISTRIBUTOR' ? fail('no-distributor') : fail('server', message(e));
    }
    const a = await answer;
    if (a && 'failed' in a) return fail('timeout', a.failed);
    // An event missed is still kept by the module: the registration was fresh, so whatever it has is the new one.
    return a ?? native.pushEndpoint() ?? fail('timeout');
  } finally {
    clearTimeout(timer);
    wakers.delete(wake);
    for (const s of subs) s.remove();
  }
}

/** On the ntfy path, an endpoint is the server's own ntfy's; with no ntfy known, at least not ntfy.sh's. */
function onOwnNtfy(endpoint: string, ntfy: string): boolean {
  const origin = originOf(endpoint);
  if (!origin) return false;
  return ntfy ? origin === originOf(ntfy) : new URL(origin).hostname !== 'ntfy.sh';
}

/** Hands cardd the endpoint, and keeps what was handed. */
async function hand(deps: RegisterDeps, route: AlertsRoute, state: PushState, ep: PushEndpoint, live: Live): Promise<RegisterResult | Cancelled> {
  // An endpoint ntfy put on another server (ntfy.sh, its default) is never handed to cardd.
  if (route.ntfy && !onOwnNtfy(ep.endpoint, state.ntfy)) return fail('ntfy-sh');
  if (!live()) return 'cancelled';
  let answer: PushState;
  try {
    answer = await deps.cardd.setPush({ endpoint: ep.endpoint, p256dh: ep.p256dh, auth: ep.auth, transport: route.transport });
  } catch (e) {
    return e instanceof CarddError && e.code === 'ntfy_sh' ? fail('ntfy-sh') : fail('server', message(e));
  }
  await deps.store.saveAlertsSent({ endpoint: ep.endpoint, createdAt: answer.endpoint?.createdAt ?? 0, vapid: state.vapidPublicKey });
  return { ok: true };
}

/**
 * Alerts off, once a check in flight has been cancelled and has ended: the server first (it sends nothing more),
 * then the phone's registration, then what was kept.
 */
export async function turnOff(deps: Pick<RegisterDeps, 'native' | 'cardd' | 'store'>): Promise<void> {
  await cancel();
  await track(async () => {
    await deps.cardd.dropPush();
    await deps.native.pushUnregister();
    await deps.store.saveAlertsSent(null);
  });
}

/**
 * On each open, where alerts were turned on: a new registration with no endpoint on the phone (the distributor
 * dropped it) or a server with a new VAPID key; the phone's endpoint handed again when it isn't the one sent, or the
 * server has none, another origin or another created time (a restore). Asks and shows nothing; never throws. off:
 * alerts were never turned on here; unchanged: the server has what the phone has; busy: other work on alerts is
 * under way; cancelled: Turn on or Turn off came while it ran.
 */
export function checkOnOpen(deps: RegisterDeps): Promise<'off' | 'unchanged' | 'busy' | Cancelled | RegisterResult> {
  if (running) return Promise.resolve('busy');
  return track((live) => checkNow(deps, live));
}

async function checkNow(deps: RegisterDeps, live: Live): Promise<'off' | 'unchanged' | Cancelled | RegisterResult> {
  try {
    const sent = await deps.store.alertsSent();
    if (!sent) return 'off';
    const route = routeOf(deps.native, deps.play);
    if (!route) return fail('no-distributor');
    const state = await deps.cardd.push();
    const local = deps.native.pushEndpoint();
    if (!local || state.vapidPublicKey !== sent.vapid) return await registerNow(deps, { ask: false }, live);
    const e = state.endpoint;
    if (!e || local.endpoint !== sent.endpoint || !sameOrigin(e.origin, local.endpoint) || e.createdAt !== sent.createdAt) return await hand(deps, route, state, local, live);
    return 'unchanged';
  } catch (e) {
    return fail('server', message(e));
  }
}
