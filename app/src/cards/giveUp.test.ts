// Giving a card up without holding it: the wipe's two server calls, with no card in between.
import { describe, expect, it, vi } from 'vitest';
import type { CardInfo } from '../cardd/client';
import { CarddError } from '../cardd/error';
import { cardWorld } from '../testing/cardWorld';
import { catchUp } from './catchUp';
import { GIVE_UP_BUSY, GIVE_UP_UNREACHABLE, GiveUpError, giveUpCard } from './giveUp';

const ID = 'ab12cd34ef' + '0'.repeat(22);
const CARD = { id: ID, version: 1, name: 'Daily' };

async function world(state: CardInfo['state'], o: { sat?: number; needsCheck?: boolean } = {}) {
  const t = await cardWorld();
  t.cardd.cards.set(ID, { id: ID, version: 1, state, counter: 3, name: 'Daily', created: 0, updated: 0, ...(o.needsCheck && { needsCheck: true }) });
  if (o.sat) t.cardd.balances.set(ID, o.sat * 1000);
  return t;
}

const reason = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('giveUpCard', () => {
  it("moves the card's money to Pool and resets it", async () => {
    const t = await world('active', { sat: 5000 });
    expect(await giveUpCard(t.deps, CARD)).toEqual({ finished: true });
    expect(t.cardd.cards.get(ID)?.state).toBe('reset');
    expect(t.cardd.balances.get(ID) ?? 0).toBe(0);
    expect(t.cardd.balances.get('pool')).toBe(5_000_000);
    expect((await t.cache.cards())[ID]).toEqual({ id: ID, version: 1, name: 'Daily', state: 'reset' });
  });

  it('works for a frozen card and for one that needs its check after a restore', async () => {
    for (const t of [await world('frozen'), await world('active', { needsCheck: true })]) {
      await giveUpCard(t.deps, CARD);
      expect(t.cardd.cards.get(ID)?.state).toBe('reset');
    }
  });

  it("saves nothing and moves nothing when the start can't reach the server", async () => {
    const t = await world('active', { sat: 5000 });
    const before = (await t.cache.cards())[ID];
    t.w.carddDown = true;
    const e = await reason(giveUpCard(t.deps, CARD));
    expect(e).toBeInstanceOf(GiveUpError);
    expect((e as GiveUpError).why).toBe('unreachable');
    expect((e as GiveUpError).message).toBe(GIVE_UP_UNREACHABLE);
    expect(t.cardd.cards.get(ID)?.state).toBe('active');
    expect(t.cardd.balances.get(ID)).toBe(5_000_000);
    expect((await t.cache.cards())[ID]).toEqual(before);
  });

  // The start reached the server but its answer was lost: the money has moved, so the words can't say nothing did,
  // and pressing again finishes it (the start can be repeated), the money moving once.
  it('says the card may not be removed yet when the answer to the start is lost, and a second try finishes it', async () => {
    const t = await world('active', { sat: 5000 });
    const real = t.deps.cardd.wipeCard.bind(t.deps.cardd);
    vi.spyOn(t.deps.cardd, 'wipeCard').mockImplementationOnce(async (id: string) => {
      await real(id);
      throw new TypeError('fetch failed: no answer');
    });
    const e = await reason(giveUpCard(t.deps, CARD));
    expect((e as GiveUpError).message).toBe("Can't reach your server, so the card may not be removed yet. Try again when it answers.");
    expect(t.cardd.cards.get(ID)?.state).toBe('wiping');
    expect(await giveUpCard(t.deps, CARD)).toEqual({ finished: true });
    expect(t.cardd.cards.get(ID)?.state).toBe('reset');
    expect(t.cardd.balances.get('pool')).toBe(5_000_000);
  });

  it('changes nothing while a payment is in progress', async () => {
    const t = await world('active', { sat: 5000 });
    t.cardd.held.set(ID, 1_000_000);
    const e = await reason(giveUpCard(t.deps, CARD));
    expect((e as GiveUpError).why).toBe('busy');
    expect((e as GiveUpError).message).toBe(GIVE_UP_BUSY);
    expect(t.cardd.cards.get(ID)?.state).toBe('active');
    expect(t.cardd.balances.get(ID)).toBe(5_000_000);
  });

  it('counts a card another phone already gave up as done', async () => {
    const t = await world('reset');
    expect(await giveUpCard(t.deps, CARD)).toEqual({ finished: true });
    expect((await t.cache.cards())[ID]?.state).toBe('reset');
  });

  it('counts a card the server no longer lists after a refused start as done', async () => {
    const t = await world('active');
    vi.spyOn(t.deps.cardd, 'wipeCard').mockImplementationOnce(async () => {
      t.cardd.cards.delete(ID);
      throw new CarddError(409, 'conflict', 'not wipeable');
    });
    expect(await giveUpCard(t.deps, CARD)).toEqual({ finished: true });
    expect((await t.cache.cards())[ID]?.state).toBe('reset');
  });

  it("says the server can't be reached when its list can't be read after a refused start", async () => {
    const t = await world('active', { sat: 5000 });
    t.cardd.held.set(ID, 1_000_000);
    vi.spyOn(t.deps.cardd, 'cards').mockRejectedValueOnce(new TypeError('fetch failed: no answer'));
    const e = await reason(giveUpCard(t.deps, CARD));
    expect((e as GiveUpError).why).toBe('unreachable');
    expect(t.cardd.cards.get(ID)?.state).toBe('active');
  });

  it("leaves the finish to the catch-up when it can't reach the server", async () => {
    const t = await world('active', { sat: 5000 });
    vi.spyOn(t.deps.cardd, 'wipedCard').mockRejectedValueOnce(new TypeError('fetch failed: no answer'));
    expect(await giveUpCard(t.deps, CARD)).toEqual({ finished: false });
    expect(t.cardd.cards.get(ID)?.state).toBe('wiping');
    expect(t.cardd.balances.get('pool')).toBe(5_000_000);
    expect((await t.cache.cards())[ID]).toMatchObject({ state: 'reset', pending: 'wiped' });
    await catchUp(t.deps);
    expect(t.cardd.cards.get(ID)?.state).toBe('reset');
    expect((await t.cache.cards())[ID]?.pending).toBeUndefined();
  });

  it('keeps the finish pending when the server refuses it for another reason', async () => {
    const t = await world('active');
    vi.spyOn(t.deps.cardd, 'wipedCard').mockRejectedValueOnce(new Error('HTTP 502'));
    await expect(giveUpCard(t.deps, CARD)).rejects.toThrow('HTTP 502');
    expect((await t.cache.cards())[ID]).toMatchObject({ state: 'reset', pending: 'wiped' });
  });
});
