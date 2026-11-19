import { describe, expect, it } from 'vitest';
import { CarddError } from '../cardd/client';
import { phoneCardWorld } from '../testing/phoneCardWorld';
import { COUNTER_MAX, firstCounter, phonesCards } from './id';
import { keepPhoneCard, phoneCardKeeper } from './keep';
import type { PhoneCardRecord } from './record';

async function setup(o: Parameters<typeof phoneCardWorld>[0] = {}) {
  const t = await phoneCardWorld(o);
  /** A run as the wallet makes one: with the server's own list, asked for afresh. */
  const run = async () => {
    const cards = await t.list();
    t.s.calls.length = 0;
    return keepPhoneCard(t.d, cards);
  };
  return { ...t, run };
}
const NOTHING = { removed: [], registered: false };

// Keeping the phone's card in step with the server.
describe("step 1: another phone's card", () => {
  it('is removed with no record, as on an iPhone or a phone never set up: its balance to pool, noted with its name; a wiped one and a plastic one are left', async () => {
    const t = await setup();
    t.put(0, 'reset');
    t.put(1, 'active');
    t.put(2, 'frozen');
    t.put(3, 'programming');
    t.cardd.balances.set(t.id(1), 6_000_000);
    const kept = await t.run();
    expect(kept).toEqual({ removed: [{ name: 'Phone 1', amountMsat: 6_000_000 }, { name: 'Phone 2', amountMsat: 0 }, { name: 'Phone 3', amountMsat: 0 }], registered: false });
    expect(t.s.noted).toEqual(kept.removed);
    expect(t.states()).toEqual({ n0: 'reset', n1: 'reset', n2: 'reset', n3: 'reset' });
    expect(t.cardd.balances.get(t.id(1))).toBe(0);
    expect(t.cardd.balances.get('pool')).toBe(6_000_000);
    // The plastic card, and its money, are as they were; nothing was registered and there is still no record.
    expect(t.cardd.cards.get(t.plasticId)).toMatchObject({ state: 'active' });
    expect(t.cardd.balances.get(t.plasticId)).toBe(7_000_000);
    expect(await t.stored()).toBeNull();
    expect(t.s.calls).toEqual(['wallet', 'wipeCard', 'wipedCard', 'wipeCard', 'wipedCard', 'wipeCard', 'wipedCard']);
  });

  it("is removed where this phone has a card of its own, which is left", async () => {
    const t = await setup({ record: { n: 1, version: 0, next: 101 } });
    t.put(0, 'active');
    t.put(1, 'active');
    expect(await t.run()).toEqual({ removed: [{ name: 'Phone 0', amountMsat: 0 }], registered: false });
    expect(t.states()).toEqual({ n0: 'reset', n1: 'active' });
    expect(await t.stored()).toEqual({ n: 1, version: 0, next: 101 });
  });

  it('has a wipe that was cut off finished, and is not noted a second time', async () => {
    const t = await setup();
    t.put(0, 'wiping');
    expect(await t.run()).toEqual(NOTHING);
    expect(t.states()).toEqual({ n0: 'reset' });
    expect(t.s.noted).toEqual([]);
    expect(t.s.calls).toEqual(['wipeCard', 'wipedCard']);
  });

  // A security check of this job called it able to fail open: each test below is a way one card's
  // trouble once left other cards, or the same card, able to pay.
  it('is frozen while a payment holds some of its balance, and wiped by a later run; the cards after it, and this phone\'s own, are still seen to', async () => {
    const t = await setup({ record: { n: 2, version: 0, next: 50 } });
    t.put(0, 'active');
    t.put(1, 'active');
    t.put(2, 'active', { counter: 80 });
    t.cardd.balances.set(t.id(0), 3_000);
    t.cardd.held.set(t.id(0), 1_000);
    expect(await t.run()).toEqual({ removed: [{ name: 'Phone 1', amountMsat: 0 }], registered: false, stopped: 'busy' });
    expect(t.states()).toEqual({ n0: 'frozen', n1: 'reset', n2: 'active' });
    expect((await t.stored() as PhoneCardRecord).next).toBe(81);
    expect(t.s.calls).toEqual(['wallet', 'wipeCard', 'freezeCard', 'wipeCard', 'wipedCard']);
    // Still held: it stays frozen, and is not frozen again.
    expect((await t.run()).stopped).toBe('busy');
    expect(t.s.calls).toEqual(['wallet', 'wipeCard']);
    t.cardd.held.delete(t.id(0));
    expect(await t.run()).toEqual({ removed: [{ name: 'Phone 0', amountMsat: 3_000 }], registered: false });
    expect(t.states()).toEqual({ n0: 'reset', n1: 'reset', n2: 'active' });
  });

  it("is removed though the server won't give the balances, and noted without an amount", async () => {
    const t = await setup();
    t.put(0, 'active');
    t.cardd.balances.set(t.id(0), 3_000);
    t.s.refuse.set('wallet', new CarddError(502, 'phoenixd', 'phoenixd: no answer'));
    expect(await t.run()).toEqual({ removed: [{ name: 'Phone 0', amountMsat: null }], registered: false });
    expect(t.states()).toEqual({ n0: 'reset' });
    expect(t.cardd.balances.get('pool')).toBe(3_000);
  });

  it('is removed past a gap in the numbers, which should never be there', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 101 } });
    t.put(0, 'active');
    t.put(3, 'active');
    t.put(11, 'frozen');
    expect((await t.run()).removed.map((r) => r.name)).toEqual(['Phone 3', 'Phone 11']);
    expect(t.cardd.cards.get(t.id(3))!.state).toBe('reset');
    expect(t.cardd.cards.get(t.id(11))!.state).toBe('reset');
    expect(t.cardd.cards.get(t.id(0))!.state).toBe('active');
  });

  it("goes on to the other cards when the server refuses one, and then lets the refusal be known", async () => {
    const t = await setup();
    t.put(0, 'active');
    t.put(1, 'active');
    t.s.refuse.set(`wipedCard:${t.id(0)}`, new CarddError(500, 'internal', 'store: disk full'));
    await expect(t.run()).rejects.toMatchObject({ code: 'internal' });
    // The refused one can no longer pay either: its wipe began. The other is gone.
    expect(t.states()).toEqual({ n0: 'wiping', n1: 'reset' });
  });
});

describe("step 2: this phone's card, missing from the server's list", () => {
  it('is registered again at the lowest free number, which is 0 on a server rebuilt from the phrase alone, whatever the record said', async () => {
    const t = await setup({ record: { n: 1, version: 0, next: 9 } });
    const kept = await t.run();
    expect(kept).toEqual({ removed: [], registered: true });
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: t.floor + 1 });
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ state: 'active', version: 0, counter: t.floor, name: 'Pixel 8 Pro', host: t.cardd.host });
    expect(t.cardd.cards.has(t.id(1))).toBe(false);
    expect(t.s.calls).toEqual(['reserveCard', 'confirmCard']);
    // A phone that comes later finds it by number.
    expect(phonesCards(t.deps.issuer, await t.deps.cardd.cards()).map((p) => p.n)).toEqual([0]);
  });

  it('takes 2 where the server lists 0 and 1, on a server restored from a snapshot older than the card', async () => {
    const t = await setup({ record: { n: 2, version: 0, next: 9 } });
    t.put(0, 'reset');
    t.put(1, 'reset');
    expect(await t.run()).toEqual({ removed: [], registered: true });
    expect((await t.stored() as PhoneCardRecord).n).toBe(2);
    expect(t.states()).toEqual({ n0: 'reset', n1: 'reset', n2: 'active' });
  });

  it("begins at the record's next when that is past the clock, so no counter that left the phone is used again", async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 9_000_000 } });
    await t.run();
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ state: 'active', counter: 9_000_000 });
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 9_000_001 });
  });

  it("never writes the record's next lower: counters a pay screen reserved while this run removed another phone's card are kept", async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 9_000_000 } });
    t.put(1, 'active');
    // The pay screen's arming, in the middle of step 1: sixteen counters reserved, and some handed to a till.
    t.d.noteRemoved = async () => void (await t.record.update((r) => r && { ...r, next: r.next + 16 }));
    expect((await t.run()).registered).toBe(true);
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ state: 'active', counter: 9_000_016 });
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 9_000_017 });
  });

  it('keeps the name the phone remembers for the card', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 9 } });
    t.s.names.set(t.id(0), 'My phone');
    await t.run();
    expect(t.cardd.cards.get(t.id(0))!.name).toBe('My phone');
  });

  it('writes the record before the server is asked: a run cut off at the reserve or the confirm is finished by the next', async () => {
    for (const failAt of [1, 2]) {
      const t = await setup({ record: { n: 1, version: 0, next: 9 } });
      t.s.failAt = failAt;
      expect(await t.run()).toEqual({ removed: [], registered: false, stopped: 'network' });
      expect(await t.stored()).toEqual({ n: 0, version: 0, next: t.floor + 1 });
      t.s.failAt = 0;
      await t.run();
      const card = t.cardd.cards.get(t.id(0))!;
      expect(card.state).toBe('active');
      // The second run's tap is past the first's, which may have reached the server.
      expect(card.counter).toBeGreaterThanOrEqual(t.floor);
      expect((await t.stored() as PhoneCardRecord).next).toBe(card.counter + 1);
    }
  });

  it("refuses when the counter is used up, by a clock set years ahead, and reserves nothing", async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 9 }, nowMs: Date.UTC(2058, 0, 1) });
    expect(await t.run()).toEqual({ removed: [], registered: false, stopped: 'counter' });
    expect(t.cardd.cards.has(t.id(0))).toBe(false);
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 9 });
    expect(firstCounter(undefined, Date.UTC(2058, 0, 1))).toBeGreaterThan(COUNTER_MAX);
  });
});

describe("step 3: this phone's card, set up but not confirmed", () => {
  it("is confirmed with a tap at the record's next, the record written one higher first, at the server's key version", async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 400_001 } });
    t.put(0, 'programming', { counter: -1, version: 2 });
    expect(await t.run()).toEqual({ removed: [], registered: true });
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ state: 'active', counter: 400_001, version: 2 });
    expect(await t.stored()).toEqual({ n: 0, version: 2, next: 400_002 });
    expect(t.s.calls).toEqual(['confirmCard']);
  });

  it("never writes the record's next lower: counters a pay screen reserved while this run removed another phone's card are kept, and the confirm's tap is past them", async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 400_001 } });
    t.put(0, 'programming', { counter: -1 });
    t.put(1, 'active');
    // The pay screen's arming, in the middle of step 1: sixteen counters reserved, and some handed to a till.
    t.d.noteRemoved = async () => void (await t.record.update((r) => r && { ...r, next: r.next + 16 }));
    expect((await t.run()).registered).toBe(true);
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ state: 'active', counter: 400_017 });
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 400_018 });
  });

  it('is confirmed by the run after one the network cut', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 400_001 } });
    t.put(0, 'programming', { counter: -1 });
    t.s.failAt = 1;
    expect((await t.run()).stopped).toBe('network');
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 400_002 });
    t.s.failAt = 0;
    await t.run();
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ state: 'active', counter: 400_002 });
  });
});

describe("step 4: this phone's card, part-way through being removed", () => {
  it('has the wipe finished and the record deleted, when the record says removing or the server says wiping', async () => {
    for (const [record, state] of [[{ n: 0, version: 0, next: 9, removing: true }, 'active'], [{ n: 0, version: 0, next: 9 }, 'wiping'], [{ n: 0, version: 0, next: 9, removing: true }, 'frozen']] as const) {
      const t = await setup({ record });
      t.put(0, state);
      t.cardd.balances.set(t.id(0), 2_000);
      expect(await t.run()).toEqual(NOTHING);
      expect(t.states()).toEqual({ n0: 'reset' });
      expect(t.cardd.balances.get('pool')).toBe(2_000);
      expect(await t.stored()).toBeNull();
      // The person removed it themselves: no notice.
      expect(t.s.noted).toEqual([]);
    }
  });

  it('only deletes the record when the server has it wiped already, or never heard of it', async () => {
    const wiped = await setup({ record: { n: 0, version: 0, next: 9 } });
    wiped.put(0, 'reset');
    expect(await wiped.run()).toEqual(NOTHING);
    expect(wiped.s.calls).toEqual([]);
    expect(await wiped.stored()).toBeNull();
    const forgotten = await setup({ record: { n: 0, version: 0, next: 9, removing: true } });
    expect(await forgotten.run()).toEqual(NOTHING);
    expect(forgotten.s.calls).toEqual([]);
    expect(await forgotten.stored()).toBeNull();
  });

  it('keeps the record while a payment holds some of the balance, and finishes at the next run', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 9, removing: true } });
    t.put(0, 'active');
    t.cardd.held.set(t.id(0), 500);
    expect((await t.run()).stopped).toBe('busy');
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 9, removing: true });
    t.cardd.held.delete(t.id(0));
    await t.run();
    expect(await t.stored()).toBeNull();
  });
});

describe("steps 5 and 6: this phone's card, where the server and the phone differ", () => {
  it('is set to the host the wallet is paired with after a rebuild, without a hold', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 200 } });
    t.put(0, 'active', { host: 'vm-9.lnvps.cloud' });
    expect(await t.run()).toEqual(NOTHING);
    expect(t.cardd.cards.get(t.id(0))!.host).toBe(t.cardd.host);
    expect(t.s.calls).toEqual(['setCardHost']);
  });

  it("has its next moved past the server's counter when it is at or below it, and is never lowered", async () => {
    for (const [next, counter, want] of [[100, 100, 101], [50, 100, 101], [101, 100, 101], [5_000, 100, 5_000]]) {
      const t = await setup({ record: { n: 0, version: 0, next } });
      t.put(0, 'frozen', { counter });
      expect(await t.run()).toEqual(NOTHING);
      expect((await t.stored() as PhoneCardRecord).next).toBe(want);
      expect(t.s.calls).toEqual([]);
    }
  });

  // A server restored from a backup has the counter the backup had, behind the taps this phone has handed out
  // since, and won't let the card pay until it is checked: a tap past them all, the record written one higher first.
  it('is checked after a restore with a tap at the record\'s next, which the server takes as its counter', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 400_001 } });
    t.put(0, 'active', { counter: 300_000, needsCheck: true });
    expect(await t.run()).toEqual(NOTHING);
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ state: 'active', counter: 400_001 });
    expect(t.cardd.cards.get(t.id(0))!.needsCheck).toBeUndefined();
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 400_002 });
    expect(t.s.calls).toEqual(['checkCard']);
    // proved: the phone's own card, made here; no recorded tap is in it.
    const check = t.cardd.http.requests.find((r) => r.url.endsWith('/cards/check'))!;
    expect(JSON.parse(check.body!)).toMatchObject({ proved: true });
    // Checked once: the next run has nothing to do.
    await t.run();
    expect(t.s.calls).toEqual([]);
  });

  it('is checked past the server\'s counter when the record is behind it, frozen too', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 50 } });
    t.put(0, 'frozen', { counter: 100, needsCheck: true });
    await t.run();
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ state: 'frozen', counter: 101 });
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 102 });
  });

  it('is checked by the run after one the network cut, past the tap that may have reached the server', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 400_001 } });
    t.put(0, 'active', { counter: 300_000, needsCheck: true });
    t.s.failAt = 1;
    expect((await t.run()).stopped).toBe('network');
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 400_002 });
    t.s.failAt = 0;
    await t.run();
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ counter: 400_002 });
    expect(t.cardd.cards.get(t.id(0))!.needsCheck).toBeUndefined();
  });

  // The server refusing the check (a key version it doesn't know, say) is let be known, as any refusal is: the card
  // stays unable to pay, the tap's counter is never used again, and the next run tries once more past it.
  it('lets a refused check be known, keeping the counter it used, and tries again at the next run', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 400_001 } });
    t.put(0, 'active', { counter: 300_000, needsCheck: true });
    const refusal = new CarddError(422, 'bad_mac', 'sun: bad MAC');
    t.s.refuse.set('checkCard', refusal);
    await expect(t.run()).rejects.toBe(refusal);
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ counter: 300_000, needsCheck: true });
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 400_002 });
    t.s.refuse.delete('checkCard');
    expect(await t.run()).toEqual(NOTHING);
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ counter: 400_002 });
    expect(t.cardd.cards.get(t.id(0))!.needsCheck).toBeUndefined();
  });

  it("takes the server's key version into the record", async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 200 } });
    t.put(0, 'active', { version: 3 });
    await t.run();
    expect(await t.stored()).toEqual({ n: 0, version: 3, next: 200 });
  });
});

describe('a run', () => {
  it('does several steps that are due at once, and a second run then does nothing', async () => {
    const t = await setup({ record: { n: 1, version: 0, next: 10 } });
    t.put(0, 'active');
    t.put(1, 'active', { host: 'vm-9.lnvps.cloud', counter: 300 });
    t.cardd.balances.set(t.id(0), 4_000);
    expect(await t.run()).toEqual({ removed: [{ name: 'Phone 0', amountMsat: 4_000 }], registered: false });
    expect(t.states()).toEqual({ n0: 'reset', n1: 'active' });
    expect(t.cardd.cards.get(t.id(1))!.host).toBe(t.cardd.host);
    expect(await t.stored()).toEqual({ n: 1, version: 0, next: 301 });
    expect(await t.run()).toEqual(NOTHING);
    expect(t.s.calls).toEqual([]);
    expect(t.s.noted).toHaveLength(1);
  });

  it('stops, doing nothing, when the record can not be read: that is not a missing record', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 10 } });
    t.put(0, 'active');
    t.put(1, 'active');
    t.s.unreadable = true;
    expect(await t.run()).toEqual({ removed: [], registered: false, stopped: 'unreadable' });
    expect(t.s.calls).toEqual([]);
    expect(t.states()).toEqual({ n0: 'active', n1: 'active' });
  });

  it('cut by the network at any call leaves the rest for the next run, which ends where an uncut run does', async () => {
    const world = async () => {
      const t = await setup({ record: { n: 2, version: 0, next: 10 } });
      t.put(0, 'active');
      t.put(1, 'frozen');
      t.put(2, 'active', { host: 'vm-9.lnvps.cloud', counter: 300 });
      t.cardd.balances.set(t.id(0), 4_000);
      return t;
    };
    const whole = await world();
    await whole.run();
    const calls = whole.s.calls.length;
    expect(calls).toBe(6);
    for (let failAt = 1; failAt <= calls; failAt++) {
      const t = await world();
      t.s.failAt = failAt;
      expect((await t.run()).stopped, `cut at call ${failAt}`).toBe('network');
      t.s.failAt = 0;
      expect((await t.run()).stopped).toBeUndefined();
      expect(t.states()).toEqual(whole.states());
      expect(await t.stored()).toEqual(await whole.stored());
      expect(t.cardd.balances.get('pool')).toBe(4_000);
      expect(t.cardd.cards.get(t.id(2))!.host).toBe(t.cardd.host);
      // Each removal is noted once, though its wipe was asked for twice when the cut came after it.
      expect(t.s.noted.map((r) => r.name).sort()).toEqual(['Phone 0', 'Phone 1']);
    }
  });

  it("lets a refusal that is not the network's or a held payment's be known", async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 10 } });
    t.put(0, 'programming', { counter: 50 });
    // The server has seen a counter past the phone's: the confirm is refused as replayed.
    await expect(t.run()).rejects.toMatchObject({ code: 'replayed' });
  });
});

describe('the keeper', () => {
  it('runs one at a time, and not while the phone is armed as a card', async () => {
    const t = await setup({ record: { n: 1, version: 0, next: 10 } });
    t.put(0, 'active');
    t.put(1, 'active');
    let armed = true;
    const keep = phoneCardKeeper({ ...t.d, armed: () => armed });
    const cards = await t.deps.cardd.cards();
    expect(await keep(cards)).toBeNull();
    expect(t.states()).toEqual({ n0: 'active', n1: 'active' });
    armed = false;
    const [first, second] = await Promise.all([keep(cards), keep(cards)]);
    expect(first).toEqual({ removed: [{ name: 'Phone 0', amountMsat: 0 }], registered: false, changed: true });
    expect(second).toBeNull();
    expect(await keep(await t.deps.cardd.cards())).toEqual({ ...NOTHING, changed: false });
  });

  it('says whether the server changed anything at its asking, so the wallet knows its list is out of date', async () => {
    // Only the host to set: nothing removed, nothing registered, and still the list has changed.
    const host = await setup({ record: { n: 0, version: 0, next: 200 } });
    host.put(0, 'active', { host: 'vm-9.lnvps.cloud' });
    expect(await phoneCardKeeper({ ...host.d, armed: () => false })(await host.list())).toEqual({ ...NOTHING, changed: true });
    // Only the record to bring up: the server was asked nothing.
    const next = await setup({ record: { n: 0, version: 0, next: 5 } });
    next.put(0, 'active');
    expect(await phoneCardKeeper({ ...next.d, armed: () => false })(await next.list())).toEqual({ ...NOTHING, changed: false });
    // A wipe the server refused changed nothing: a wallet that asked again after it would ask without end while
    // the payment is held. The freeze before it, the first time, did.
    const held = await setup();
    held.put(0, 'active');
    held.cardd.held.set(held.id(0), 5);
    const keep = phoneCardKeeper({ ...held.d, armed: () => false });
    expect(await keep(await held.list())).toEqual({ ...NOTHING, stopped: 'busy', changed: true });
    expect(held.states()).toEqual({ n0: 'frozen' });
    expect(await keep(await held.list())).toEqual({ ...NOTHING, stopped: 'busy', changed: false });
  });
});
