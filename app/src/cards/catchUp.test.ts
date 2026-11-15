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
});
