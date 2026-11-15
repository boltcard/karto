// Wiping a card, against the simulated card and a fake cardd.
import { describe, expect, it, vi } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardId } from '../boltcard/cardkeys';
import { TagLostError } from '../ntag424/apdu';
import { cardUrl, lnurlwFor } from '../ntag424/ndef';
import { cardAt, cardWorld } from '../testing/cardWorld';
import { Ntag424Sim } from '../testing/ntag424Sim';
import { addCard } from './add';
import { catchUp } from './catchUp';
import { CardFlowError } from './deps';
import { identify } from './identify';
import { wipeCard, WIPE_STEPS, WrongCardError, wrongCardText, type WipeStep } from './wipe';

const UID = hexToBytes('04a39493cc8680');
type World = Awaited<ReturnType<typeof cardWorld>>;

async function untilDone<T>(t: World, run: (card: ReturnType<World['tap']>['card'], tagUid: Uint8Array) => Promise<T>): Promise<T> {
  for (let i = 0; i < 4; i++) {
    const { card, tagUid } = t.tap();
    const r = await run(card, tagUid).then((v) => ({ v }), (e) => {
      if (e instanceof TagLostError) return undefined;
      throw e;
    });
    if (r) return r.v;
  }
  throw new Error('not done after 4 taps');
}

const add = (t: World) => untilDone(t, (card, tagUid) => addCard(card, tagUid, t.deps, { name: 'Daily', randomUid: true }));
const wipe = (t: World) => untilDone(t, (card) => wipeCard(card, t.deps));

/** A factory-fresh card, but with random UID on (that stays). */
function factoryWithRandomUid() {
  const s = new Ntag424Sim();
  s.randomUid = true;
  return s.snapshot();
}

describe('wipeCard', () => {
  it('wipes an added card back to blank: keys to zero with K0 last, then settings and URL; cardd says reset', async () => {
    const t = await cardWorld();
    await add(t);
    const wipeStart = t.sim.log.length;
    const steps: WipeStep[] = [];
    const { card } = t.tap();
    expect(await wipeCard(card, t.deps, { onStep: (s) => steps.push(s) })).toEqual({ serverTold: true, local: false });
    expect(steps).toEqual(WIPE_STEPS);
    expect(t.sim.snapshot()).toBe(factoryWithRandomUid());
    const writes = t.sim.log.slice(wipeStart).filter((c) => /ChangeKey|ChangeFileSettings|WriteData/.test(c));
    expect(writes).toEqual(['ChangeKey 1', 'ChangeKey 2', 'ChangeKey 3', 'ChangeKey 4', 'ChangeKey 0', 'ChangeFileSettings', 'WriteData']);
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    expect(t.cardd.cards.get(id)).toMatchObject({ state: 'reset', version: 0 });
    expect((await t.cache.cards())[id]).toEqual({ id, version: 0, name: 'Daily', state: 'reset' });
    expect((await identify(t.tap().card, t.deps)).kind).toBe('blank');
  });

  it('adds the wiped card again at version 1', async () => {
    const t = await cardWorld();
    await add(t);
    await wipe(t);
    expect(await add(t)).toMatchObject({ version: 1, state: 'active', name: 'Daily' });
  });

  // A card lifted at any command of the wipe, then held again, ends exactly as an uninterrupted wipe.
  it('finishes a wipe lifted before or after any command', async () => {
    const base = await cardWorld();
    await add(base);
    const start = base.sim.commands;
    await wipe(base);
    const total = base.sim.commands - start;
    for (let j = 0; j < total; j++) {
      for (const when of ['before', 'after'] as const) {
        const t = await cardWorld();
        await add(t);
        t.sim.lift = { at: start + j, when };
        await expect(wipeCard(t.tap().card, t.deps), `lift ${when} wipe command ${j}`).rejects.toBeInstanceOf(TagLostError);
        expect(await wipe(t), `lift ${when} wipe command ${j}`).toEqual({ serverTold: true, local: false });
        expect(t.sim.snapshot(), `lift ${when} wipe command ${j}`).toBe(factoryWithRandomUid());
        expect(t.cardd.cards.get(bytesToHex(cardId(t.deps.issuer, UID)))?.state).toBe('reset');
      }
    }
  }, 30_000); // ~60 adds or wipes: more than vitest's default 5 s alongside the other test files

  // A wipe never depends on the VM still existing.
  it('wipes with the server down, then catches it up', async () => {
    const t = await cardWorld();
    await add(t);
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.w.carddDown = true;
    expect(await wipe(t)).toEqual({ serverTold: false, local: false });
    expect(t.sim.snapshot()).toBe(factoryWithRandomUid());
    expect((await t.cache.cards())[id]).toMatchObject({ state: 'reset', pending: 'wiped' });
    expect(t.cardd.cards.get(id)?.state).toBe('active');
    t.w.carddDown = false;
    expect(await catchUp(t.deps)).toBe(1);
    expect(t.cardd.cards.get(id)?.state).toBe('reset');
    expect((await t.cache.cards())[id].pending).toBeUndefined();
    expect(await catchUp(t.deps)).toBe(0);
  });

  it('finishes a wipe started with the server down once it is back', async () => {
    // Where an offline wipe changes key 2 (each command logs one line, so log index = command number).
    const base = await cardWorld();
    await add(base);
    base.w.carddDown = true;
    const start = base.sim.commands;
    await wipe(base);
    const at = base.sim.log.indexOf('ChangeKey 2', start);

    const t = await cardWorld();
    await add(t);
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.w.carddDown = true;
    t.sim.lift = { at, when: 'after' };
    await expect(wipeCard(t.tap().card, t.deps)).rejects.toBeInstanceOf(TagLostError);
    expect((await t.cache.cards())[id]).toMatchObject({ state: 'wiping', pending: 'wipe' });
    t.w.carddDown = false;
    expect(await wipe(t)).toEqual({ serverTold: true, local: false });
    expect(t.cardd.cards.get(id)?.state).toBe('reset');
    expect((await t.cache.cards())[id].pending).toBeUndefined();
  });

  it('finishes its own offline wipe lifted after key 0, once the server is back', async () => {
    const base = await cardWorld();
    await add(base);
    base.w.carddDown = true;
    const start = base.sim.commands;
    await wipe(base);
    const at = base.sim.log.indexOf('ChangeKey 0', start);

    const t = await cardWorld();
    await add(t);
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.w.carddDown = true;
    t.sim.lift = { at, when: 'after' };
    await expect(wipeCard(t.tap().card, t.deps)).rejects.toBeInstanceOf(TagLostError);
    t.w.carddDown = false;
    expect(await wipe(t)).toEqual({ serverTold: true, local: false });
    expect(t.cardd.cards.get(id)?.state).toBe('reset');
    expect((await t.cache.cards())[id].pending).toBeUndefined();
  });

  it('wipes a card whose add stopped before K0', async () => {
    const t = await cardWorld();
    t.use(cardAt(t.deps.issuer, 0, { versions: [0, 1, 1, 0, 0] }));
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.cardd.cards.set(id, { id, version: 0, state: 'programming', counter: -1, name: '', created: 0, updated: 0 });
    await wipe(t);
    expect(t.sim.versions).toEqual([0, 0, 0, 0, 0]);
    expect(t.cardd.cards.get(id)?.state).toBe('reset');
  });

  it('wipes a card this server never knew, finding its version by trying c', async () => {
    const t = await cardWorld();
    t.use(cardAt(t.deps.issuer, 3));
    expect(await wipe(t)).toEqual({ serverTold: true, local: false });
    expect(t.sim.versions).toEqual([0, 0, 0, 0, 0]);
  });

  it('refuses a blank card and someone else\'s', async () => {
    const t = await cardWorld();
    await expect(wipeCard(t.tap().card, t.deps)).rejects.toThrow('already blank');
    const K = (b: number) => new Uint8Array(16).fill(b);
    t.use(Ntag424Sim.programmed({ keys: [K(9), K(8), K(7), K(6), K(5)], versions: [1, 1, 1, 1, 1], url: cardUrl(lnurlwFor('example.com')) }));
    await expect(wipeCard(t.tap().card, t.deps)).rejects.toBeInstanceOf(CardFlowError);
    expect(t.sim.versions).toEqual([1, 1, 1, 1, 1]);
  });

  // A card whose keys were written at another version, stopped before K0, can still be wiped.
  it('wipes a card the version check stopped', async () => {
    const t = await cardWorld();
    t.use(cardAt(t.deps.issuer, 1, { versions: [0, 1, 1, 1, 1] }));
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.cardd.cards.set(id, { id, version: 0, state: 'programming', counter: -1, name: 'Daily', created: 0, updated: 0 });
    await expect(add(t)).rejects.toThrow('another version');
    await wipe(t);
    expect(t.sim.versions).toEqual([0, 0, 0, 0, 0]);
    expect(t.cardd.cards.get(id)?.state).toBe('reset');
  });

  // A tag must prove it holds the card's K0 before cardd hears of a wipe.
  it('leaves cardd alone for a zero-K0 tag that only claims an active card\'s UID', async () => {
    const t = await cardWorld();
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.cardd.cards.set(id, { id, version: 0, state: 'active', counter: 3, name: 'Daily', created: 0, updated: 0 });
    t.use(new Ntag424Sim(UID));
    // local: this phone leaves the server alone, and its result says so (the result page's third ending).
    expect(await wipe(t)).toEqual({ serverTold: false, local: true });
    expect(t.cardd.cards.get(id)?.state).toBe('active');
    expect((await t.cache.cards())[id]).toBeUndefined();
  });

  it('leaves cardd alone for a tag with zero K1 and K2 that fails key 0', async () => {
    const t = await cardWorld();
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.cardd.cards.set(id, { id, version: 0, state: 'active', counter: 3, name: 'Daily', created: 0, updated: 0 });
    // Keys 1 and 2 back at zero, so p and c are under zero keys; key 0 is not this card's.
    const forged = Ntag424Sim.programmed({ uid: UID, keys: [new Uint8Array(16).fill(9), new Uint8Array(16), new Uint8Array(16), new Uint8Array(16), new Uint8Array(16)], versions: [1, 0, 0, 0, 0], url: cardUrl(lnurlwFor('vm-1.lnvps.cloud')) });
    t.use(forged);
    await expect(wipe(t)).rejects.toThrow();
    expect(t.cardd.cards.get(id)?.state).toBe('active');
  });
});

// A wipe is for one card, and refuses any other before anything is told or written.
describe('wipeCard bound to one card', () => {
  const UID2 = hexToBytes('04b1b2b3b4b5b6');
  const idOf = (t: World, uid: Uint8Array) => bytesToHex(cardId(t.deps.issuer, uid));
  const WRITES = /ChangeKey|ChangeFileSettings|WriteData|UpdateBinary/;

  /** Daily (UID) and Kids (UID2) both added; Kids is the card in the field. */
  async function twoCards() {
    const t = await cardWorld();
    await add(t);
    const daily = t.sim;
    t.use(new Ntag424Sim(UID2));
    await untilDone(t, (card, tagUid) => addCard(card, tagUid, t.deps, { name: 'Kids', randomUid: true }));
    return { t, daily, kids: t.sim, only: { id: idOf(t, UID), name: 'Daily' } };
  }

  it("refuses another of the person's cards by name, with the server told nothing and the card untouched; then wipes its own", async () => {
    const { t, daily, kids, only } = await twoCards();
    const told = vi.spyOn(t.deps.cardd, 'wipeCard');
    const before = kids.log.length;
    const cached = await t.cache.cards();
    const e = await wipeCard(t.tap().card, t.deps, { only }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WrongCardError);
    expect(e).toBeInstanceOf(CardFlowError);
    expect((e as Error).message).toBe('This is Kids, not Daily. Hold Daily to wipe it.');
    expect(told).not.toHaveBeenCalled();
    expect(kids.log.slice(before).filter((c) => WRITES.test(c))).toEqual([]);
    expect(kids.versions).toEqual([1, 1, 1, 1, 1]);
    expect(await t.cache.cards()).toEqual(cached);
    expect(t.cardd.cards.get(idOf(t, UID2))?.state).toBe('active');
    expect(t.cardd.cards.get(only.id)?.state).toBe('active');

    t.use(daily);
    expect(await wipeCard(t.tap().card, t.deps, { only })).toEqual({ serverTold: true, local: false });
    expect(t.cardd.cards.get(only.id)?.state).toBe('reset');
    expect(t.cardd.cards.get(idOf(t, UID2))?.state).toBe('active');
  });

  it('takes a blank other card for the wrong card, and says "already blank" only of its own', async () => {
    const t = await cardWorld();
    await add(t);
    const daily = t.sim;
    const only = { id: idOf(t, UID), name: 'Daily' };
    t.use(new Ntag424Sim(UID2));
    await expect(wipeCard(t.tap().card, t.deps, { only })).rejects.toThrow("This isn't Daily. Hold Daily to wipe it.");
    t.use(daily);
    await wipeCard(t.tap().card, t.deps, { only });
    await expect(wipeCard(t.tap().card, t.deps, { only })).rejects.toThrow('This card is already blank.');
  });

  it("keeps another service's card's own refusal", async () => {
    const t = await cardWorld();
    const K = (b: number) => new Uint8Array(16).fill(b);
    t.use(Ntag424Sim.programmed({ keys: [K(9), K(8), K(7), K(6), K(5)], versions: [1, 1, 1, 1, 1], url: cardUrl(lnurlwFor('example.com')) }));
    await expect(wipeCard(t.tap().card, t.deps, { only: { id: idOf(t, UID), name: 'Daily' } })).rejects.toThrow('belongs to another service');
  });

  // The bound card is never refused part-way: its id is found the same with key 1 back at zero.
  it("finishes its own card's wipe lifted before or after any command", async () => {
    const base = await cardWorld();
    await add(base);
    const start = base.sim.commands;
    await wipe(base);
    const total = base.sim.commands - start;
    for (let j = 0; j < total; j++) {
      for (const when of ['before', 'after'] as const) {
        const t = await cardWorld();
        await add(t);
        const only = { id: idOf(t, UID), name: 'Daily' };
        t.sim.lift = { at: start + j, when };
        await expect(wipeCard(t.tap().card, t.deps, { only }), `lift ${when} wipe command ${j}`).rejects.toBeInstanceOf(TagLostError);
        expect(await untilDone(t, (card) => wipeCard(card, t.deps, { only })), `lift ${when} wipe command ${j}`).toEqual({ serverTold: true, local: false });
        expect(t.sim.snapshot(), `lift ${when} wipe command ${j}`).toBe(factoryWithRandomUid());
      }
    }
  }, 30_000);

  it("with the server down, names the wrong card from the phone's cache and wipes its own, to be caught up", async () => {
    const { t, daily, only } = await twoCards();
    t.w.carddDown = true;
    await expect(wipeCard(t.tap().card, t.deps, { only })).rejects.toThrow('This is Kids, not Daily. Hold Daily to wipe it.');
    expect((await t.cache.cards())[idOf(t, UID2)]).toMatchObject({ state: 'active' });
    t.use(daily);
    expect(await wipeCard(t.tap().card, t.deps, { only })).toEqual({ serverTold: false, local: false });
    expect((await t.cache.cards())[only.id]).toMatchObject({ state: 'reset', pending: 'wiped' });
    t.w.carddDown = false;
    expect(await catchUp(t.deps)).toBe(1);
    expect(t.cardd.cards.get(only.id)?.state).toBe('reset');
    expect(t.cardd.cards.get(idOf(t, UID2))?.state).toBe('active');
  });

  it("wipes a card the server doesn't know when it is the bound one, and refuses it without a name when it isn't", async () => {
    const t = await cardWorld();
    t.use(cardAt(t.deps.issuer, 3, { uid: UID2 }));
    await expect(wipeCard(t.tap().card, t.deps, { only: { id: idOf(t, UID), name: 'Daily' } })).rejects.toThrow("This isn't Daily. Hold Daily to wipe it.");
    expect(t.sim.versions).toEqual([1, 1, 1, 1, 1]);
    expect(await wipeCard(t.tap().card, t.deps, { only: { id: idOf(t, UID2) } })).toEqual({ serverTold: true, local: false });
    expect(t.sim.versions).toEqual([0, 0, 0, 0, 0]);
  });

  it("refuses a zero-K0 tag that claims another card's UID, before the path that leaves the server alone", async () => {
    const t = await cardWorld();
    const kids = idOf(t, UID2);
    t.cardd.cards.set(kids, { id: kids, version: 0, state: 'active', counter: 3, name: 'Kids', created: 0, updated: 0 });
    t.use(new Ntag424Sim(UID2));
    await expect(wipeCard(t.tap().card, t.deps, { only: { id: idOf(t, UID), name: 'Daily' } })).rejects.toThrow('This is Kids, not Daily. Hold Daily to wipe it.');
    expect(t.cardd.cards.get(kids)?.state).toBe('active');
    expect((await t.cache.cards())[kids]).toBeUndefined();
  });

  it('finishes the wipe of a card the server already has as reset, with no /wipe call', async () => {
    const t = await cardWorld();
    const id = idOf(t, UID);
    t.use(cardAt(t.deps.issuer, 0));
    t.cardd.cards.set(id, { id, version: 0, state: 'reset', counter: 3, name: 'Daily', created: 0, updated: 0 });
    const told = vi.spyOn(t.deps.cardd, 'wipeCard');
    expect(await wipeCard(t.tap().card, t.deps, { only: { id, name: 'Daily' } })).toEqual({ serverTold: true, local: false });
    expect(told).not.toHaveBeenCalled();
    expect(t.sim.versions).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('wrongCardText', () => {
  it('names both cards, the bound one alone, or neither', () => {
    expect(wrongCardText('Kids', 'Daily')).toBe('This is Kids, not Daily. Hold Daily to wipe it.');
    expect(wrongCardText(undefined, 'Daily')).toBe("This isn't Daily. Hold Daily to wipe it.");
    expect(wrongCardText('', 'Daily')).toBe("This isn't Daily. Hold Daily to wipe it.");
    expect(wrongCardText('Kids', undefined)).toBe("This isn't the card to wipe. Hold that card.");
    expect(wrongCardText(undefined, '')).toBe("This isn't the card to wipe. Hold that card.");
  });
});
