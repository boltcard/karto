// Adding a card, against the simulated card and a fake cardd.
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardId, deriveCardKeys } from '../boltcard/cardkeys';
import { TagLostError } from '../ntag424/apdu';
import { cardAt, cardWorld } from '../testing/cardWorld';
import { Ntag424Sim } from '../testing/ntag424Sim';
import { cardUrl, lnurlwFor } from '../ntag424/ndef';
import { addCard, ADD_STEPS, type AddStep } from './add';
import { CardFlowError } from './deps';

const UID = hexToBytes('04a39493cc8680');
const opts = { name: 'Daily', randomUid: true };

/** Taps until the add finishes (a lifted card throws TagLostError and is held again). */
async function addUntilDone(t: Awaited<ReturnType<typeof cardWorld>>, o = opts) {
  for (let i = 0; i < 4; i++) {
    const { card, tagUid } = t.tap();
    const r = await addCard(card, tagUid, t.deps, o).catch((e) => {
      if (e instanceof TagLostError) return undefined;
      throw e;
    });
    if (r) return r;
  }
  throw new Error('still not added after 4 taps');
}

describe('addCard', () => {
  it('adds a blank card: random UID, reserve, URL and SUN, K1–K4, K0 last, then cardd confirms', async () => {
    const t = await cardWorld();
    const steps: AddStep[] = [];
    const { card, tagUid } = t.tap();
    const info = await addCard(card, tagUid, t.deps, { ...opts, onStep: (s) => steps.push(s) });
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    expect(info).toMatchObject({ id, version: 0, state: 'active', name: 'Daily' });
    expect(steps).toEqual(ADD_STEPS);
    expect(t.sim.versions).toEqual([1, 1, 1, 1, 1]);
    expect(t.sim.randomUid).toBe(true);
    const writes = t.sim.log.filter((c) => /ChangeKey|ChangeFileSettings|SetConfiguration|WriteData/.test(c));
    expect(writes).toEqual(['SetConfiguration', 'WriteData', 'ChangeFileSettings', 'ChangeKey 1', 'ChangeKey 2', 'ChangeKey 3', 'ChangeKey 4', 'ChangeKey 0']);
    const k = deriveCardKeys(t.deps.issuer, UID, 0);
    expect(t.sim.keys.map((x) => bytesToHex(x))).toEqual([k.k0, k.k1, k.k2, k.k3, k.k4].map((x) => bytesToHex(x)));
    expect(await t.cache.cards()).toEqual({ [id]: { id, version: 0, name: 'Daily', state: 'active' } });
  });

  it('leaves random UID off when the person turned it off', async () => {
    const t = await cardWorld();
    const { card, tagUid } = t.tap();
    await addCard(card, tagUid, t.deps, { name: 'Daily', randomUid: false });
    expect(t.sim.randomUid).toBe(false);
    expect(t.sim.log).not.toContain('SetConfiguration');
  });

  // Finish setup once ran with the hiding on, so a card begun with it off, and stopped before key 0,
  // had its ID hidden for good by the hold that finished it. It now runs with randomUid false (cards/hold.ts holdParams).
  it('finishes a stopped add without touching the ID setting when told not to hide it, and hides it when told to', async () => {
    const whole = await cardWorld();
    const first = whole.tap();
    await addCard(first.card, first.tagUid, whole.deps, { name: 'Daily', randomUid: false });
    const at = whole.sim.log.indexOf('ChangeKey 2'); // each command logs one line: after cardd reserved the card, before key 0
    for (const [resumeWith, hidden] of [[false, false], [true, true]] as const) {
      const t = await cardWorld();
      t.sim.lift = { at, when: 'after' };
      const { card, tagUid } = t.tap();
      await expect(addCard(card, tagUid, t.deps, { name: 'Daily', randomUid: false })).rejects.toBeInstanceOf(TagLostError);
      expect(t.sim.randomUid).toBe(false);
      expect(await addUntilDone(t, { name: '', randomUid: resumeWith })).toMatchObject({ state: 'active', name: 'Daily' });
      expect(t.sim.randomUid, `resumed with randomUid ${resumeWith}`).toBe(hidden);
    }
  });

  // The server's rule the hold screen must not trip: a name sent with a part-way card renames it (cards/hold.ts holdNames sends none for Finish setup).
  it("keeps a part-way card's name when it is finished with no name, and takes a name that is sent", async () => {
    for (const [sent, kept] of [['', 'Kids'], ['Daily', 'Daily']] as const) {
      const t = await cardWorld();
      const id = bytesToHex(cardId(t.deps.issuer, UID));
      t.cardd.cards.set(id, { id, version: 0, state: 'programming', counter: -1, name: 'Kids', created: 0, updated: 0 });
      expect((await addUntilDone(t, { name: sent, randomUid: false })).name, `finished with the name ${JSON.stringify(sent)}`).toBe(kept);
    }
  });

  it('adds a wiped card again at the next version', async () => {
    const t = await cardWorld();
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.cardd.cards.set(id, { id, version: 0, state: 'reset', counter: 9, name: 'Old', created: 0, updated: 0 });
    const info = await addUntilDone(t, { name: '', randomUid: true });
    expect(info).toMatchObject({ version: 1, name: 'Old', state: 'active' });
  });

  // A card lifted at any command, then held again, ends exactly as an uninterrupted add.
  it('finishes an add lifted before or after any command', async () => {
    const base = await cardWorld();
    await addUntilDone(base);
    const total = base.sim.commands;
    const expected = base.sim.snapshot();
    for (let at = 0; at < total; at++) {
      for (const when of ['before', 'after'] as const) {
        const t = await cardWorld();
        t.sim.lift = { at, when };
        const { card, tagUid } = t.tap();
        await expect(addCard(card, tagUid, t.deps, opts), `lift ${when} command ${at}`).rejects.toBeInstanceOf(TagLostError);
        expect(await addUntilDone(t), `lift ${when} command ${at}`).toMatchObject({ state: 'active', version: 0 });
        expect(t.sim.snapshot(), `lift ${when} command ${at}`).toBe(expected);
      }
    }
  }, 30_000); // ~60 adds or wipes: more than vitest's default 5 s alongside the other test files

  // cardd stops answering after the reserve. The card is fully written; the next tap confirms.
  it('waits for the server to confirm, and finishes when it is back', async () => {
    const t = await cardWorld();
    // The same client, except that confirm gets no answer.
    const held = Object.assign(Object.create(t.deps.held), {
      confirmCard: async () => {
        throw new TypeError('fetch failed: no answer from vm-1.lnvps.cloud');
      },
    });
    const down = { ...t.deps, held };
    const first = t.tap();
    await expect(addCard(first.card, first.tagUid, down, opts)).rejects.toThrow('fetch failed');
    expect(t.sim.versions).toEqual([1, 1, 1, 1, 1]);
    const steps: AddStep[] = [];
    const again = t.tap();
    expect(await addCard(again.card, again.tagUid, t.deps, { ...opts, onStep: (s) => steps.push(s) })).toMatchObject({ state: 'active' });
    expect(steps).toEqual(ADD_STEPS);
  });

  // A confirm whose answer was lost after the server made the card active.
  describe('after a confirm that reached the server and whose answer was lost', () => {
    /** An add stopped at its last call: the server has the card active, the phone was told nothing. Its id, and the steps reported with it. */
    async function confirmLost() {
      const t = await cardWorld();
      const held = Object.assign(Object.create(t.deps.held), {
        confirmCard: async (id: string, sun: { p: string; c: string }) => {
          await t.deps.held.confirmCard(id, sun);
          throw new TypeError('fetch failed: no answer from vm-1.lnvps.cloud in 5 s');
        },
      });
      const reported: [AddStep, string][] = [];
      const { card, tagUid } = t.tap();
      await expect(addCard(card, tagUid, { ...t.deps, held }, { ...opts, onStep: (s, id) => reported.push([s, id]) })).rejects.toThrow('fetch failed');
      const id = bytesToHex(cardId(t.deps.issuer, UID));
      expect(t.cardd.cards.get(id)!.state).toBe('active');
      return { t, id, reported };
    }

    it('reports the card\'s id with each step, up to the one before the confirm', async () => {
      const { id, reported } = await confirmLost();
      expect(reported).toEqual(ADD_STEPS.slice(0, -1).map((s) => [s, id]));
    });

    it('ends the next hold of that card as added, where it would refuse one of the person\'s own', async () => {
      const { t, id } = await confirmLost();
      const again = t.tap();
      await expect(addCard(again.card, again.tagUid, t.deps, opts)).rejects.toThrow('This card is already one of yours.');
      const steps: AddStep[] = [];
      const third = t.tap();
      const info = await addCard(third.card, third.tagUid, t.deps, { ...opts, confirming: id, onStep: (s) => steps.push(s) });
      expect(info).toMatchObject({ id, state: 'active', name: 'Daily', version: 0 });
      expect(steps).toEqual(['confirm']);
      expect(await t.cache.cards()).toEqual({ [id]: { id, version: 0, name: 'Daily', state: 'active' } });
      // Nothing more was written to the card.
      expect(t.sim.log.filter((c) => /ChangeKey|WriteData|ChangeFileSettings|SetConfiguration/.test(c))).toHaveLength(8);
    });

    it('still refuses another of the person\'s cards', async () => {
      const { t } = await confirmLost();
      const other = hexToBytes('04112233445566');
      t.use(cardAt(t.deps.issuer, 0, { uid: other }));
      const otherId = bytesToHex(cardId(t.deps.issuer, other));
      t.cardd.cards.set(otherId, { id: otherId, version: 0, state: 'active', counter: 1, name: 'Kids', created: 0, updated: 0 });
      const { card, tagUid } = t.tap();
      await expect(addCard(card, tagUid, t.deps, { ...opts, confirming: bytesToHex(cardId(t.deps.issuer, UID)) })).rejects.toThrow('This card is already one of yours.');
    });

    it('still refuses that card once it is frozen: it is no longer the add\'s to finish', async () => {
      const { t, id } = await confirmLost();
      t.cardd.cards.get(id)!.state = 'frozen';
      const { card, tagUid } = t.tap();
      await expect(addCard(card, tagUid, t.deps, { ...opts, confirming: id })).rejects.toThrow('This card is already one of yours.');
    });
  });

  it('refuses to start without the server', async () => {
    const t = await cardWorld();
    t.w.carddDown = true;
    const { card, tagUid } = t.tap();
    await expect(addCard(card, tagUid, t.deps, opts)).rejects.toThrow("Can't reach your server");
    expect(t.sim.log.some((c) => /ChangeKey|WriteData|SetConfiguration/.test(c))).toBe(false);
  });

  it('refuses a card with someone else\'s keys, and one of the person\'s own', async () => {
    const t = await cardWorld();
    const K = (b: number) => new Uint8Array(16).fill(b);
    t.use(Ntag424Sim.programmed({ keys: [K(9), K(8), K(7), K(6), K(5)], versions: [1, 1, 1, 1, 1], url: cardUrl(lnurlwFor('example.com')) }));
    const a = t.tap();
    await expect(addCard(a.card, a.tagUid, t.deps, opts)).rejects.toBeInstanceOf(CardFlowError);
    t.use(cardAt(t.deps.issuer, 0));
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.cardd.cards.set(id, { id, version: 0, state: 'active', counter: 1, name: 'Daily', created: 0, updated: 0 });
    const b = t.tap();
    await expect(addCard(b.card, b.tagUid, t.deps, opts)).rejects.toThrow('already one of yours');
  });

  // Keys already on the card were written at another version than cardd's.
  it('stops before key 0 when the card\'s keys were written at another version', async () => {
    const t = await cardWorld();
    t.use(cardAt(t.deps.issuer, 1, { versions: [0, 1, 1, 1, 1] }));
    const id = bytesToHex(cardId(t.deps.issuer, UID));
    t.cardd.cards.set(id, { id, version: 0, state: 'programming', counter: -1, name: 'Daily', created: 0, updated: 0 });
    const { card, tagUid } = t.tap();
    const e = await addCard(card, tagUid, t.deps, opts).catch((x) => x);
    expect(e).toBeInstanceOf(CardFlowError);
    expect(e.message).toContain('another version');
    expect(t.sim.versions[0]).toBe(0);
    expect(t.sim.log).not.toContain('ChangeKey 0');
  });

  // Someone else's half-set-up card is not ours to finish.
  it('writes nothing, and reserves nothing, on a zero-K0 card with someone else\'s K1–K4', async () => {
    const t = await cardWorld();
    const sim = new Ntag424Sim(UID);
    sim.keys = [new Uint8Array(16), ...[8, 7, 6, 5].map((n) => new Uint8Array(16).fill(n))];
    sim.versions = [0, 1, 1, 1, 1];
    t.use(sim);
    const { card, tagUid } = t.tap();
    await expect(addCard(card, tagUid, t.deps, opts)).rejects.toBeInstanceOf(CardFlowError);
    expect(sim.log.join(' ')).not.toMatch(/ChangeKey|ChangeFileSettings|SetConfiguration|WriteData/);
    expect(t.cardd.cards.size).toBe(0);
  });
});
