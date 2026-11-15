import { describe, expect, it } from 'vitest';
import { CarddClient } from '../cardd/client';
import { AppStore } from '../store/store';
import { FakeCardd, vectorDeviceKey } from '../testing/fakeCardd';
import { nodeSqlite } from '../testing/nodeSqlite';
import { vectors } from '../testing/vectors';
import { requestId, resumePending, runRequest, type MoneyRequest } from './requests';

const ID = 'e07ce1279d980ecb892a81924b67bf18';

async function setup() {
  let now = 1_790_000_000_000;
  const cardd = new FakeCardd(() => now);
  cardd.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey);
  cardd.cards.set(ID, { id: ID, version: 1, state: 'active', counter: 0, name: 'Daily', created: 0, updated: 0 });
  cardd.balances.set('pool', 10_000_000);
  // failures: how many of the next requests fail as if the network were down;
  // badGateways: how many answer 502 from Caddy, cardd being down.
  // paused: how many answer cardd's own stored 503 "paused".
  const net = { failures: 0, badGateways: 0, paused: 0 };
  const fetch: typeof cardd.http.fetch = async (u, i) => {
    if (net.failures-- > 0) throw new Error('fetch failed: offline');
    if (net.badGateways-- > 0) return new Response('<html>502 Bad Gateway</html>', { status: 502 });
    if (net.paused-- > 0) return Response.json({ error: 'paused', message: 'ledger: spending is paused until the books add up again' }, { status: 503 });
    return cardd.http.fetch(u, i);
  };
  const client = new CarddClient({ fetch, host: 'vm-1.lnvps.cloud', key: vectorDeviceKey(), now: () => now });
  const store = await AppStore.open(nodeSqlite());
  const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
  return { cardd, deps: { cardd: client, store }, store, net, clock, tick: (ms: number) => (now += ms) };
}

const move = (id: string, started = 1_790_000_000_000): Extract<MoneyRequest, { kind: 'move' }> => ({ kind: 'move', id, from: 'pool', to: ID, amountMsat: 2_000_000, started });

describe('runRequest', () => {
  it('forgets the request once it is answered', async () => {
    const { deps, store, cardd, clock } = await setup();
    const out = await runRequest(deps, move('m1'), clock);
    expect(out).toEqual({ at: 'answered', answer: { status: 'moved' } });
    expect(await store.pendingRequests()).toEqual([]);
    expect(cardd.balances.get(ID)).toBe(2_000_000);
  });

  it('asks again with the same id and body after a network failure', async () => {
    const { deps, cardd, net, clock } = await setup();
    net.failures = 2;
    expect(await runRequest(deps, move('m1'), clock)).toEqual({ at: 'answered', answer: { status: 'moved' } });
    const bodies = cardd.http.requests.filter((r) => r.url.endsWith('/move')).map((r) => r.body);
    expect(bodies.length).toBe(1); // the two failures never reached it
    expect(cardd.balances.get(ID)).toBe(2_000_000);
  });

  it('waits while the server is still handling the id', async () => {
    const { deps, cardd, clock } = await setup();
    cardd.busy.add('m1');
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      cardd.busy.delete('m1');
    };
    expect(await runRequest(deps, move('m1'), { ...clock, sleep })).toEqual({ at: 'answered', answer: { status: 'moved' } });
  });

  it('retries a send with the same body, note included', async () => {
    const { deps, cardd, clock } = await setup();
    cardd.busy.add('r1');
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      cardd.busy.delete('r1');
    };
    const req: MoneyRequest = { kind: 'send', id: 'r1', to: 'alice@example.com', amountMsat: 1_000_000, comment: 'with Sam', started: clock.now() };
    expect(await runRequest(deps, req, { ...clock, sleep })).toMatchObject({ at: 'answered' });
    const bodies = cardd.http.requests.filter((r) => r.url.endsWith('/api/v1/send')).map((r) => r.body);
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ id: 'r1', to: 'alice@example.com', amountMsat: 1_000_000, comment: 'with Sam' });
  });

  // A 5xx (Caddy while cardd restarts, say during Update server) may come
  // after cardd acted: asked again with the same id, never dropped.
  it('asks again after a server error, which is not a refusal', async () => {
    const { deps, cardd, net, clock } = await setup();
    net.badGateways = 2;
    expect(await runRequest(deps, move('m1'), clock)).toEqual({ at: 'answered', answer: { status: 'moved' } });
    expect(cardd.balances.get(ID)).toBe(2_000_000);
  });

  // cardd's own answer, even a 5xx, was stored under the id: asking again
  // gets the same answer, so it is final, and its reason is shown.
  it("takes cardd's own 5xx answer as final", async () => {
    const { deps, store, net, clock } = await setup();
    net.paused = 1000;
    expect(await runRequest(deps, move('m1'), clock)).toMatchObject({ at: 'refused', error: { status: 503, code: 'paused' } });
    expect(await store.pendingRequests()).toEqual([]);
  });

  it('stops at a refusal, which is final', async () => {
    const { deps, store, clock } = await setup();
    const out = await runRequest(deps, { ...move('m1'), amountMsat: 99_000_000 }, clock);
    expect(out).toMatchObject({ at: 'refused', error: { code: 'insufficient' } });
    expect(await store.pendingRequests()).toEqual([]);
  });

  it('renews the VM now once per request id, through a network failure', async () => {
    const { deps, store, cardd, net, clock } = await setup();
    cardd.balances.set('hosting', 5_000_000);
    cardd.hostingSync = { expires: 1_790_864_000, msatPerDay: 221_395, vatOk: true, syncedAt: 1_790_000_000 };
    net.failures = 1;
    const out = await runRequest(deps, { kind: 'renew', id: 'r1', days: 1, started: clock.now() }, clock);
    expect(out).toEqual({ at: 'answered', answer: { status: 'sent', paymentHash: expect.any(String), amountMsat: 222_000, feeMsat: 0 } });
    expect(cardd.balances.get('hosting')).toBe(4_778_000);
    expect(await store.pendingRequests()).toEqual([]);
  });

  it('gives up after a minute without an answer, keeping the request saved', async () => {
    const { deps, store, net, clock } = await setup();
    net.failures = 1000;
    expect(await runRequest(deps, move('m1'), clock)).toEqual({ at: 'unknown' });
    expect((await store.pendingRequests()).map((r) => r.id)).toEqual(['m1']);
  });
});

describe('resumePending', () => {
  // A move left from before is asked again with its own id: the server
  // answers from the first time, or moves now, once. A send is not: the
  // person chose that a send that may not have gone out is never finished
  // later; it is dropped, and the screen says to check pool's history.
  it('finishes saved moves, drops saved sends and renewals unasked, and drops week-old ones', async () => {
    const { deps, store, cardd, clock, tick } = await setup();
    const send: MoneyRequest = { kind: 'send', id: 's1', to: 'alice@pay.example.com', amountMsat: 1_000_000, started: clock.now() };
    const renew: MoneyRequest = { kind: 'renew', id: 'r1', days: 7, started: clock.now() };
    await store.savePending(send);
    await store.savePending(renew);
    await store.savePending(move('m1'));
    await store.savePending(move('old', clock.now() - 8 * 24 * 3600_000));
    tick(5_000);
    const done = await resumePending(deps, clock);
    expect(done).toEqual([
      { req: send, outcome: { at: 'dropped' } },
      { req: renew, outcome: { at: 'dropped' } },
      { req: move('m1'), outcome: { at: 'answered', answer: { status: 'moved' } } },
    ]);
    expect(cardd.http.requests.filter((r) => r.url.endsWith('/send') || r.url.endsWith('/renew'))).toEqual([]);
    expect(cardd.balances.get('pool')).toBe(8_000_000);
    expect(await store.pendingRequests()).toEqual([]);
  });
});

describe('requestId', () => {
  it('is a random UUID v4', () => {
    expect(requestId(() => new Uint8Array(16).fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(requestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
