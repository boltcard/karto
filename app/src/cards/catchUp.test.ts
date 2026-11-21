import { describe, expect, it } from 'vitest';
import { AppStore } from '../store/store';
import { nodeSqlite } from '../testing/nodeSqlite';
import { cardWorld } from '../testing/cardWorld';
import { catchUp, rememberCards } from './catchUp';

describe('rememberCards', () => {
  it('keeps the cache in step with cardd, but never over a wipe it hasn\'t told cardd about', async () => {
    const cache = await AppStore.open(nodeSqlite());
    const a = 'a'.repeat(32);
    const b = 'b'.repeat(32);
    await cache.saveCard({ id: b, version: 0, name: 'Old', state: 'reset', pending: 'wiped' });
    await rememberCards(cache, [
      { id: a, version: 1, state: 'active', counter: 4, name: 'Daily', created: 0, updated: 0 },
      { id: b, version: 0, state: 'active', counter: 9, name: 'Old', created: 0, updated: 0 },
    ]);
    expect(await cache.cards()).toEqual({
      [a]: { id: a, version: 1, name: 'Daily', state: 'active' },
      [b]: { id: b, version: 0, name: 'Old', state: 'reset', pending: 'wiped' },
    });
  });
});

// A wipe begun while the list is being kept (a card held to the phone as the page refreshes): its pending record
// stays, read where it is written, not from a copy taken before.
describe('rememberCards beside a wipe', () => {
  it('leaves a wipe saved while the list is being kept', async () => {
    const cache = await AppStore.open(nodeSqlite());
    const a = 'a'.repeat(32);
    const b = 'b'.repeat(32);
    const wiping = { id: a, version: 1, name: 'Daily', state: 'wiping' as const, pending: 'wipe' as const };
    // The wipe of a lands between the list's save of b and its save of a.
    await Promise.all([
      rememberCards(cache, [
        { id: b, version: 1, state: 'active', counter: 2, name: 'Kids', created: 0, updated: 0 },
        { id: a, version: 1, state: 'active', counter: 4, name: 'Daily', created: 0, updated: 0 },
      ]),
      cache.saveCard(wiping),
    ]);
    expect((await cache.cards())[a]).toEqual(wiping);
    expect((await cache.cards())[b]?.state).toBe('active');
  });
});

describe('catchUp', () => {
  // A wipe this phone did offline is old news once the card was added again at a later version.
  it('drops a pending wipe for an older version than cardd now has', async () => {
    const t = await cardWorld();
    const id = 'c'.repeat(32);
    await t.cache.saveCard({ id, version: 0, name: 'Daily', state: 'reset', pending: 'wiped' });
    t.cardd.cards.set(id, { id, version: 1, state: 'active', counter: 2, name: 'Daily', created: 0, updated: 0 });
    await catchUp(t.deps);
    expect(t.cardd.cards.get(id)?.state).toBe('active');
    expect((await t.cache.cards())[id]?.pending).toBeUndefined();
  });

  // The card is reset on the phone while catchUp is telling cardd about its wipe: the newer record ('wiped') is kept,
  // not overwritten from the copy catchUp read first, and the next catchUp tells cardd the wipe is done.
  it('keeps a wipe that finished while it was telling cardd', async () => {
    const t = await cardWorld();
    const id = 'd'.repeat(32);
    await t.cache.saveCard({ id, version: 1, name: 'Daily', state: 'wiping', pending: 'wipe' });
    t.cardd.cards.set(id, { id, version: 1, state: 'active', counter: 2, name: 'Daily', created: 0, updated: 0 });
    const wiped = { id, version: 1, name: 'Daily', state: 'reset' as const, pending: 'wiped' as const };
    const wipeCard = t.deps.cardd.wipeCard.bind(t.deps.cardd);
    t.deps.cardd.wipeCard = async (cardId) => {
      const answer = await wipeCard(cardId);
      await t.cache.saveCard(wiped);
      return answer;
    };
    await catchUp(t.deps);
    expect((await t.cache.cards())[id]).toEqual(wiped);
    await catchUp(t.deps);
    expect(t.cardd.cards.get(id)?.state).toBe('reset');
    expect((await t.cache.cards())[id]).toEqual({ id, version: 1, name: 'Daily', state: 'reset' });
  });
});
