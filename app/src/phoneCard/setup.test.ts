import { describe, expect, it } from 'vitest';
import { CarddError } from '../cardd/client';
import { isNetworkFailure } from '../lightning/lightning';
import { phoneCardWorld } from '../testing/phoneCardWorld';
import { CounterSpent } from './id';
import { keepPhoneCard } from './keep';
import { RecordUnreadable, type PhoneCardRecord } from './record';
import { AlreadyACard, removePhoneCard, setUpPhoneCard } from './setup';

async function setup(o: Parameters<typeof phoneCardWorld>[0] = {}) {
  const t = await phoneCardWorld(o);
  /** The keeping-in-step job, as the wallet runs it once it has the server's list again. */
  const keep = async () => {
    t.s.failAt = 0;
    return keepPhoneCard(t.d, await t.list());
  };
  return { ...t, keep };
}

describe('setting this phone up as a card', () => {
  it("takes number 0 on a server with no phone's card, writes the record, reserves and confirms: nothing is held", async () => {
    const t = await setup();
    const card = await setUpPhoneCard(t.d, 'My phone');
    expect(card).toMatchObject({ id: t.id(0), state: 'active', version: 0, counter: t.floor, name: 'My phone' });
    expect(t.cardd.cards.get(t.id(0))).toMatchObject({ state: 'active', counter: t.floor, name: 'My phone', host: t.cardd.host });
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: t.floor + 1 });
    expect(t.s.calls).toEqual(['cards', 'reserveCard', 'confirmCard']);
    // The plastic card is as it was.
    expect(t.cardd.cards.get(t.plasticId)).toMatchObject({ state: 'active', counter: 5 });
  });

  it('takes the lowest number the server does not list, a wiped card still counting', async () => {
    const t = await setup();
    t.put(0, 'reset');
    t.put(1, 'reset');
    await setUpPhoneCard(t.d, 'My phone');
    expect((await t.stored() as PhoneCardRecord).n).toBe(2);
    expect(t.states()).toEqual({ n0: 'reset', n1: 'reset', n2: 'active' });
  });

  it('is refused on a phone that has a record, before the server is asked', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 5 } });
    await expect(setUpPhoneCard(t.d, 'My phone')).rejects.toBeInstanceOf(AlreadyACard);
    expect(t.s.calls).toEqual([]);
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 5 });
  });

  it("is refused when the record can't be read, or the counter is used up, with nothing written or reserved", async () => {
    const unreadable = await setup();
    unreadable.s.unreadable = true;
    await expect(setUpPhoneCard(unreadable.d, 'My phone')).rejects.toBeInstanceOf(RecordUnreadable);
    expect(unreadable.s.calls).toEqual([]);
    const spent = await setup({ nowMs: Date.UTC(2058, 0, 1) });
    await expect(setUpPhoneCard(spent.d, 'My phone')).rejects.toBeInstanceOf(CounterSpent);
    expect(await spent.stored()).toBeNull();
    expect(spent.states()).toEqual({});
  });

  it('writes the record before the server is asked to reserve', async () => {
    const t = await setup();
    t.s.failAt = 2;
    await expect(setUpPhoneCard(t.d, 'My phone')).rejects.toSatisfy(isNetworkFailure);
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: t.floor + 1 });
    expect(t.states()).toEqual({});
  });

  it('cut off before anything was written, leaves the phone as it was, to be set up again', async () => {
    const t = await setup();
    t.s.failAt = 1;
    await expect(setUpPhoneCard(t.d, 'My phone')).rejects.toSatisfy(isNetworkFailure);
    expect(await t.stored()).toBeNull();
    expect(await t.keep()).toEqual({ removed: [], registered: false });
    t.s.calls.length = 0;
    await setUpPhoneCard(t.d, 'My phone');
    expect(t.states()).toEqual({ n0: 'active' });
  });

  it('cut off at the reserve or the confirm, is finished by the keeping-in-step job', async () => {
    for (const failAt of [2, 3]) {
      const t = await setup();
      t.s.failAt = failAt;
      await expect(setUpPhoneCard(t.d, 'My phone')).rejects.toSatisfy(isNetworkFailure);
      expect(await t.keep()).toEqual({ removed: [], registered: true });
      const card = t.cardd.cards.get(t.id(0))!;
      expect(card.state).toBe('active');
      expect(await t.stored()).toEqual({ n: 0, version: 0, next: card.counter + 1 });
      // A set-up cut at the reserve never told the server the name: the job gives the phone's own.
      expect(card.name).toBe(failAt === 2 ? 'Pixel 8 Pro' : 'My phone');
    }
  });
});

describe("removing this phone's card", () => {
  it('marks the record, wipes the card, its balance moving to pool, and deletes the record', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 200 } });
    t.put(0, 'active');
    t.cardd.balances.set(t.id(0), 6_000_000);
    await removePhoneCard(t.d);
    expect(t.states()).toEqual({ n0: 'reset' });
    expect(t.cardd.balances.get(t.id(0))).toBe(0);
    expect(t.cardd.balances.get('pool')).toBe(6_000_000);
    expect(await t.stored()).toBeNull();
    expect(t.s.calls).toEqual(['wipeCard', 'wipedCard']);
    // The person's own removal is not another phone's: nothing is noted for the Wallet page.
    expect(t.s.noted).toEqual([]);
  });

  it('does nothing on a phone with no record', async () => {
    const t = await setup();
    t.put(0, 'active');
    await removePhoneCard(t.d);
    expect(t.s.calls).toEqual([]);
    expect(t.states()).toEqual({ n0: 'active' });
  });

  it('cut off at either call, is finished by the keeping-in-step job: the record said so first', async () => {
    for (const failAt of [1, 2]) {
      const t = await setup({ record: { n: 0, version: 0, next: 200 } });
      t.put(0, 'frozen');
      t.cardd.balances.set(t.id(0), 1_000);
      t.s.failAt = failAt;
      await expect(removePhoneCard(t.d)).rejects.toSatisfy(isNetworkFailure);
      expect(await t.stored()).toEqual({ n: 0, version: 0, next: 200, removing: true });
      expect(await t.keep()).toEqual({ removed: [], registered: false });
      expect(t.states()).toEqual({ n0: 'reset' });
      expect(t.cardd.balances.get('pool')).toBe(1_000);
      expect(await t.stored()).toBeNull();
    }
  });

  it('refused while a payment holds some of the balance, stays asked for, and is finished once the payment is over', async () => {
    const t = await setup({ record: { n: 0, version: 0, next: 200 } });
    t.put(0, 'active');
    t.cardd.held.set(t.id(0), 500);
    await expect(removePhoneCard(t.d)).rejects.toBeInstanceOf(CarddError);
    expect(t.states()).toEqual({ n0: 'active' });
    expect(await t.stored()).toEqual({ n: 0, version: 0, next: 200, removing: true });
    expect((await t.keep()).stopped).toBe('busy');
    t.cardd.held.delete(t.id(0));
    await t.keep();
    expect(t.states()).toEqual({ n0: 'reset' });
    expect(await t.stored()).toBeNull();
  });
});
