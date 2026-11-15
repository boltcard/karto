// A server call made while a card is held gives up after 5 seconds:
// what each job then does, against the simulated card and a fake cardd whose answers can be held back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardId } from '../boltcard/cardkeys';
import { withTimeout, type FetchFn } from '../lightning/lightning';
import { cardAt, cardWorld } from '../testing/cardWorld';
import { addCard } from './add';
import { adoptCard } from './adopt';
import { catchUp } from './catchUp';
import { checkTap } from './check';
import { CardFlowError, heldFetch, isNetworkFailure, type CardDeps } from './deps';
import { identify } from './identify';
import { describeError } from './labels';
import { repointCard } from './repoint';
import { wipeCard } from './wipe';

const UID = hexToBytes('04a39493cc8680');
const TIMED_OUT = { text: "Your server didn't answer in time. Hold the card again to carry on.", again: true };
type World = Awaited<ReturnType<typeof cardWorld>>;

beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => void vi.useRealTimers());

/** A job under way, and how it ended once it has. */
function watch<T>(job: Promise<T>) {
  const r: { done: boolean; value?: T; error?: unknown } = { done: false };
  job.then((value) => Object.assign(r, { done: true, value }), (error: unknown) => Object.assign(r, { done: true, error }));
  return r;
}
/** Lets what is ready run until the job has ended, without moving the clock. */
async function settle(r: { done: boolean }) {
  for (let i = 0; i < 200 && !r.done; i++) await new Promise((go) => setImmediate(go));
}
/** Lets what is ready run, for a job that should still be waiting. */
async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((go) => setImmediate(go));
}
/**
 * Runs a job whose call to `method path` gets no answer: it must still be waiting a moment before the 5 seconds
 * are up, and have ended once they are.
 */
async function withNoAnswer<T>(t: World, method: string, path: RegExp, run: () => Promise<T>) {
  const reached = new Promise<void>((go) => (t.w.stalled = go));
  t.w.stall = (m, p) => m === method && path.test(p);
  const r = watch(run());
  await reached;
  await vi.advanceTimersByTimeAsync(4999);
  await flush();
  expect(r.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await settle(r);
  expect(r.done).toBe(true);
  t.w.stall = null;
  return r;
}
const LIST = /^\/api\/v1\/cards$/;
const add = (t: World) => {
  const { card, tagUid } = t.tap();
  return addCard(card, tagUid, t.deps, { name: 'Daily', randomUid: true });
};

describe('the cap on a call made with the card held', () => {
  it('is 5 seconds, also over a fetch that would itself wait 30', async () => {
    const never: FetchFn = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const r = watch(heldFetch(withTimeout(never, 30_000))('https://vm-1.lnvps.cloud/api/v1/cards'));
    await vi.advanceTimersByTimeAsync(4999);
    expect(r.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.error).toEqual(new Error('fetch failed: no answer from vm-1.lnvps.cloud in 5 s'));
    expect(isNetworkFailure(r.error)).toBe(true);
  });

  it.each([
    ['reserve', 'POST', LIST],
    ['confirm', 'POST', /\/confirm$/],
  ])('stops an add in amber when %s gets no answer, with words of its own', async (_name, method, path) => {
    const t = await cardWorld();
    const r = await withNoAnswer(t, method, path, () => add(t));
    expect(describeError(r.error)).toEqual(TIMED_OUT);
    // Holding the card again carries on.
    expect(await add(t)).toMatchObject({ state: 'active', name: 'Daily' });
  });

  it('stops a re-point in amber when its check gets no answer', async () => {
    const t = await cardWorld();
    t.use(cardAt(t.deps.issuer, 0, { host: 'vm-9.lnvps.cloud' }));
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.cardd.cards.set(id, { id, version: 0, state: 'active', counter: 0, name: 'Daily', host: 'vm-9.lnvps.cloud', created: 0, updated: 0 });
    const r = await withNoAnswer(t, 'POST', /\/cards\/check$/, () => repointCard(t.tap().card, t.deps));
    expect(describeError(r.error)).toEqual(TIMED_OUT);
    expect(await repointCard(t.tap().card, t.deps)).toMatchObject({ id, host: 'vm-1.lnvps.cloud' });
  });

  it('stops an add back in amber when it gets no answer', async () => {
    const t = await cardWorld();
    t.use(cardAt(t.deps.issuer, 0, { host: 'vm-9.lnvps.cloud' }));
    const r = await withNoAnswer(t, 'POST', /\/cards\/adopt$/, () => adoptCard(t.tap().card, t.deps, { name: 'Daily' }));
    expect(describeError(r.error)).toEqual(TIMED_OUT);
    expect(await adoptCard(t.tap().card, t.deps, { name: 'Daily' })).toMatchObject({ state: 'active', host: 'vm-1.lnvps.cloud' });
  });

  // The first call of every job, the card list: as for a server out of reach.
  it('refuses an add when the card list gets no answer', async () => {
    const t = await cardWorld();
    const r = await withNoAnswer(t, 'GET', LIST, () => add(t));
    expect(r.error).toEqual(new CardFlowError("Can't reach your server. Adding a card needs it."));
    expect(t.sim.versions).toEqual([0, 0, 0, 0, 0]);
  });

  it('refuses a re-point and an add back when the card list gets no answer', async () => {
    const t = await cardWorld();
    t.use(cardAt(t.deps.issuer, 0, { host: 'vm-9.lnvps.cloud' }));
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    await t.cache.saveCard({ id, version: 0, name: 'Daily', state: 'active' });
    const repoint = await withNoAnswer(t, 'GET', LIST, () => repointCard(t.tap().card, t.deps));
    expect(repoint.error).toEqual(new CardFlowError("Can't reach your server. Re-pointing checks the card with it afterwards."));
    const back = await withNoAnswer(t, 'GET', LIST, () => adoptCard(t.tap().card, t.deps, { name: 'Daily' }));
    expect(back.error).toEqual(new CardFlowError("Can't reach your server. Adding a card back needs it."));
    expect(t.sim.log.some((c) => /WriteData|ChangeFileSettings|ChangeKey/.test(c))).toBe(false);
  });

  it('reads a card from what the phone remembers when the card list gets no answer (the Wallet\'s read)', async () => {
    const t = await cardWorld();
    const { id } = await add(t);
    const r = await withNoAnswer(t, 'GET', LIST, () => identify(t.tap().card, t.deps));
    expect(r.value).toMatchObject({ kind: 'ours', id, serverDown: true, known: { name: 'Daily', state: 'active' } });
  });

  it('goes on with a wipe when the card list gets no answer, and tells the server later', async () => {
    const t = await cardWorld();
    const { id } = await add(t);
    const r = await withNoAnswer(t, 'GET', LIST, () => wipeCard(t.tap().card, t.deps));
    expect(r.value).toMatchObject({ serverTold: false });
    expect(t.sim.versions).toEqual([0, 0, 0, 0, 0]);
    expect(t.cardd.cards.get(id)!.state).toBe('active');
    await catchUp(t.deps);
    expect(t.cardd.cards.get(id)!.state).toBe('reset');
  });

  it('goes on with a wipe when telling the server gets no answer', async () => {
    const t = await cardWorld();
    await add(t);
    const r = await withNoAnswer(t, 'POST', /\/wipe$/, () => wipeCard(t.tap().card, t.deps));
    expect(r.value).toMatchObject({ serverTold: false });
    expect(t.sim.versions).toEqual([0, 0, 0, 0, 0]);
  });

  it('answers a tap check that gets no answer as it does for a server out of reach', async () => {
    const t = await cardWorld();
    await add(t);
    const identity = await identify(t.tap().card, t.deps);
    const r = await withNoAnswer(t, 'POST', /\/cards\/check$/, () => checkTap(identity, t.deps));
    expect(r.value).toEqual({ ok: false, reason: "Can't reach your server to check this tap." });
  });
});

describe('a call made with no card held', () => {
  it('keeps its 30 seconds: the catch-up after a wipe the server missed', async () => {
    const t = await cardWorld();
    await add(t);
    t.w.carddDown = true;
    await wipeCard(t.tap().card, t.deps);
    t.w.carddDown = false;
    const reached = new Promise<void>((go) => (t.w.stalled = go));
    t.w.stall = (m, p) => m === 'GET' && LIST.test(p);
    const r = watch(catchUp(t.deps));
    await reached;
    await vi.advanceTimersByTimeAsync(29_999);
    await flush();
    expect(r.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle(r);
    expect(r.error).toEqual(new Error('fetch failed: no answer from vm-1.lnvps.cloud in 30 s'));
  });
});

describe('which client a job asks', () => {
  /** A client no job may touch. */
  const untouchable = (name: string) => new Proxy({}, { get: (_t, call) => () => Promise.reject(new Error(`${name}.${String(call)} was called`)) }) as CardDeps['cardd'];

  it('is the capped one for every call of every job', async () => {
    const t = await cardWorld();
    const deps = { ...t.deps, cardd: untouchable('cardd') };
    const { card, tagUid } = t.tap();
    const { id } = await addCard(card, tagUid, deps, { name: 'Daily', randomUid: true });
    const identity = await identify(t.tap().card, deps);
    expect(await checkTap(identity, deps)).toMatchObject({ ok: true });
    expect(await repointCard(t.tap().card, deps)).toMatchObject({ id });
    expect(await wipeCard(t.tap().card, deps)).toMatchObject({ serverTold: true });
    t.use(cardAt(t.deps.issuer, 1, { host: 'vm-9.lnvps.cloud', uid: hexToBytes('04112233445566') }));
    expect(await adoptCard(t.tap().card, deps, { name: 'Kids' })).toMatchObject({ state: 'active' });
  });
});
