import { afterEach, describe, expect, it, vi } from 'vitest';
import { CarddClient } from '../cardd/client';
import type { PushEndpoint, PushFailedEvent } from '../native/api';
import { AppStore } from '../store/store';
import { FakeCardd, vectorDeviceKey } from '../testing/fakeCardd';
import { nodeSqlite } from '../testing/nodeSqlite';
import { vectors } from '../testing/vectors';
import { NTFY } from './alertsView';
import { alertsSupported, checkOnOpen, readPhone, register, turnOff, type AlertsNative } from './register';

const NTFY_URL = 'https://vm-1.lnvps.cloud:8443';
const OWN = 'tech.whitewolf.karto.dev';
const KEYS = { p256dh: 'BPk', auth: 'aGk' };
const ntfyEndpoint = (topic = 'upAbC123', origin = NTFY_URL): PushEndpoint => ({ endpoint: `${origin}/${topic}?up=1`, ...KEYS });
const FCM: PushEndpoint = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def', ...KEYS };

/**
 * UnifiedPush's connector as CardNativeModule.kt shows it: the distributors installed, the one saved, the endpoint
 * kept; a registration answered by `answer` (an endpoint, a failure, or nothing) as the module's events.
 */
function fakeNative(o: { distributors?: string[]; embedded?: string | null; allowed?: boolean; grant?: boolean; answer?: (distributor: string) => PushEndpoint | PushFailedEvent | null } = {}) {
  const listeners = { onPushEndpoint: new Set<(e: PushEndpoint) => void>(), onPushFailed: new Set<(e: PushFailedEvent) => void>() };
  const n = {
    distributors: o.distributors ?? [NTFY],
    saved: null as string | null,
    kept: null as PushEndpoint | null,
    allowed: o.allowed ?? true,
    registered: [] as { vapid: string; distributor: string | null; fresh: boolean }[],
    asked: 0,
    unregistered: 0,
    emit(e: PushEndpoint | PushFailedEvent) {
      if ('endpoint' in e) {
        n.kept = e;
        for (const l of listeners.onPushEndpoint) l(e);
      } else for (const l of listeners.onPushFailed) l(e);
    },
  };
  const api: AlertsNative = {
    pushDistributors: () => n.distributors,
    pushDistributor: () => n.saved,
    pushEmbeddedDistributor: () => (o.embedded && n.distributors.includes(o.embedded) ? o.embedded : null),
    pushRegister: async (vapid, distributor, fresh) => {
      n.registered.push({ vapid, distributor, fresh });
      if (fresh) n.kept = null;
      n.saved = distributor ?? n.saved;
      const a = o.answer ? o.answer(n.saved!) : n.saved === o.embedded ? FCM : ntfyEndpoint(`up${n.registered.length}`);
      if (a) queueMicrotask(() => n.emit(a));
    },
    pushUnregister: async () => {
      n.unregistered++;
      n.kept = null;
    },
    pushEndpoint: () => n.kept,
    notificationsAllowed: () => n.allowed,
    requestNotifications: async () => {
      n.asked++;
      n.allowed = o.grant ?? true;
      return n.allowed;
    },
    addListener: ((event: 'onPushEndpoint' | 'onPushFailed', l: never) => {
      listeners[event].add(l);
      return { remove: () => listeners[event].delete(l) };
    }) as AlertsNative['addListener'],
  };
  return { n, api };
}

async function setup(native = fakeNative(), play = false) {
  const cardd = new FakeCardd(() => 1_790_000_000_000);
  cardd.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey);
  const client = new CarddClient({ fetch: cardd.http.fetch, host: 'vm-1.lnvps.cloud', key: vectorDeviceKey(), now: () => 1_790_000_000_000 });
  const store = await AppStore.open(nodeSqlite());
  const deps = { native: native.api, cardd: client, store, play, waitMs: 50 };
  const sent = () => cardd.pushEndpoints.get(vectors.deviceAuth.keyId) ?? null;
  return { cardd, client, store, deps, sent, n: native.n };
}

afterEach(() => vi.useRealTimers());

// Permission, the distributor, a fresh registration, the origin check, then cardd.
describe('register', () => {
  it("turns alerts on through the server's ntfy on a Google-free phone, with a fresh registration", async () => {
    const { deps, sent, n, store, cardd } = await setup();
    expect(await register(deps)).toEqual({ ok: true });
    expect(n.registered).toEqual([{ vapid: cardd.pushVapid, distributor: NTFY, fresh: true }]);
    expect(sent()).toMatchObject({ endpoint: `${NTFY_URL}/up1?up=1`, transport: 'unifiedpush', ...KEYS });
    expect(await store.alertsSent()).toEqual({ endpoint: `${NTFY_URL}/up1?up=1`, createdAt: 1_790_000_000, vapid: cardd.pushVapid });
  });

  it('says there is no distributor on a Google-free phone without ntfy, asking nothing of cardd', async () => {
    const { deps, cardd, n } = await setup(fakeNative({ distributors: [] }));
    expect(await register(deps)).toEqual({ ok: false, why: 'no-distributor' });
    expect(cardd.http.requests).toEqual([]);
    expect(n.registered).toEqual([]);
  });

  // ntfy handed back an endpoint on ntfy.sh (its default server is not the person's): never sent to cardd.
  it('refuses an endpoint off the server\'s ntfy, and sends cardd nothing', async () => {
    const { deps, sent, store, cardd } = await setup(fakeNative({ answer: () => ntfyEndpoint('upZz', 'https://ntfy.sh') }));
    expect(await register(deps)).toEqual({ ok: false, why: 'ntfy-sh' });
    expect(cardd.http.requests.map((r) => r.method)).toEqual(['GET']);
    expect(sent()).toBeNull();
    expect(await store.alertsSent()).toBeNull();
  });

  it("takes cardd's own ntfy_sh refusal as the same, on a path the phone doesn't check", async () => {
    // Another distributor that hands out ntfy.sh endpoints: no origin check on the phone, but cardd's.
    const other = 'org.example.distributor';
    const { deps, sent } = await setup(fakeNative({ distributors: [other], answer: () => ntfyEndpoint('upZz', 'https://ntfy.sh') }));
    expect(await register(deps)).toEqual({ ok: false, why: 'ntfy-sh' });
    expect(sent()).toBeNull();
  });

  it('gives up after its wait when no endpoint comes, and on a failure the connector reports', async () => {
    const { deps } = await setup(fakeNative({ answer: () => null }));
    expect(await register(deps)).toEqual({ ok: false, why: 'timeout' });
    const failed = await setup(fakeNative({ answer: () => ({ reason: 'network' }) }));
    expect(await register({ ...failed.deps, waitMs: 20_000 })).toEqual({ ok: false, why: 'timeout', detail: 'network' });
  });

  it("waits on past a fallback distributor's temporary endpoint for the real one", async () => {
    const native = fakeNative({ answer: () => ({ reason: 'temporary' }) });
    const { deps, sent } = await setup(native);
    const done = register({ ...deps, waitMs: 20_000 });
    await new Promise((r) => setTimeout(r, 5));
    native.n.emit(ntfyEndpoint('upLate'));
    expect(await done).toEqual({ ok: true });
    expect(sent()?.endpoint).toBe(`${NTFY_URL}/upLate?up=1`);
  });

  // A fresh registration unregisters the old one first, and the "unregistered" that may
  // bring is not this registration's answer.
  it("waits on past the old registration's unregistered for the new endpoint", async () => {
    const native = fakeNative({ answer: () => ({ reason: 'unregistered' }) });
    const { deps, sent } = await setup(native);
    const done = register({ ...deps, waitMs: 20_000 });
    await new Promise((r) => setTimeout(r, 5));
    native.n.emit(ntfyEndpoint('upNew'));
    expect(await done).toEqual({ ok: true });
    expect(sent()?.endpoint).toBe(`${NTFY_URL}/upNew?up=1`);
  });

  it('stops at a refused permission, before any distributor or server is asked', async () => {
    const { deps, n, cardd } = await setup(fakeNative({ allowed: false, grant: false }));
    expect(await register(deps)).toEqual({ ok: false, why: 'permission' });
    expect(n.asked).toBe(1);
    expect(n.registered).toEqual([]);
    expect(cardd.http.requests).toEqual([]);
  });

  it('asks the permission only when it is not given', async () => {
    const { deps, n } = await setup();
    await register(deps);
    expect(n.asked).toBe(0);
    const asked = await setup(fakeNative({ allowed: false }));
    expect(await register(asked.deps)).toEqual({ ok: true });
    expect(asked.n.asked).toBe(1);
  });

  it("uses the Play build's embedded distributor when no other is installed", async () => {
    const native = fakeNative({ distributors: [OWN], embedded: OWN });
    const { deps, sent, n } = await setup(native, true);
    expect(await register(deps)).toEqual({ ok: true });
    expect(n.registered[0]).toMatchObject({ distributor: OWN });
    expect(sent()).toMatchObject({ endpoint: FCM.endpoint, transport: 'fcm' });
  });

  it('uses ntfy on a Play build that has it installed (the user\'s distributor first)', async () => {
    const native = fakeNative({ distributors: [OWN, NTFY], embedded: OWN });
    const { deps, sent, n } = await setup(native, true);
    expect(await register(deps)).toEqual({ ok: true });
    expect(n.registered[0]).toMatchObject({ distributor: NTFY });
    expect(sent()).toMatchObject({ transport: 'unifiedpush' });
  });

  it('turns alerts off on the server and the phone, and forgets what was sent', async () => {
    const { deps, sent, n, store } = await setup();
    await register(deps);
    await turnOff(deps);
    expect(sent()).toBeNull();
    expect(n.unregistered).toBe(1);
    expect(n.kept).toBeNull();
    expect(await store.alertsSent()).toBeNull();
  });
});

// On each open the wallet checks that its endpoint is still the one the server has.
describe('checkOnOpen', () => {
  it('does nothing where alerts were never turned on', async () => {
    const { deps, cardd } = await setup();
    expect(await checkOnOpen(deps)).toBe('off');
    expect(cardd.http.requests).toEqual([]);
  });

  it('leaves alone an endpoint the server has as it was sent', async () => {
    const { deps, cardd } = await setup();
    await register(deps);
    const before = cardd.http.requests.length;
    expect(await checkOnOpen(deps)).toBe('unchanged');
    expect(cardd.http.requests.slice(before).map((r) => r.method)).toEqual(['GET']);
  });

  // cardd gives the origin as the endpoint has it, a default port and all.
  it('leaves alone an endpoint whose URL names its default port', async () => {
    const { deps, cardd } = await setup(fakeNative({ answer: () => ntfyEndpoint('up443', 'https://vm-1.lnvps.cloud:443') }));
    cardd.pushNtfy = 'https://vm-1.lnvps.cloud'; // the server's ntfy on 443
    expect(await register(deps)).toEqual({ ok: true });
    expect(cardd.pushEndpoints.get(vectors.deviceAuth.keyId)?.endpoint).toBe('https://vm-1.lnvps.cloud:443/up443?up=1');
    const before = cardd.http.requests.length;
    expect(await checkOnOpen(deps)).toBe('unchanged');
    expect(cardd.http.requests.slice(before).map((r) => r.method)).toEqual(['GET']);
  });

  it('sends the server a new endpoint the distributor gave while the app was closed', async () => {
    const { deps, sent, n, store } = await setup();
    await register(deps);
    n.kept = ntfyEndpoint('upNew');
    expect(await checkOnOpen(deps)).toEqual({ ok: true });
    expect(sent()?.endpoint).toBe(`${NTFY_URL}/upNew?up=1`);
    expect((await store.alertsSent())?.endpoint).toBe(`${NTFY_URL}/upNew?up=1`);
  });

  it('sends the endpoint again when the server has lost it (a restore deletes endpoints)', async () => {
    const { deps, sent, cardd, n } = await setup();
    await register(deps);
    cardd.pushEndpoints.clear();
    expect(await checkOnOpen(deps)).toEqual({ ok: true });
    expect(sent()?.endpoint).toBe(`${NTFY_URL}/up1?up=1`);
    // The endpoint the phone had was still good: no new registration.
    expect(n.registered).toHaveLength(1);
  });

  it("registers again, without asking anything, when the distributor dropped the phone's registration", async () => {
    const { deps, sent, n } = await setup();
    await register(deps);
    n.kept = null;
    n.allowed = false;
    expect(await checkOnOpen(deps)).toEqual({ ok: true });
    expect(n.asked).toBe(0);
    expect(n.registered).toHaveLength(2);
    expect(sent()?.endpoint).toBe(`${NTFY_URL}/up2?up=1`);
  });

  it("registers again with a server's new VAPID key", async () => {
    const native = fakeNative({ distributors: [OWN], embedded: OWN });
    const { deps, cardd, n, store } = await setup(native, true);
    await register(deps);
    cardd.pushVapid = 'BNew';
    expect(await checkOnOpen(deps)).toEqual({ ok: true });
    expect(n.registered.at(-1)).toEqual({ vapid: 'BNew', distributor: OWN, fresh: true });
    expect((await store.alertsSent())?.vapid).toBe('BNew');
  });

  // A check's re-registration waiting on its endpoint must not turn alerts back on after Turn off.
  it('is cancelled by Turn off: it stops waiting, and hands cardd nothing after', async () => {
    let answers = true;
    const native = fakeNative({ answer: () => (answers ? ntfyEndpoint('upFirst') : null) });
    const { deps, sent, store, cardd } = await setup(native);
    await register(deps);
    answers = false;
    native.n.kept = null;
    const check = checkOnOpen({ ...deps, waitMs: 20_000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(native.n.registered).toHaveLength(2);
    // While the check waits, the work is busy: another check stays out.
    expect(await checkOnOpen(deps)).toBe('busy');
    const started = Date.now();
    await turnOff(deps);
    expect(await check).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(5_000);
    // The endpoint the check asked for comes late: nobody hands it on.
    native.n.emit(ntfyEndpoint('upLate'));
    await new Promise((r) => setTimeout(r, 5));
    expect(cardd.http.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(sent()).toBeNull();
    expect(await store.alertsSent()).toBeNull();
    expect(await checkOnOpen(deps)).toBe('off');
  });

  it('is cancelled by Turn on, which then registers on its own', async () => {
    let answers = true;
    const native = fakeNative({ answer: () => (answers ? ntfyEndpoint(`up${native.n.registered.length}`) : null) });
    const { deps, sent } = await setup(native);
    await register(deps);
    answers = false;
    native.n.kept = null;
    const check = checkOnOpen({ ...deps, waitMs: 20_000 });
    await new Promise((r) => setTimeout(r, 5));
    answers = true;
    expect(await register(deps)).toEqual({ ok: true });
    expect(await check).toBe('cancelled');
    expect(sent()?.endpoint).toBe(`${NTFY_URL}/up3?up=1`);
  });

  it("never sends an endpoint off a moved server's ntfy, and never throws", async () => {
    const { deps, sent, cardd } = await setup();
    await register(deps);
    cardd.pushEndpoints.clear();
    cardd.pushNtfy = 'https://vm-2.lnvps.cloud:8443';
    const before = cardd.http.requests.length;
    expect(await checkOnOpen(deps)).toEqual({ ok: false, why: 'ntfy-sh' });
    expect(cardd.http.requests.slice(before).map((r) => r.method)).toEqual(['GET']);
    expect(sent()).toBeNull();
    const down = { ...deps, cardd: Object.assign(Object.create(deps.cardd), { push: async () => Promise.reject(new Error('offline')) }) };
    expect(await checkOnOpen(down)).toEqual({ ok: false, why: 'server', detail: 'offline' });
  });
});

describe("the phone's side", () => {
  it("reads the distributors other than the app's own, ntfy's battery exemption and the endpoint's origin", () => {
    const { api, n } = fakeNative({ distributors: [OWN, NTFY], embedded: OWN });
    const phone = { ...api, ignoringBatteryOptimizations: (p: string) => p === NTFY, openNtfySettings: () => {}, openBatterySettings: () => {} };
    expect(readPhone(phone, true)).toEqual({ distributors: [NTFY], distributor: null, allowed: true, ntfyExempt: true, play: true, endpointOrigin: null });
    n.kept = ntfyEndpoint();
    n.saved = NTFY;
    expect(readPhone(phone, false)).toMatchObject({ distributors: [OWN, NTFY], distributor: NTFY, play: false, endpointOrigin: NTFY_URL });
    expect(readPhone({ ...phone, pushDistributors: () => [] }, false)).toMatchObject({ distributors: [], ntfyExempt: null });
  });

  it("is had by Android's module only", () => {
    expect(alertsSupported(fakeNative().api)).toBe(true);
    expect(alertsSupported({})).toBe(false);
  });
});
